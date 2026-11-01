// Isolated media probe. No personal profile; optional fixtures served on loopback.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn, execFileSync} = require('node:child_process');
const http = require('node:http');
const {summarizeVideoFrames} = require('./summarize-video-frames.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Observe immediately, but never leave a rejecting promise unhandled while CDP starts.
function observeChild(child) {
  const state = {finished:false, code:null, signal:null, error:null, pid:child.pid,
    detach:() => child.unref?.()};
  state.done = new Promise(resolve => {
    child.once('error', error => {
      Object.assign(state, {finished:true, error});
      resolve();
    });
    child.once('exit', (code, signal) => {
      Object.assign(state, {finished:true, code, signal});
      resolve();
    });
  });
  return state;
}

function requireRunning(state) {
  if (state.finished) throw Error(`Diagnostic process ended before CDP was ready: ${
    state.error?.message || `exit=${state.code}; signal=${state.signal}`}; PID=${state.pid}`);
}

async function waitForExit(state, timeoutMs) {
  let timer;
  try {
    await Promise.race([state.done, new Promise((_, reject) => {
      timer = setTimeout(() => {
        // The diagnostic must be able to exit even if the observed child hangs.
        state.detach();
        reject(Error(`Diagnostic shutdown timeout after ${timeoutMs} ms; PID=${state.pid}; process not terminated`));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  if (state.error) throw state.error;
  return state.code;
}

let server;
let activeChild;
let activeSocket;
let diagnosticDirectories;
const fixtureRequests = [];

function releaseDiagnosticResources() {
  activeChild?.unref();
  try { activeSocket?.close(); } catch { /* Connecting socket may reject close. */ }
  server?.closeAllConnections();
  server?.close();
  if (diagnosticDirectories) {
    const {data, output} = diagnosticDirectories;
    if (data !== output) for (const name of ['smoke.log','cef.log'])
      if (fs.existsSync(path.join(data,name))) fs.copyFileSync(path.join(data,name),path.join(output,name));
  }
}

async function runDiagnostic(task, timeoutMs = 120000) {
  // Hard stop applies only to this disposable Node runner, never to the browser.
  // Promise.race alone cannot stop a pending socket from holding the event loop.
  const watchdog = setTimeout(() => {
    releaseDiagnosticResources();
    fs.writeSync(2, `Diagnostic overall timeout after ${timeoutMs} ms; PID=${activeChild?.pid ?? 'not started'}; browser not terminated\n`);
    process.exit(1);
  }, timeoutMs);
  try { await task(); }
  finally {
    clearTimeout(watchdog);
    releaseDiagnosticResources();
  }
}

function buildLaunchArguments(url, enablePlatformAac, extendedSmoke = false) {
  return ['--smoke-test', '--test-cdp', '--url=' + url,
    // Reuse the existing bounded 600s smoke watchdog; no codec activation.
    ...(extendedSmoke ? ['--test-chrome-downloads'] : []),
    ...(enablePlatformAac ? ['--test-platform-aac'] : [])];
}

async function main() {
  const platformAac = process.argv.includes('--platform-aac');
  const extendedSmoke = process.argv.includes('--extended-smoke');
  const requirePlatformAac = platformAac || process.argv.includes('--require-platform-aac');
  const nativeWindow = process.argv.includes('--native-window');
  const fullPlayback = requirePlatformAac || process.argv.includes('--full-playback');
  const audible = process.argv.includes('--audible');
  const frameMetrics = process.argv.includes('--frame-metrics');
  const ssdProfile = process.argv.includes('--ssd-profile');
  const visible = process.argv.includes('--visible');
  const pauseControl = process.argv.includes('--pause-control');
  const args = process.argv.slice(2).filter(arg => !['--extended-smoke', '--platform-aac', '--require-platform-aac', '--native-window', '--pause-control','--full-playback','--ssd-profile','--audible','--frame-metrics','--visible'].includes(arg));
  if (pauseControl && !requirePlatformAac) throw Error('--pause-control requires --platform-aac');
  if (args.length < 2 || args.length > 3 || (fullPlayback && args.length !== 3))
    throw Error('Usage: node diagnose-media.cjs <launcher.exe> <new-output> [fixture-directory] [--platform-aac|--require-platform-aac] [--native-window] [--full-playback] [--ssd-profile] [--audible] [--pause-control] [--frame-metrics] [--visible]');
  const [exe, output, fixtures] = args.map(p => path.resolve(p));
  let url = 'about:blank';
  const mediaFiles = ['bear-1280x720.mp4', 'bear-vp9-opus.webm'];
  if (fixtures) {
    if (fs.existsSync(path.join(fixtures, 'bear-audio-lc-aac.aac'))) mediaFiles.push('bear-audio-lc-aac.aac');
    const files = new Map(mediaFiles.map(name =>
      ['/' + name, fs.readFileSync(path.join(fixtures, name))]));
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      fixtureRequests.push({method:req.method, path:pathname});
      const data = files.get(pathname);
      if (pathname === '/') { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<!doctype html><title>Isolated media probe</title>'); }
      else if (data) {
        const mime = pathname.endsWith('.aac') ? 'audio/aac' : pathname.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
        res.writeHead(200, {'Content-Type':mime, 'Content-Length':data.length});
        res.end(data);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
  }
  fs.mkdirSync(output, {recursive: false});
  const data = ssdProfile ? fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-media-')) : output;
  diagnosticDirectories = {data, output};
  fs.writeFileSync(path.join(output,'profile-location.json'),JSON.stringify({data,disposable:true},null,2));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  const launchArguments = buildLaunchArguments(url, platformAac, extendedSmoke);
  fs.writeFileSync(path.join(output, 'launch-mode.json'), JSON.stringify({
    extendedSmoke, codecTestActivation:platformAac, requirePlatformAac, nativeWindow,
    arguments:launchArguments
  }, null, 2));
  const child = spawn(exe, launchArguments, {
    env, windowsHide: !visible, stdio: 'ignore'
  });
  activeChild = child;
  const lifecycle = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 150; i++) {
    requireRunning(lifecycle);
    await delay(100);
  }
  requireRunning(lifecycle);
  if (!fs.existsSync(portFile)) throw Error(`CDP port file timeout; PID=${child.pid}`);
  if (fixtures) {
    // Do not attach agents to the renderer while its first document commits.
    // Readiness comes from our HTTP server and the native main-frame callback,
    // independently of CDP's pending target URL / initial about:blank context.
    const started = Date.now(), deadline = started + 60000;
    const logFile = path.join(data, 'smoke.log');
    let ready = false;
    while (Date.now() < deadline) {
      requireRunning(lifecycle);
      if (fixtureRequests.some(request => request.method === 'GET' && request.path === '/') &&
          fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').split(/\r?\n/)
            .includes('main_frame_loaded; status=200')) { ready = true; break; }
      await delay(100);
    }
    fs.writeFileSync(path.join(output, 'initial-load.json'),
      JSON.stringify({ready, waitMs:Date.now()-started, requests:fixtureRequests}, null, 2));
    if (!ready) throw Error('Initial fixture load timeout before CDP attachment');
  }
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  let tabs;
  for (let i = 0; i < 50; i++) {
    requireRunning(lifecycle);
    try {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(1000)})).json();
      if (tabs.some(t => t.type === 'page')) break;
    } catch { /* CDP can publish its port before the endpoint is ready. */ }
    await delay(100);
  }
  if (!tabs?.some(t => t.type === 'page')) throw Error('Diagnostic page unavailable');
  fs.writeFileSync(path.join(output, 'initial-targets.json'), JSON.stringify(tabs, null, 2));
  const tab = tabs.find(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  activeSocket = ws;
  await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
  let id = 0;
  const pending = new Map();
  const mediaEvents = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data), pair = pending.get(m.id);
    if (m.method?.startsWith('Media.') && mediaEvents.length < 2000)
      mediaEvents.push({method:m.method, params:m.params});
    if (pair) { pending.delete(m.id); m.error ? pair[1](Error(JSON.stringify(m.error))) : pair[0](m.result); }
  };
  ws.onclose = () => {
    for (const pair of pending.values()) pair[1](Error('Diagnostic socket closed'));
    pending.clear();
  };
  const call = (method, params = {}, timeout = 12000) => new Promise((resolve, reject) => {
    const serial = ++id;
    const timer = setTimeout(() => { pending.delete(serial); reject(Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(serial, [value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);}]);
    ws.send(JSON.stringify({id:serial, method, params}));
  });
  try {
    if (visible) {
      // CEF Views owns its outer window; do not activate an internal Chrome tab.
      if (!nativeWindow) await call('Page.bringToFront');
      let state;
      const visibilityStarted = Date.now(), visibilitySamples = [];
      for(let i=0;i<(extendedSmoke ? 600 : 50);i++){
        const observed=await call('Runtime.evaluate',{returnByValue:true,expression:'({visibility:document.visibilityState,focused:document.hasFocus()})'});
        state=observed.result.value;
        visibilitySamples.push({waitMs:Date.now()-visibilityStarted,...state});
        if(state?.visibility==='visible')break;
        await delay(100);
      }
      fs.writeFileSync(path.join(output,'visibility.json'),JSON.stringify(state,null,2));
      fs.writeFileSync(path.join(output,'visibility-samples.json'),JSON.stringify(visibilitySamples,null,2));
      if(state?.visibility!=='visible')throw Error('Visible media probe remained hidden');
    }
    await call('Media.enable');
    const result = await call('Runtime.evaluate', {returnByValue: true, expression: `(() => {
      const types = {
        h264: 'video/mp4; codecs="avc1.42E01E"',
        aac: 'audio/mp4; codecs="mp4a.40.2"',
        h264_aac: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        vp9: 'video/webm; codecs="vp9"',
        av1: 'video/mp4; codecs="av01.0.04M.08"',
        opus: 'audio/webm; codecs="opus"'
      };
      return {userAgent: navigator.userAgent, codecs: Object.fromEntries(Object.entries(types).map(([name, mime]) =>
        [name, {mime, canPlayType: document.createElement('video').canPlayType(mime),
          mediaSource: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)}]))};
    })()`});
    if (result.exceptionDetails || !result.result.value) throw Error('Capability evaluation failed');
    fs.writeFileSync(path.join(output, 'capabilities.json'), JSON.stringify(result.result.value, null, 2));
    console.log(JSON.stringify(result.result.value, null, 2));
    if (fixtures) {
      // The launcher already navigates to the isolated fixture URL. Wait for
      // that document rather than racing it with a second initial navigation.
      const playbackUrl = url;
      await call('Page.enable');
      let loaded = false;
      for (let i = 0; i < 100; i++) {
        const ready = await call('Runtime.evaluate', {returnByValue:true,
          expression:`location.href === ${JSON.stringify(playbackUrl)} && document.readyState === 'complete'`});
        if (ready.result.value === true) { loaded = true; break; }
        await delay(100);
      }
      if (!loaded) {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(1000)})).json();
        fs.writeFileSync(path.join(output, 'failed-targets.json'), JSON.stringify(targets, null, 2));
        const documentState = await call('Runtime.evaluate', {returnByValue:true,
          expression:'({href:location.href,readyState:document.readyState})'});
        fs.writeFileSync(path.join(output, 'fixture-requests.json'), JSON.stringify(fixtureRequests, null, 2));
        throw Error('Fixture document did not finish loading: ' + JSON.stringify(documentState.result.value));
      }
      // CEF Views owns its outer window; do not activate an internal Chrome tab.
      if (!nativeWindow) await call('Page.bringToFront');
      const playback = [];
      for (const file of mediaFiles) {
        const start = await call('Runtime.evaluate', {returnByValue:true, userGesture:true, expression:`(() => {
          const file = ${JSON.stringify(file)}, audioOnly = file.endsWith('.aac');
          const probe = {file, audioOnly, video:null, playError:null,
            events:[], cleanup:null,
            audioError:null, decodedAudioFrames:0, audioChannels:null, audioSampleRate:null, audioPeak:null};
          globalThis.cmMediaProbe = probe;
          if (audioOnly) {
            const context = new OfflineAudioContext(2, 1, 44100);
            fetch(file).then(response => {
              if (!response.ok) throw Error('Fixture HTTP ' + response.status);
              return response.arrayBuffer();
            }).then(bytes => context.decodeAudioData(bytes)).then(buffer => {
              let peak = 0;
              for (const sample of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
              probe.audioChannels = buffer.numberOfChannels;
              probe.audioSampleRate = buffer.sampleRate;
              probe.audioPeak = peak;
              probe.decodedAudioFrames = buffer.length;
            }).catch(error => {probe.audioError = {name:error.name, message:error.message};});
          } else {
            const video = document.createElement('video');
            video.muted = ${!audible}; video.preload = 'auto'; video.controls = true;
            video.width = 320; video.height = 180; document.body.append(video);
            probe.video = video;
            const controller = new AbortController();
            probe.cleanup = () => controller.abort();
            if (${frameMetrics}) {
              const m=probe.frameMetrics={supported:typeof video.requestVideoFrameCallback==='function',samples:[],truncated:false,firstQuality:null,lastQuality:null};
              video.addEventListener('playing',()=>{m.firstQuality ??= video.getVideoPlaybackQuality();},{signal:controller.signal});
              if(m.supported) {
                let callback;
                const tick=(now,metadata)=>{
                  if(m.samples.length<10000)m.samples.push({now,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,visibility:document.visibilityState,focused:document.hasFocus()});
                  else m.truncated=true;
                  callback=video.requestVideoFrameCallback(tick);
                };
                callback=video.requestVideoFrameCallback(tick);
                controller.signal.addEventListener('abort',()=>video.cancelVideoFrameCallback(callback),{once:true});
              }
            }
            const record = (type, detail = {}) => {
              if (probe.events.length < 128) probe.events.push({type, at:performance.now(),
                currentTime:video.currentTime, paused:video.paused, ended:video.ended,
                readyState:video.readyState, visibility:document.visibilityState,
                focused:document.hasFocus(), ...detail});
            };
            for (const type of ['play','playing','pause','waiting','stalled','ended','error','seeking','seeked'])
              video.addEventListener(type, event => record(type, {trusted:event.isTrusted}), {signal:controller.signal});
            document.addEventListener('visibilitychange', () => record('visibilitychange'), {signal:controller.signal});
            for (const type of ['focus','blur']) window.addEventListener(type, () => record(type), {signal:controller.signal});
            document.addEventListener('keydown', event => {
              if (['Space','Enter','MediaPlayPause','KeyK'].includes(event.code))
                record('media-key', {code:event.code, trusted:event.isTrusted, target:event.target.tagName});
            }, {capture:true, signal:controller.signal});
            video.addEventListener('pointerdown', event => record('video-pointer', {trusted:event.isTrusted}),
              {capture:true, signal:controller.signal});
            video.src = file;
            video.load();
            video.play().catch(error => {probe.playError = error.name;});
            if (${pauseControl} && file.endsWith('.mp4')) {
              const timer = setTimeout(() => {record('test-pause-request'); video.pause();}, 800);
              controller.signal.addEventListener('abort', () => clearTimeout(timer), {once:true});
            }
          }
          return true;
        })()`});
        if (start.exceptionDetails) throw Error('Cannot create media probe');
        let observation;
        const deadline = Date.now() + (fullPlayback ? 15000 : 5000);
        do {
          await delay(200);
          const state = await call('Runtime.evaluate', {returnByValue:true, expression:`(() => {
            const p = globalThis.cmMediaProbe, v = p.video;
            if (p.audioOnly) return {file:p.file, status:p.audioError ? 'error' : p.decodedAudioFrames > 0 ? 'decoded' : 'pending',
              decodedAudioFrames:p.decodedAudioFrames, audioChannels:p.audioChannels,
              audioSampleRate:p.audioSampleRate, audioPeak:p.audioPeak, error:p.audioError};
            const frames = v.getVideoPlaybackQuality().totalVideoFrames;
            if(p.frameMetrics) {
              const q=v.getVideoPlaybackQuality();
              p.frameMetrics.lastQuality={totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames};
              const first=p.frameMetrics.firstQuality;
              if(first)p.frameMetrics.firstQuality={totalVideoFrames:first.totalVideoFrames,droppedVideoFrames:first.droppedVideoFrames};
            }
            return {file:p.file, currentTime:v.currentTime, readyState:v.readyState,
              frameMetrics:p.frameMetrics,
              ended:v.ended, duration:v.duration,
              paused:v.paused, muted:v.muted, volume:v.volume,
              visibility:document.visibilityState, focused:document.hasFocus(),
              events:p.events,
              networkState:v.networkState, currentSrc:v.currentSrc,
              error:v.error ? {code:v.error.code, message:v.error.message} : null,
              decodedFrames:frames, playError:p.playError,
              status:v.error ? 'error' : p.playError ||
                (v.currentTime > 0.3 && frames > 0 &&
                  (${fullPlayback} ? v.ended : true) ? 'playing' : 'pending')};
          })()`}, 3000);
          if (state.exceptionDetails || !state.result.value) throw Error('Cannot read media probe');
          observation = state.result.value;
        } while (observation.status === 'pending' && Date.now() < deadline);
        if (observation.status === 'pending') observation.status = observation.paused ? 'paused' : 'timeout';
        playback.push(observation);
        if(frameMetrics)fs.writeFileSync(path.join(output,'frame-summary.json'),JSON.stringify(playback.filter(p=>!p.file.endsWith('.aac')).map(p=>({file:p.file,...summarizeVideoFrames(p)})),null,2));
        fs.writeFileSync(path.join(output, 'playback.json'), JSON.stringify(playback, null, 2));
        await call('Runtime.evaluate', {expression:`(() => {
          const v = globalThis.cmMediaProbe.video;
          globalThis.cmMediaProbe.cleanup?.();
          if (v) {v.pause(); v.removeAttribute('src'); v.load(); v.remove();}
          delete globalThis.cmMediaProbe;
        })()`});
      }
      fs.writeFileSync(path.join(output, 'fixture-requests.json'), JSON.stringify(fixtureRequests, null, 2));
      console.log(JSON.stringify(playback, null, 2));
      if (fullPlayback) {
        const tokens = execFileSync('pwsh.exe', ['-NoProfile', '-File',
          path.join(__dirname, 'inspect-test-process-tokens.ps1'),
          '-RootProcessId', String(child.pid), '-IncludeRoot'],
          {encoding:'utf8', windowsHide:true, timeout:15000});
        fs.writeFileSync(path.join(output, 'tokens.json'), tokens);
      }
    }
  } finally {
    fs.writeFileSync(path.join(output, 'media-events.json'), JSON.stringify(mediaEvents, null, 2));
    await call('Page.close').catch(()=>{});
    ws.close();
  }
  const code = await waitForExit(lifecycle, 45000);
  if (code !== 0 || !fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/).includes('shutdown_complete'))
    throw Error(`Unclean shutdown: ${code}`);
  console.log('shutdown_complete; exit=0');
  if (requirePlatformAac) {
    const players = new Map();
    for (const event of mediaEvents) {
      if (event.method !== 'Media.playerPropertiesChanged') continue;
      const properties = players.get(event.params.playerId) || {};
      for (const property of event.params.properties) properties[property.name] = property.value;
      players.set(event.params.playerId, properties);
    }
    const selected = [...players.values()].some(properties =>
      properties.kAudioDecoderName === 'MediaFoundationAudioDecoder' &&
      properties.kIsPlatformAudioDecoder === 'true' &&
      properties.kAudioTracks?.includes('"codec":"aac"'));
    fs.writeFileSync(path.join(output, 'platform-selection.json'),
      JSON.stringify({selected, players:[...players.values()]}, null, 2));
    if (!selected) throw Error('System AAC selection not proven: inspect media-events.json');
  }
}

module.exports = {observeChild, requireRunning, waitForExit, runDiagnostic, buildLaunchArguments};
if (require.main === module) {
  runDiagnostic(main).catch(error => { console.error(error); process.exitCode = 1; });
}
