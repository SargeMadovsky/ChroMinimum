// Main menu acceptance with a disposable profile and a loopback fixture: the
// real menu model and its delegate (without showing the native menu) for zoom,
// find, print and chrome:// pages; Chrome zoom shortcuts via CDP key events
// that the page leaves unhandled; "Settings" opens the separate settings
// window (its page is covered by test-settings.cjs). No desktop input.
// Usage: <exe> <new-output-dir>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
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
  const evaluate = async expression => {
    for (let i = 0; ; i++) {
      try {
        const r = await call('Runtime.evaluate', {expression, returnByValue: true});
        if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      } catch (error) { if (!transient.test(error.message) || i > 30) throw error; await delay(200); }
    }
  };
  return {call, evaluate, close: () => socket.close()};
}

async function main() {
  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
  assert(exe && output, 'Usage: <exe> <new-output-dir>');
  fs.mkdirSync(output);
  const results = {};
  const record = (name, value) => { results[name] = value; console.log(name, JSON.stringify(value)); };

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end('<!doctype html><title>Menu fixture</title><p>Find this needle in the page.</p>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-menu-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  // As if started by the launcher; the test never runs it (no update check).
  env.CHROMINIMUM_LAUNCHER = path.join(output, 'launcher', 'chrominimum.exe');
  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-menu', `--url=${base}`], {env, stdio: 'ignore'});
  const state = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  const log = () => fs.existsSync(path.join(data, 'smoke.log')) ? fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/) : [];
  const count = prefix => log().filter(l => l.startsWith(prefix)).length;
  let main; const started = Date.now();
  try {
    for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const pages = async () => (await targets()).filter(p => p.type === 'page');
    const until = async (what, test, ms = 20000) => {
      for (let t = 0; t < ms; t += 100) { requireRunning(state); const v = await test(); if (v) return v; await delay(100); }
      throw Error(`timed out: ${what}`);
    };
    main = await connect((await until('page', async () => (await pages()).find(p => p.url === base))).webSocketDebuggerUrl);
    await until('fixture ready', async () => await main.evaluate("document.readyState==='complete'"));
    // An occluded window renders no frames and reports zoom late.
    await main.call('Page.bringToFront');
    await delay(300);
    let n = 0;
    const menu = async command => {
      const before = count('menu_');
      await main.evaluate(`document.title=${JSON.stringify(`ChroMinimum test menu ${command}#${++n}`)}`);
      await until(`menu ${command}`, async () => count('menu_') > before, 5000);
      return log().filter(l => l.startsWith('menu_')).at(-1);
    };
    const items = async () => Object.fromEntries((await menu('items')).replace(/^menu_items; /, '').split('|').map(s => {
      const [id, enabled, checked, ...label] = s.split(':'); return [id, {enabled: enabled === '1', checked: checked === '1', label: label.join(':')}];
    }));
    const ratio = () => main.evaluate('devicePixelRatio');
    const waitRatio = async (what, test) => until(what, async () => { const r = await ratio(); return test(r) ? r : 0; }, 5000)
      .catch(async e => { throw Error(`${e.message}: ratio=${await ratio()} innerWidth=${await main.evaluate('innerWidth')} reset=${(await items())['12'].label}`); });

    // 1. Menu contents: zoom, find, print, save, open, Chrome pages, updates, about.
    const initial = await items();
    record('items', initial);
    for (const id of ['10', '11', '12', '20', '21', '22', '23', '30', '31', '32', '1', '2']) assert(initial[id], `menu item ${id} missing`);
    assert(!initial['3'], 'the login prewarm switch lives on the settings page (D046)');
    for (const id of ['10', '11', '20', '21', '23']) assert(initial[id].enabled, `menu item ${id} disabled on a web page`);
    assert.equal(initial['12'].label, 'Сбросить масштаб (100%)');

    // 2. Zoom through the menu uses Chrome's zoom steps.
    const r100 = await ratio();
    assert.equal(await menu('run:10'), 'menu_command; id=10');
    const r110 = await waitRatio('zoom in', r => r > r100 * 1.05);
    const zoomed = await items();
    await menu('run:12');
    await waitRatio('zoom reset', r => Math.abs(r - r100) < 0.01);
    await menu('run:11');
    const r90 = await waitRatio('zoom out', r => r < r100 * 0.95);
    await menu('run:12');
    await waitRatio('zoom reset', r => Math.abs(r - r100) < 0.01);
    record('zoom', {r100, r110, r90, label: zoomed['12'].label, resetEnabled: zoomed['12'].enabled});
    assert.equal(zoomed['12'].label, 'Сбросить масштаб (110%)');

    // 3. Chrome shortcuts reach the browser when the page leaves them unhandled.
    const key = async (target, key, code, keyCode, modifiers = 2) => {
      for (const type of ['rawKeyDown', 'keyUp']) await target.call('Input.dispatchKeyEvent', {type, modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode})
        .catch(e => { throw Error(`${e.message} ${key} ${type} at ${Date.now() - started}ms; ${log().filter(l => l.startsWith('menu_')).at(-1)}`); });
    };
    await key(main, '=', 'Equal', 187);
    const ctrlPlus = await until('Ctrl+=', async () => (await ratio()) > r100 * 1.05, 3000).catch(() => false);
    await key(main, '-', 'Minus', 189);
    const ctrlMinus = await until('Ctrl+-', async () => Math.abs((await ratio()) - r100) < 0.01, 3000).catch(() => false);
    await key(main, '-', 'Minus', 189);
    await until('Ctrl+- again', async () => (await ratio()) < r100 * 0.95, 3000).catch(() => false);
    await key(main, '0', 'Digit0', 48);
    const ctrl0 = await until('Ctrl+0', async () => Math.abs((await ratio()) - r100) < 0.01, 3000).catch(() => false);
    if (!ctrl0) { await menu('run:12'); await waitRatio('zoom reset', r => Math.abs(r - r100) < 0.01); }

    // 4. Find: Chrome's find bar takes focus from the page (indirect evidence).
    const findOpens = async open => {
      await main.call('Page.bringToFront');
      await until('page focused', async () => await main.evaluate('document.hasFocus()'), 3000).catch(() => false);
      await open();
      return !!await until('find bar focus', async () => !(await main.evaluate('document.hasFocus()')), 3000).catch(() => false);
    };
    const ctrlF = await findOpens(() => key(main, 'f', 'KeyF', 70));
    const findMenu = await findOpens(async () => assert.equal(await menu('run:20'), 'menu_command; id=20'));

    // 5. Print opens Chrome print preview for this page; Escape closes it.
    const printOpens = async open => {
      await main.call('Page.bringToFront');
      await open();
      const preview = await until('print preview', async () => (await targets()).find(t => t.url.startsWith('chrome://print')), 20000).catch(() => null);
      if (!preview) return {opened: false};
      const printer = await connect(preview.webSocketDebuggerUrl);
      await until('preview ready', async () => await printer.evaluate("document.readyState==='complete'").catch(() => false), 10000).catch(() => {});
      // The dialog closes on key down and its target goes away without a reply.
      printer.call('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27}).catch(() => {});
      const closed = await until('print preview closed', async () => !(await targets()).some(t => t.url.startsWith('chrome://print')), 10000).then(() => true, () => false);
      printer.close();
      return {opened: true, type: preview.type, url: preview.url, closedByEscape: closed};
    };
    const printMenu = await printOpens(async () => assert.equal(await menu('run:21'), 'menu_command; id=21'));
    const ctrlP = printMenu.closedByEscape ? await printOpens(() => key(main, 'p', 'KeyP', 80)) : 'skipped: preview still open';
    record('shortcuts', {ctrlPlus: !!ctrlPlus, ctrlMinus: !!ctrlMinus, ctrl0: !!ctrl0, findMenu, ctrlF, printMenu, ctrlP});
    assert(findMenu, 'find from the menu must open the find bar');
    // The menu labels these shortcuts (fill_browser_menu); Ctrl+F is not labelled.
    assert(ctrlPlus && ctrlMinus && ctrl0 && ctrlP.closedByEscape, 'labelled shortcuts must reach Chrome');
    assert(printMenu.opened, 'print from the menu must open print preview');
    assert.equal((await pages()).filter(p => !p.url.startsWith('chrome://print')).length, 1);

    // 6. Chrome pages open in this page; no second window.
    for (const [id, url] of [['30', 'chrome://history/'], ['31', 'chrome://settings/clearBrowserData']]) {
      await menu(`run:${id}`);
      await until(`${url} in place`, async () => await main.evaluate(`location.href===${JSON.stringify(url)}`).catch(() => false));
      const list = (await pages()).map(p => p.url);
      record(`page_${id}`, list);
      assert.equal(list.length, 1, `${url} must not open a window`);
    }
    // "Settings" opens the separate settings window and leaves this page.
    const before = await main.evaluate('location.href');
    assert.equal(await menu('run:32'), 'menu_command; id=32');
    const settings = await until('settings window', async () => (await pages()).find(p => p.url === 'chrominimum://settings/'));
    record('page_32', (await pages()).map(p => p.url));
    assert.equal(await main.evaluate('location.href'), before, 'Settings must not replace the page');
    const window = await connect(settings.webSocketDebuggerUrl);
    await window.call('Page.close').catch(() => {});
    window.close();
    await until('settings closed', async () => log().includes('settings_window_closed'));
    await main.call('Page.navigate', {url: base});
    await until('fixture again', async () => await main.evaluate(`location.href===${JSON.stringify(base)}&&document.readyState==='complete'`).catch(() => false));
    const save = (await until('save enabled', async () => { const i = (await items())['22']; return i.enabled && i; }, 5000).catch(() => null)) || (await items())['22'];
    record('save_page_after_navigation', save);
    assert(save.enabled, 'Save page must be enabled on a loaded web page');
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
  console.log('menu: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
