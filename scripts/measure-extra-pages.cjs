// Cost of each additional page: ChroMinimum (one page per window, D044) vs
// a Chromium browser with pages as background tabs or as separate windows.
// Samples the whole process tree (Win32_Process: PrivatePageCount = private
// bytes; CPU = kernel+user time). Disposable profiles, loopback fixtures only.
// cm-tabs: ChroMinimum with the measurement-only tab prototype (D047): pages
// opened aside become hidden BrowserViews in the opener's window.
// Usage: node measure-extra-pages.cjs <mode cm|cm-tabs|tabs|windows> <exe> <new-output-dir> [--runs N]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

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
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {call, evaluate, close: () => socket.close()};
}

function processTree(rootPid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress'],
    {encoding: 'utf8', maxBuffer: 64 << 20});
  const all = JSON.parse(r.stdout);
  const byParent = new Map();
  for (const p of all) { if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, []); byParent.get(p.ParentProcessId).push(p); }
  const out = [], root = all.find(p => p.ProcessId === rootPid);
  if (!root) return out;
  const stack = [root];
  while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(byParent.get(p.ProcessId) || [])); }
  return out.map(p => ({pid: p.ProcessId, type: (/--type=([\w-]+)/.exec(p.CommandLine || '') || [, 'browser'])[1],
    utility: (/--utility-sub-type=([\w.]+)/.exec(p.CommandLine || '') || [])[1],
    private: Number(p.PrivatePageCount), ws: Number(p.WorkingSetSize),
    cpu100ns: p.KernelModeTime == null ? null : Number(p.KernelModeTime) + Number(p.UserModeTime)}))
    .filter(p => p.type !== 'crashpad-handler');
}

const MiB = b => +(b / 2 ** 20).toFixed(1);
const kind = p => p.type === 'utility' ? (p.utility || 'utility').replace(/\.mojom\./, '.') : p.type;
function summarize(tree) {
  const by = {};
  for (const p of tree) { const k = kind(p); by[k] ??= {n: 0, private_mib: 0}; by[k].n++; by[k].private_mib = +(by[k].private_mib + MiB(p.private)).toFixed(1); }
  return {processes: tree.length, renderers: tree.filter(p => p.type === 'renderer').length,
    private_mib: MiB(tree.reduce((s, p) => s + p.private, 0)), ws_sum_mib: MiB(tree.reduce((s, p) => s + p.ws, 0)), by};
}
async function settle(rootPid, ms = 4000, samples = 3) {
  await delay(ms);
  const s = [];
  for (let i = 0; i < samples; i++) { s.push(summarize(processTree(rootPid))); await delay(700); }
  s.sort((a, b) => a.private_mib - b.private_mib);
  return s[Math.floor(s.length / 2)];
}

const pageHtml = (title, links) => `<!doctype html><title>${title}</title>
<style>a{display:block;margin:10px;font:18px sans-serif;width:360px;height:30px}</style>
<h1>${title}</h1>${links}
<p>${'Lorem ipsum dolor sit amet. '.repeat(200)}</p>`;
// rAF canvas animation plus a 50 ms timer with a little work: what a busy page
// left in the background keeps doing unless Chromium marks it hidden.
const animHtml = `<!doctype html><title>anim</title><canvas id=c width=800 height=500></canvas><script>
const c=document.getElementById('c').getContext('2d');window.frames_=0;window.ticks_=0;
setInterval(()=>{window.ticks_++;let x=0;for(let i=0;i<2e5;i++)x+=Math.sqrt(i);window.x_=x;},50);
function f(t){window.frames_++;c.fillStyle='hsl('+(t/10%360)+',70%,50%)';c.fillRect(0,0,800,500);
for(let i=0;i<300;i++){c.fillStyle='#'+(i*4099%0xffffff).toString(16).padStart(6,'0');c.fillRect((t/3+i*37)%800,(i*53)%500,20,20);}requestAnimationFrame(f);}requestAnimationFrame(f);
</script>`;

async function trial(mode, exe, output, run) {
  const servers = [];
  const listen = (host, handler) => new Promise(r => { const s = http.createServer(handler); servers.push(s); s.listen(0, host, () => r(`http://${host}:${s.address().port}`)); });
  const urls = {};
  urls.s = await listen('127.0.0.1', (req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    if (req.url === '/') return res.end(pageHtml('home', `<a id=s1 href="/a1">same-site 1</a><a id=s2 href="/a2">same-site 2</a>
      <a id=x2 href="${urls.x2}/">cross-site 2</a><a id=x3 href="${urls.x3}/">cross-site 3</a><a id=anim href="/anim">anim</a>`));
    if (req.url === '/anim') return res.end(animHtml);
    res.end(pageHtml(req.url, ''));
  });
  urls.x2 = await listen('127.0.0.2', (req, res) => { res.writeHead(200, {'Content-Type': 'text/html'}); res.end(pageHtml('site 127.0.0.2', '')); });
  urls.x3 = await listen('127.0.0.3', (req, res) => { res.writeHead(200, {'Content-Type': 'text/html'}); res.end(pageHtml('site 127.0.0.3', '')); });

  const data = fs.mkdtempSync(path.join(os.tmpdir(), `pages-${mode}-`));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  let args, portFile;
  const cm = mode.startsWith('cm');
  if (cm) {
    env.CHROMINIMUM_DATA_DIR = data;
    // --test-address-input only lifts the 30 s smoke watchdog to 600 s;
    // --test-tabs-prototype does that too.
    args = ['--smoke-test', '--test-cdp', mode === 'cm-tabs' ? '--test-tabs-prototype' : '--test-address-input', `--url=${urls.s}/`];
    portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  } else {
    args = [`--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run',
      '--no-default-browser-check', '--disable-sync', '--window-size=1000,700', '--window-position=100,100', `${urls.s}/`];
    portFile = path.join(data, 'DevToolsActivePort');
  }
  const child = spawn(exe, args, {env, stdio: 'ignore'});
  const state = observeChild(child);
  const result = {mode, run, steps: []};
  let main, browserCdp;
  try {
    for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
    await delay(300);
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(p => p.type === 'page');
    const until = async (what, test, ms = 20000) => {
      for (let t = 0; t < ms; t += 100) { requireRunning(state); const v = await test(); if (v) return v; await delay(100); }
      throw Error(`timed out: ${what}`);
    };
    const page = async url => until(`page ${url}`, async () => (await pages()).find(p => p.url === url));
    main = await connect((await page(`${urls.s}/`)).webSocketDebuggerUrl);
    browserCdp = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    await until('home ready', async () => await main.evaluate("document.readyState==='complete'&&!!document.getElementById('s1')").catch(() => false));
    await delay(500);
    const middleClick = async id => {
      await main.evaluate("if (!window.__l) { window.__l = 1; window.__downs = 0; addEventListener('mousedown', () => window.__downs++, true); } true");
      const box = await main.evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
      const ev = {x: box[0], y: box[1], button: 'middle', clickCount: 1};
      const before = await main.evaluate('window.__downs');
      for (let a = 0; a < 5; a++) {
        await main.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: ev.x, y: ev.y});
        await main.call('Input.dispatchMouseEvent', {type: 'mousePressed', ...ev});
        await main.call('Input.dispatchMouseEvent', {type: 'mouseReleased', ...ev});
        for (let t = 0; t < 10; t++) { if (await main.evaluate('window.__downs') > before) return; await delay(100); }
      }
      throw Error(`click ${id} not delivered`);
    };
    // ChroMinimum: middle click = new window behind the opener (D044).
    // Chromium: Target.createTarget in the background, as a tab or a window.
    const openAside = async (id, url) => {
      if (cm) await middleClick(id);
      else await browserCdp.call('Target.createTarget', {url, background: true, newWindow: mode === 'windows'});
      const t = await page(url);
      const c = await connect(t.webSocketDebuggerUrl);
      await until(`${url} ready`, async () => await c.evaluate("document.readyState==='complete'").catch(() => false));
      return {target: t, cdp: c};
    };
    const key = async (target, key, code, keyCode, modifiers) => {
      for (const type of ['rawKeyDown', 'keyUp']) await target.call('Input.dispatchKeyEvent', {type, modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode});
    };
    const CTRL = 2, SHIFT = 8;
    const step = async (name, extra = {}) => {
      const s = {name, ...(await settle(child.pid)), ...extra};
      result.steps.push(s); console.log(mode, run, name, JSON.stringify({p: s.processes, r: s.renderers, priv: s.private_mib, ws: s.ws_sum_mib}));
      return s;
    };
    await step('1 page');
    for (const [id, url, name] of [['s1', `${urls.s}/a1`, '2 pages (+same-site)'], ['s2', `${urls.s}/a2`, '3 pages (+same-site)'],
      ['x2', `${urls.x2}/`, '4 pages (+cross-site)'], ['x3', `${urls.x3}/`, '5 pages (+cross-site)']]) {
      const {cdp} = await openAside(id, url);
      const visibility = await cdp.evaluate('document.visibilityState');
      cdp.close();
      await step(name, {aside_visibility: visibility});
    }
    // A busy page left in the background.
    const {target: at, cdp: anim} = await openAside('anim', `${urls.s}/anim`);
    await delay(2000);
    const cpuWindow = async label => {
      const f0 = await anim.evaluate('[window.frames_, window.ticks_]');
      const t0 = processTree(child.pid), w0 = performance.now();
      await delay(5000);
      const t1 = processTree(child.pid), w1 = performance.now();
      const f1 = await anim.evaluate('[window.frames_, window.ticks_, document.visibilityState]');
      const sec = (w1 - w0) / 1000, a = Object.fromEntries(t0.map(p => [p.pid, p]));
      const by = {}; let unreadable = 0;
      for (const p of t1) if (a[p.pid]) {
        if (p.cpu100ns == null || a[p.pid].cpu100ns == null) { unreadable++; continue; }
        by[kind(p)] = (by[kind(p)] || 0) + (p.cpu100ns - a[p.pid].cpu100ns) / 1e7;
      }
      const pct = x => +(x / sec / os.cpus().length * 100).toFixed(3);
      const r = {label, visibility: f1[2], fps: +((f1[0] - f0[0]) / sec).toFixed(1), timer_hz: +((f1[1] - f0[1]) / sec).toFixed(1),
        cpu_pct_machine: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, pct(v)])),
        cpu_pct_machine_total: pct(Object.values(by).reduce((s, v) => s + v, 0)), unreadable};
      console.log(mode, run, 'cpu', JSON.stringify(r));
      return r;
    };
    const tabbed = mode === 'tabs' || mode === 'cm-tabs';
    result.cpu = [await cpuWindow(tabbed ? 'anim background tab' : 'anim window behind opener (partly covered)')];
    const winOf = async targetId => (await browserCdp.call('Browser.getWindowForTarget', {targetId}));
    try {
      if (!tabbed) {
        // Fully covered: same bounds as the opener, opener in front.
        const mainTarget = (await pages()).find(p => p.url === `${urls.s}/`);
        const mw = await winOf(mainTarget.id), aw = await winOf(at.id);
        const {left, top, width, height} = mw.bounds;
        await browserCdp.call('Browser.setWindowBounds', {windowId: aw.windowId, bounds: {left, top, width, height}});
        await main.call('Page.bringToFront');
        await delay(3000);
        result.cpu.push(await cpuWindow('anim window fully covered by opener'));
        await browserCdp.call('Browser.setWindowBounds', {windowId: aw.windowId, bounds: {windowState: 'minimized'}});
        await delay(2000);
        result.cpu.push(await cpuWindow('anim window minimized'));
        await browserCdp.call('Browser.setWindowBounds', {windowId: aw.windowId, bounds: {windowState: 'normal'}});
      }
      // Prototype tabs switch by Ctrl+Shift+Tab: home -> the last tab (anim).
      if (mode === 'cm-tabs') await key(main, 'Tab', 'Tab', 9, CTRL | SHIFT);
      else await anim.call('Page.bringToFront');
      await delay(2000);
      result.cpu.push(await cpuWindow(tabbed ? 'anim tab in front' : 'anim window in front'));
    } catch (e) { result.cpu_error = String(e.message || e); console.log(mode, run, 'cpu step failed', result.cpu_error); }
    if (mode === 'cm-tabs') {
      // Switch latency: key sent -> visibilitychange (visible) -> next frame
      // in the shown page. anim is in front; Ctrl+Tab wraps to home.
      const probe = `(()=>{window.__sw=[];document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;
        const v=performance.timeOrigin+performance.now();requestAnimationFrame(()=>window.__sw.push([v,performance.timeOrigin+performance.now()]));});return true})()`;
      await main.evaluate(probe); await anim.evaluate(probe);
      result.switches = [];
      try { for (let i = 0; i < 10; i++) {
        const [from, to, mods] = i % 2 === 0 ? [anim, main, CTRL] : [main, anim, CTRL | SHIFT];
        const n = (await to.evaluate('window.__sw.length'));
        const sent = Date.now();
        await key(from, 'Tab', 'Tab', 9, mods);
        const got = await until('switch', async () => { const sw = await to.evaluate('window.__sw'); return sw.length > n && sw.at(-1); }, 5000);
        result.switches.push({to: i % 2 === 0 ? 'home' : 'anim', visible_ms: +(got[0] - sent).toFixed(1), frame_ms: +(got[1] - sent).toFixed(1)});
        await delay(500);
      } } catch (e) { result.switch_error = String(e.message || e); }
      console.log(mode, run, 'switches', JSON.stringify(result.switches), result.switch_error || '');
    }
    anim.close();
    if (mode === 'cm-tabs' && result.switches.length) {
      // Ctrl+W closes the visible tab.
      for (let n = (await pages()).length; n > 1; n--) {
        let visible;
        for (const p of await pages()) {
          const c = await connect(p.webSocketDebuggerUrl);
          if (await c.evaluate('document.visibilityState').catch(() => '') === 'visible') { visible = c; break; }
          c.close();
        }
        assert(visible, 'no visible tab');
        await key(visible, 'w', 'KeyW', 87, CTRL);
        visible.close();
        await until(`tab closed (${n - 1} left)`, async () => (await pages()).length === n - 1, 10000);
      }
    } else {
      await main.call('Page.bringToFront').catch(() => {});
      for (const p of await pages()) if (p.url !== `${urls.s}/`) await browserCdp.call('Target.closeTarget', {targetId: p.id}).catch(() => {});
    }
    await until('others closed', async () => (await pages()).length === 1);
    await step('back to 1 page (others closed)');
    if (mode === 'cm-tabs') {
      // Does a page-side close (Target.closeTarget ~ window.close) of one
      // background tab take the whole window with it?
      const {target: extra, cdp: c} = await openAside('s1', `${urls.s}/a1`);
      c.close();
      await browserCdp.call('Target.closeTarget', {targetId: extra.id}).catch(() => {});
      await delay(3000);
      const left = state.finished ? [] : await pages().catch(() => []);
      result.close_target_keeps_window = left.some(p => p.url === `${urls.s}/`);
      console.log(mode, run, 'closeTarget keeps window', result.close_target_keeps_window, left.map(p => p.url));
    }
  } catch (e) {
    result.error = String(e.stack || e);
    console.log(mode, run, 'ERROR', e.message, JSON.stringify(summarize(processTree(child.pid))));
    throw e;
  } finally {
    if (cm) { try { await main?.call('Page.close'); } catch {} }
    else { try { await browserCdp?.call('Browser.close'); } catch {} }
    main?.close(); browserCdp?.close();
    try { await waitForExit(state, 20000); } catch { child.kill(); }
    state.detach();
    for (const s of servers) s.close();
    const log = path.join(data, 'smoke.log');
    result.clean_exit = cm ? fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('shutdown_complete') : state.code === 0;
    fs.writeFileSync(path.join(output, `${mode}-run-${run}.json`), JSON.stringify(result, null, 2));
    if (cm && fs.existsSync(log)) fs.copyFileSync(log, path.join(output, `${mode}-run-${run}-smoke.log`));
    await delay(1000);
    fs.rmSync(data, {recursive: true, force: true, maxRetries: 10, retryDelay: 300});
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--runs'), runs = ri >= 0 ? Number(args[ri + 1]) : 3;
  const [mode, exe, output] = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  assert(['cm', 'cm-tabs', 'tabs', 'windows'].includes(mode) && exe && output, 'Usage: <cm|cm-tabs|tabs|windows> <exe> <new-output-dir> [--runs N]');
  fs.mkdirSync(output, {recursive: true});
  const all = [];
  for (let r = 1; r <= runs; r++) all.push(await trial(mode, path.resolve(exe), path.resolve(output), r));
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const summary = all[0].steps.map(({name}) => {
    const ss = all.map(r => r.steps.find(s => s.name === name)).filter(Boolean);
    const types = [...new Set(ss.flatMap(s => Object.keys(s.by)))];
    return {name, processes: med(ss.map(s => s.processes)), renderers: med(ss.map(s => s.renderers)),
      private_mib: med(ss.map(s => s.private_mib)), private_range: [Math.min(...ss.map(s => s.private_mib)), Math.max(...ss.map(s => s.private_mib))],
      ws_sum_mib: med(ss.map(s => s.ws_sum_mib)),
      private_by_type_mib: Object.fromEntries(types.map(t => [t, med(ss.map(s => s.by[t]?.private_mib ?? 0))])),
      aside_visibility: ss[0].aside_visibility};
  });
  console.table(summary.map(s => ({name: s.name, p: s.processes, r: s.renderers, priv: s.private_mib, range: s.private_range.join('–'), ...Object.fromEntries(Object.entries(s.private_by_type_mib).map(([k, v]) => [k.slice(0, 14), v]))})));
  fs.writeFileSync(path.join(output, `${mode}-summary.json`), JSON.stringify({mode, exe, runs, machine: {cpus: os.cpus()[0]?.model, logical: os.cpus().length, memory_gb: +(os.totalmem() / 2 ** 30).toFixed(1), os: os.release()}, summary, cpu: all.map(r => r.cpu), switches: all.map(r => r.switches), close_target_keeps_window: all.map(r => r.close_target_keeps_window), clean_exit: all.map(r => r.clean_exit)}, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
