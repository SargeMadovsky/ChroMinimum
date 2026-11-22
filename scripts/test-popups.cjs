// Popup and "open aside" acceptance with a disposable profile and a loopback
// fixture: a clicked window.open with a size gets its own window with
// window.opener/postMessage/window.close; middle, Ctrl and Shift clicks open a
// new window; plain target=_blank and unsized window.open reuse the page;
// popups without a gesture stay blocked. Clicks are CDP input events inside
// the page, not desktop input. Usage: <exe> <new-output-dir>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let serial = 0; const pending = new Map();
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, t = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method} ${JSON.stringify(params).slice(0, 120)}`)); }, 15000);
    pending.set(id, {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression, userGesture = false) => {
    const r = await call('Runtime.evaluate', {expression, returnByValue: true, userGesture, awaitPromise: true});
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {call, evaluate, close: () => socket.close()};
}

async function main() {
  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
  assert(exe && output, 'Usage: <exe> <new-output-dir>');
  fs.mkdirSync(output);
  const results = {};
  const record = (name, value) => { results[name] = value; console.log(name, JSON.stringify(value)); };

  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    if (req.url === '/') return res.end(`<!doctype html><title>Popup fixture</title>
      <style>a,button{display:block;margin:12px;font:20px sans-serif;width:320px;height:36px}</style>
      <button id="signin" onclick="document.body.dataset.clicks=(+document.body.dataset.clicks||0)+1;window.open('/auth','auth','width=480,height=560')">Sign in</button>
      <a id="aside" href="/aside">Aside link</a>
      <a id="blank" href="/blank" target="_blank">Blank link</a>
      <button id="plain" onclick="window.open('/plain')">Unsized window.open</button>
      <script>addEventListener('message', e => { document.body.dataset.message = e.data; });</script>`);
    res.end(`<!doctype html><title>${req.url}</title>${req.url}`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-popups-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  const child = spawn(exe, ['--smoke-test', '--test-cdp', `--url=${base}/`], {env, stdio: 'ignore'});
  const state = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  const log = () => fs.existsSync(path.join(data, 'smoke.log')) ? fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/) : [];
  const count = prefix => log().filter(l => l.startsWith(prefix)).length;
  let main;
  try {
    for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(p => p.type === 'page');
    const until = async (what, test, ms = 20000) => {
      for (let t = 0; t < ms; t += 100) { requireRunning(state); const v = await test(); if (v) return v; await delay(100); }
      throw Error(`timed out: ${what}`);
    };
    const page = async url => until(`page ${url}`, async () => (await pages()).find(p => p.url === url));
    const gone = async url => until(`closed ${url}`, async () => !(await pages()).some(p => p.url === url));
    main = await connect((await page(`${base}/`)).webSocketDebuggerUrl);
    const home = async () => {
      await main.call('Page.bringToFront');
      await main.call('Page.navigate', {url: `${base}/`});
      await until('fixture ready', async () => await main.evaluate("location.pathname==='/'&&document.readyState==='complete'&&!!document.getElementById('plain')").catch(() => false));
      await delay(300);
    };
    // Input sent before the first compositor frame can be dropped: resend a
    // press the page did not see (a seen press is never repeated).
    const click = async (id, button = 'left', modifiers = 0) => {
      await main.evaluate("if (!window.__listening) { window.__listening = true; window.__downs = 0; addEventListener('mousedown', () => window.__downs++, true); } true");
      const box = await main.evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
      const event = {x: box[0], y: box[1], button, modifiers, clickCount: 1};
      const before = await main.evaluate('window.__downs');
      for (let attempt = 0; attempt < 5; attempt++) {
        await main.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: event.x, y: event.y, modifiers});
        await main.call('Input.dispatchMouseEvent', {type: 'mousePressed', ...event});
        await main.call('Input.dispatchMouseEvent', {type: 'mouseReleased', ...event});
        // A missing counter means the click already navigated this page.
        for (let t = 0; t < 10; t++) { if (await main.evaluate('window.__downs ?? 1e9').catch(() => 0) > before) return attempt; await delay(100); }
      }
      throw Error(`click ${id} not delivered: ${JSON.stringify(await main.evaluate('[document.visibilityState, document.hasFocus(), innerWidth, innerHeight, location.href]'))}`);
    };
    const closePage = async url => { const p = await connect((await page(url)).webSocketDebuggerUrl); await p.call('Page.close').catch(() => {}); p.close(); await gone(url); };
    await home();

    // 1. Sign-in popup: own window, opener kept, postMessage reaches the opener, window.close works.
    await click('signin');
    await until('click delivered', async () => await main.evaluate('document.body.dataset.clicks') === '1', 5000);
    const popupTarget = await page(`${base}/auth`);
    const popup = await connect(popupTarget.webSocketDebuggerUrl);
    await until('popup ready', async () => await popup.evaluate("document.readyState==='complete'").catch(() => false));
    const opener = await popup.evaluate('!!window.opener && window.opener.location.href');
    const size = await popup.evaluate('[innerWidth, innerHeight, outerWidth, outerHeight]');
    await popup.evaluate("window.opener.postMessage('signed-in', '*')");
    const message = await until('opener message', async () => await main.evaluate('document.body.dataset.message'));
    await popup.evaluate('window.close()').catch(() => {});
    popup.close();
    await gone(`${base}/auth`);
    await delay(500);
    record('signin_popup', {opener, message, size, openerUrl: await main.evaluate('location.href'),
      locationBar: log().includes('popup_location_bar') && !log().includes('popup_location_bar_missing'),
      locationBarReturned: log().includes('popup_location_bar_removed'), shown: log().filter(l => l.startsWith('popup_window_shown'))});
    assert.equal(opener, `${base}/`);
    assert.equal(message, 'signed-in');
    assert.equal(results.signin_popup.openerUrl, `${base}/`, 'the opener page must stay');
    assert(results.signin_popup.locationBar, 'popup must show the Chrome location bar');

    // 2. Without a gesture a sized popup is still blocked (Chrome's blocker
    // usually stops it before on_before_popup; ours is the second line).
    const opened = await main.evaluate("window.open('/auth2','x','width=400,height=400') === null");
    await delay(800);
    record('popup_without_gesture_blocked', {nullReturned: opened, pages: (await pages()).length,
      shellBlocked: count('popup_blocked_without_gesture')});
    assert(opened && (await pages()).length === 1, 'a popup without a gesture must stay blocked');

    // 3. Middle click, Ctrl+click on target=_blank and Shift+click open a new window; this page stays.
    for (const [name, id, button, modifiers, background, url] of [
      ['middle_click', 'aside', 'middle', 0, true, '/aside'],
      ['ctrl_click_blank', 'blank', 'left', 2, true, '/blank'],
      ['shift_click', 'aside', 'left', 8, false, '/aside'],
    ]) {
      const requested = count(`aside_window_requested; background=${background}`), behind = count('aside_window_behind_opener');
      await click(id, button, modifiers);
      await page(`${base}${url}`);
      await delay(500);
      record(name, {pages: (await pages()).map(p => p.url), behind: count('aside_window_behind_opener') - behind});
      assert.equal(await main.evaluate('location.href'), `${base}/`, `${name}: the current page must stay`);
      assert.equal(count(`aside_window_requested; background=${background}`), requested + 1);
      assert.equal(count('aside_window_behind_opener') - behind, background ? 1 : 0);
      await closePage(`${base}${url}`);
    }

    // 4. Plain target=_blank and an unsized window.open still reuse the page (D036).
    for (const [id, url] of [['blank', '/blank'], ['plain', '/plain']]) {
      await home();
      await click(id);
      await until(`${id} in place`, async () => await main.evaluate(`location.pathname==='${url}'`).catch(() => false));
      assert.equal((await pages()).length, 1, `${id} must not open a window`);
      record(`${id}_same_page`, true);
    }
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
  console.log('popups: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
