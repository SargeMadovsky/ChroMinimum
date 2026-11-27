// Page indicators acceptance (D049) with a disposable profile and loopback
// fixtures on two hosts (127.0.0.1 and localhost share a port but not a zoom
// level): the zoom indicator follows menu, shortcut and Ctrl+wheel zoom and
// per-site levels, a click resets zoom; "Без звука" mutes the page, shows the
// mute indicator, survives navigation and a click turns sound back on. The
// audio check plays a -50 dB tone and reads Core Audio session peaks
// (audio-session-peaks.ps1, read-only); without an output device it is skipped.
// No desktop input.
// Usage: <exe> <new-output-dir>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const transient = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context|timeout/;

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let serial = 0; const pending = new Map();
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, t = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}`)); }, 15000);
    pending.set(id, {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression, userGesture = false) => {
    for (let i = 0; ; i++) {
      try {
        const r = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture});
        if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      } catch (error) { if (!transient.test(error.message) || i > 30) throw error; await delay(200); }
    }
  };
  return {call, evaluate, close: () => socket.close()};
}

// Process ids of the browser and all its children (the audio service among them).
function tree(root) {
  const rows = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], {encoding: 'utf8'})
    .trim().split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number));
  const ids = new Set([root]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, parent] of rows) if (ids.has(parent) && !ids.has(pid)) { ids.add(pid); grown = true; }
  }
  return ids;
}

function peak(root, ms = 1500) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'audio-session-peaks.ps1'), '-DurationMs', String(ms)], {encoding: 'utf8'}).trim();
  const samples = JSON.parse(out);
  if (samples === 'no-device') return null;
  const ids = tree(root);
  return Math.max(0, ...samples.filter(s => ids.has(s.pid)).map(s => s.peak));
}

async function main() {
  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
  assert(exe && output, 'Usage: <exe> <new-output-dir>');
  fs.mkdirSync(output);
  const results = {};
  const record = (name, value) => { results[name] = value; console.log(name, JSON.stringify(value)); };

  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><title>Indicators fixture</title><p style="height:3000px">Host ${req.headers.host}</p>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`, other = `http://localhost:${port}/`;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-indicators-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  env.CHROMINIMUM_LAUNCHER = path.join(output, 'launcher', 'chrominimum.exe');
  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-menu', `--url=${base}`], {env, stdio: 'ignore'});
  const state = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  const log = () => fs.existsSync(path.join(data, 'smoke.log')) ? fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/) : [];
  const count = prefix => log().filter(l => l.startsWith(prefix)).length;
  let main;
  try {
    for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
    const cdp = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const pages = async () => (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()).filter(p => p.type === 'page');
    const until = async (what, test, ms = 20000) => {
      for (let t = 0; t < ms; t += 100) { requireRunning(state); const v = await test(); if (v) return v; await delay(100); }
      throw Error(`timed out: ${what}`);
    };
    main = await connect((await until('page', async () => (await pages()).find(p => p.url === base))).webSocketDebuggerUrl);
    const ready = url => until(`${url} loaded`, async () => await main.evaluate(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`).catch(() => false));
    await ready(base);
    await main.call('Page.bringToFront');
    await delay(300);
    let n = 0;
    const menu = async command => {
      const before = count('menu_');
      await main.evaluate(`document.title=${JSON.stringify(`ChroMinimum test menu ${command}#${++n}`)}`);
      await until(`menu ${command}`, async () => count('menu_') > before, 5000);
      return log().filter(l => l.startsWith('menu_')).at(-1);
    };
    // "1/1/36/110%" -> {visible, drawn, width, text}
    const indicators = async () => {
      const line = await menu('indicators');
      const field = name => {
        const [visible, drawn, width, ...text] = line.match(new RegExp(`${name}=([^;]*)`))[1].split('/');
        return {visible: visible === '1', drawn: drawn === '1', width: Number(width), text: text.join('/')};
      };
      return {zoom: field('zoom'), mute: field('mute'), muted: /muted=true/.test(line), level: Number(line.match(/level=(-?\d+)/)[1])};
    };
    const shown = async (what, test) => until(what, async () => { const i = await indicators(); return test(i) && i; }, 5000)
      .catch(async e => { throw Error(`${e.message}: ${JSON.stringify(await indicators())}`); });
    const ratio = () => main.evaluate('devicePixelRatio');
    const r100 = await ratio();
    const near = (r, k) => Math.abs(r - r100 * k) < 0.02;

    // 1. Observer registered; nothing shown at the default zoom and with sound.
    record('observer', log().find(l => l.startsWith('zoom_observer')));
    assert.match(results.observer, /registered=true/);
    const initial = await indicators();
    record('initial', initial);
    assert(!initial.zoom.visible && !initial.mute.visible && !initial.muted && initial.level === 100);
    const items = Object.fromEntries((await menu('items')).replace(/^menu_items; /, '').split('|').map(s => s.split(':')).map(([id, e, c, ...l]) => [id, {enabled: e === '1', checked: c === '1', label: l.join(':')}]));
    record('mute_item', items['13']);
    assert.deepEqual(items['13'], {enabled: true, checked: false, label: 'Без звука'});

    // 2. Menu zoom shows the level beside the address field; a click resets it.
    await menu('run:10');
    const zoomed = await shown('menu zoom', i => i.zoom.visible && i.zoom.text === '110%');
    record('menu_zoom', zoomed);
    assert(zoomed.zoom.drawn && zoomed.zoom.width > 0, 'the zoom indicator must take space in the toolbar');
    assert.equal(await menu('press:zoom'), 'menu_pressed; press:zoom');
    record('pressed_zoom', await shown('reset by click', i => !i.zoom.visible && i.level === 100));
    await until('ratio reset', async () => near(await ratio(), 1), 5000);

    // 3. Zoom outside our menu reaches the indicator through the zoom preference.
    const key = async (key, code, keyCode) => {
      for (const type of ['rawKeyDown', 'keyUp']) await main.call('Input.dispatchKeyEvent', {type, modifiers: 2, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode});
    };
    await key('-', 'Minus', 189);
    record('ctrl_minus', await shown('Ctrl+-', i => i.zoom.visible && i.zoom.text === '90%'));
    await key('0', 'Digit0', 48);
    record('ctrl_0', await shown('Ctrl+0', i => !i.zoom.visible));
    const before = count('zoom_indicator; percent=');
    await main.call('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: -120, modifiers: 2});
    const wheel = await until('Ctrl+wheel', async () => !near(await ratio(), 1), 3000).then(() => true, () => false);
    const afterWheel = await indicators();
    record('ctrl_wheel', {zoomed: wheel, events: count('zoom_indicator; percent=') - before, indicator: afterWheel});
    // Whatever CDP's synthetic wheel does, the indicator must agree with the page.
    assert.equal(afterWheel.zoom.visible, wheel);
    if (wheel) assert.equal(afterWheel.zoom.text, `${afterWheel.level}%`);

    // 4. Zoom is per site: another host is at 100%, the first keeps its level.
    if (!wheel) await menu('run:10');
    const level = (await shown('zoomed before navigation', i => i.zoom.visible)).level;
    await main.call('Page.navigate', {url: other});
    await ready(other);
    record('other_host', await shown('other host at default', i => !i.zoom.visible && i.level === 100));
    await main.call('Page.navigate', {url: base});
    await ready(base);
    record('back_to_first', await shown('first host zoom kept', i => i.zoom.visible && i.level === level));
    await menu('run:12');
    await shown('reset from menu', i => !i.zoom.visible);

    // 5. Mute: menu check item, indicator, real silence, kept across navigation.
    const tone = `(async () => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
      g.gain.value = 0.003; o.connect(g).connect(c.destination); o.start(); await c.resume(); window.tone = c; return c.state; })()`;
    record('tone', await main.evaluate(tone, true));
    const loud = peak(child.pid);
    await menu('run:13');
    const muted = await shown('muted', i => i.muted && i.mute.visible);
    record('muted', muted);
    assert(muted.mute.drawn && muted.mute.width > 0, 'the mute indicator must take space in the toolbar');
    const mutedItems = (await menu('items')).includes('13:1:1:Без звука');
    const silent = peak(child.pid);
    record('audio_peaks', {device: loud !== null, playing: loud, muted: silent});
    assert(mutedItems, 'the menu item must be checked while muted');
    if (loud === null) console.log('audio: no default output device, silence not measured');
    else {
      assert(loud > 0.0005, `the tone must reach the audio session before mute (peak ${loud})`);
      assert(silent < loud / 10, `mute must silence the page (peak ${silent} vs ${loud})`);
    }
    await main.call('Page.navigate', {url: other});
    await ready(other);
    record('muted_after_navigation', await shown('still muted', i => i.muted && i.mute.visible));
    // Chrome unmutes on navigation by itself; the shell mutes again.
    record('reapplied', log().filter(l => l === 'audio_muted; reapplied=true').length);
    if (loud !== null) {
      await main.evaluate(tone, true);
      const after = peak(child.pid);
      record('audio_peak_after_navigation', after);
      assert(after < loud / 10, `mute must hold after navigation (peak ${after})`);
    }
    assert.equal(await menu('press:mute'), 'menu_pressed; press:mute');
    record('pressed_mute', await shown('unmuted by click', i => !i.muted && !i.mute.visible));
    await menu('run:13');
    await shown('muted again', i => i.muted);
    await menu('run:13');
    record('menu_unmute', await shown('unmuted from menu', i => !i.muted && !i.mute.visible));
  } finally {
    try { await main?.call('Page.close'); } catch {}
    main?.close();
    try { await waitForExit(state, 20000); } catch { child.kill(); }
    state.detach();
    for (const f of ['smoke.log', 'cef.log']) if (fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(data, f), path.join(output, f));
    record('shutdown', log().includes('shutdown_complete'));
    server.close();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(results, null, 2));
  }
  assert(results.shutdown, 'clean shutdown');
  console.log('indicators: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
