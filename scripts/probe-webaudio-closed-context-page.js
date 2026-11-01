// Test-only compatibility check; no hardware audio playback.
async function probeClosedWebAudioContext(fixtureBase64) {
  const bytes = fixtureBase64
    ? Uint8Array.from(atob(fixtureBase64), value => value.charCodeAt(0)).buffer
    : await (await fetch('aac-element.adts')).arrayBuffer();
  const cases = [];
  for (const kind of ['realtime-closed', 'offline-rendered']) {
    const context = kind === 'realtime-closed'
      ? new AudioContext({sampleRate:44100})
      : new OfflineAudioContext(2, 1, 44100);
    if (kind === 'realtime-closed') await context.close();
    else await context.startRendering();
    let timer;
    try {
      const audio = await Promise.race([
        context.decodeAudioData(bytes.slice(0)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Decode timeout')), 8000);
        }),
      ]);
      cases.push({kind, state:context.state, decoded:true, frames:audio.length,
        channels:audio.numberOfChannels, rate:audio.sampleRate});
    } catch (error) {
      cases.push({kind, state:context.state, decoded:false,
        error:{name:error.name,message:error.message}});
    } finally { clearTimeout(timer); }
  }
  return cases;
}
if (typeof module !== 'undefined') module.exports = {probeClosedWebAudioContext};
