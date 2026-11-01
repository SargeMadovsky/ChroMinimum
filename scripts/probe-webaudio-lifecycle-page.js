// Disposable-page tests. This does not measure memory leaks or audible output.
async function probeWebAudioLifecycle(fixtureBase64) {
  const bytes = Uint8Array.from(atob(fixtureBase64), c => c.charCodeAt(0)).buffer;
  const describe = audio => ({frames:audio.length, rate:audio.sampleRate,
    channels:audio.numberOfChannels,
    peak:audio.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)});
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Decode timeout')), 8000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const results = [];
  const stage = name => console.info('CM_WEBAUDIO_STAGE', name, performance.now());
  stage('start');
  const contexts = [new OfflineAudioContext(2, 1, 44100),
    new AudioContext({sampleRate:44100})];
  try {
    stage('parallel-start');
    const parallel = await bounded(Promise.all(contexts.map(async (context, index) => {
      stage("decode-start-"+index);
      const result = describe(await context.decodeAudioData(bytes.slice(0)));
      stage("decode-done-"+index);
      return result;
    })));
    stage('parallel-done');
    results.push({kind:'parallel-offline-realtime', decoded:parallel});
    const context = contexts[0];
    let error;
    stage('malformed-start');
    try {
      await bounded(context.decodeAudioData(new Uint8Array([255,255,255,255]).buffer));
      error = {name:'UnexpectedSuccess'};
    } catch (failure) { error = {name:failure.name}; }
    stage('malformed-done');
    results.push({kind:'malformed', error});
    results.push({kind:'recovery', decoded:describe(
      await bounded(context.decodeAudioData(bytes.slice(0))))});
  } finally { stage('context-close-start'); await contexts[1].close(); stage('context-close-done'); }

  const frame = document.createElement('iframe');
  frame.srcdoc = '<!doctype html><title>Disposable AAC context</title>';
  const loaded = new Promise(resolve => frame.onload = resolve);
  document.body.append(frame);
  stage('iframe-load-start');
  await bounded(loaded);
  stage('iframe-loaded');
  let settlements = 0;
  const child = new frame.contentWindow.OfflineAudioContext(2, 1, 44100);
  const pending = child.decodeAudioData(bytes.slice(0));
  pending.then(() => { settlements++; }, () => { settlements++; });
  frame.remove();
  stage('iframe-removed');
  // Removal may discard the realm's completion. Do not require settlement of
  // its promise or mistake this observation for proof of resource reclamation.
  const recovery = new OfflineAudioContext(2, 1, 44100);
  results.push({kind:'recovery-after-frame-removal', decoded:describe(
    await bounded(recovery.decodeAudioData(bytes.slice(0)))),
    removedFrameSettlements: settlements});
  stage('done');
  return results;
}
if (typeof module !== 'undefined') module.exports = {probeWebAudioLifecycle};
