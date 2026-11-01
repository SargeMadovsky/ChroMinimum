// Test-only browser function. No application code or external network.
async function probeWebCodecsAac() {
  const bytes = new Uint8Array(await (await fetch('aac-element.adts')).arrayBuffer());
  const packets = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 7 || bytes[offset] !== 255 ||
        (bytes[offset + 1] & 246) !== 240) throw Error('Invalid ADTS fixture');
    const size = ((bytes[offset + 3] & 3) << 11) |
      (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    const header = bytes[offset + 1] & 1 ? 7 : 9;
    if (size <= header || offset + size > bytes.length) throw Error('Truncated ADTS');
    packets.push(bytes.slice(offset + header, offset + size));
    offset += size;
  }
  const config = {codec:'mp4a.40.2', sampleRate:48000, numberOfChannels:2,
    description:new Uint8Array([0x11, 0x90])};
  const supported = await AudioDecoder.isConfigSupported(config);
  async function run(mode) {
    let frames = 0, peak = 0, outputs = 0, errors = 0, flushSettlements = 0;
    let rate = null, channels = null;
    const decoder = new AudioDecoder({output(data) {
      try {
        frames += data.numberOfFrames; outputs++;
        rate = data.sampleRate; channels = data.numberOfChannels;
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, {planeIndex:0, format:'f32-planar'});
        for (const value of pcm) peak = Math.max(peak, Math.abs(value));
      } finally { data.close(); }
    }, error() { errors++; }});
    decoder.configure(config);
    for (let i = 0; i < packets.length; i++) decoder.decode(new EncodedAudioChunk({
      type:'key', timestamp:Math.round(i * 1024 * 1e6 / 48000), data:packets[i]}));
    const flushed = decoder.flush().then(() => {
      flushSettlements++; return 'resolved';
    }, error => { flushSettlements++; return error.name; });
    if (mode === 'close') decoder.close();
    if (mode === 'reset') decoder.reset();
    let timer;
    let flush;
    try {
      flush = await Promise.race([flushed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Flush timeout')), 8000);
      })]);
    } finally {
      clearTimeout(timer);
      if (decoder.state !== 'closed') decoder.close();
    }
    return {mode, frames, peak, outputs, errors, flushSettlements, flush, rate, channels};
  }
  const sequential = await run('decode');
  const parallel = await Promise.all([run('decode'), run('decode')]);
  const close = await run('close');
  const reset = await run('reset');
  const iframe = document.createElement('iframe');
  iframe.src = '/';
  await new Promise((resolve, reject) => {
    iframe.onload = resolve; iframe.onerror = reject;
    document.body.append(iframe);
  });
  const child = iframe.contentWindow;
  let detachedOutputs = 0;
  const childDecoder = new child.AudioDecoder({output(data) {
    detachedOutputs++; data.close();
  }, error() {}});
  childDecoder.configure(config);
  for (let i = 0; i < packets.length; i++) childDecoder.decode(new child.EncodedAudioChunk({
    type:'key', timestamp:Math.round(i * 1024 * 1e6 / 48000), data:packets[i]}));
  // Context destruction may leave its JS promise unobservable; state and output
  // are checked from the live parent instead of waiting on a dead realm.
  childDecoder.flush().catch(() => {});
  iframe.remove();
  await new Promise(resolve => setTimeout(resolve, 200));
  const detachedFrame = {state:childDecoder.state, outputs:detachedOutputs};
  if (childDecoder.state !== 'closed') childDecoder.close();
  async function negative(kind) {
    let outputs = 0, errors = 0, settlements = 0, errorName = null;
    const decoder = new AudioDecoder({output(data) { outputs++; data.close(); },
      error(error) { errors++; errorName = error.name; }});
    let outcome, timer;
    try {
      decoder.configure(kind === 'invalid-config' ? {...config, sampleRate:0} : config);
      decoder.decode(new EncodedAudioChunk({type:'key',timestamp:0,
        data:new Uint8Array([255,255,255,255])}));
      outcome = await Promise.race([
        decoder.flush().then(() => {settlements++; return 'resolved';},
          error => {settlements++; return error.name;}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Negative case timeout')), 8000);
        })]);
    } catch (error) { outcome = error.name; }
    finally {
      clearTimeout(timer);
      if (decoder.state !== 'closed') decoder.close();
    }
    return {kind, outcome, outputs, errors, settlements, errorName};
  }
  const malformed = await negative('malformed-packet');
  const invalidConfig = await negative('invalid-config');
  const recovery = await run('decode');
  return {supported:supported.supported, packets:packets.length,
    sequential, parallel, close, reset, detachedFrame, malformed, invalidConfig, recovery};
}
if (typeof module !== 'undefined') module.exports = {probeWebCodecsAac};
