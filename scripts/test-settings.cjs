// Settings page acceptance (D046) with a disposable profile and a loopback
// fixture: the separate settings window from the menu and from a typed
// address, the page state and CSP, the login prewarm switch against a
// smoke-only registry key (the real HKCU Run key is compared before and
// after), the browser-process checks on the API, web pages kept away from
// chrominimum://, and the engine page links. The launcher path is fake: the
// update check fails to start it, so no network. No desktop input.
// Usage: <exe> <new-output-dir>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const transient = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context|timeout/;
const SETTINGS = 'chrominimum://settings/';
const ENGINE = {
  passwords: 'chrome://password-manager/passwords', content: 'chrome://settings/content',
  clear: 'chrome://settings/clearBrowserData', privacy: 'chrome://settings/privacy',
  downloads: 'chrome://settings/downloads', languages: 'chrome://settings/languages',
  fonts: 'chrome://settings/fonts', appearance: 'chrome://settings/appearance',
  certificates: 'chrome://certificate-manager/',
};

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let serial = 0; const pending = new Map();
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  socket.onclose = () => { for (const p of pending.values()) p.reject(Error('Inspected target navigated or closed')); pending.clear(); };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, t = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}`)); }, 15000);
    pending.set(id, {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    for (let i = 0; ; i++) {
      try {
        const r = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise});
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
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end('<!doctype html><title>Settings fixture</title><p>Fixture page.</p>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-settings-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  // As if started by the launcher; the file does not exist, so nothing runs.
  const launcher = path.join(output, 'launcher', 'chrominimum.exe');
  env.CHROMINIMUM_LAUNCHER = launcher;
  const reg = (...args) => spawnSync(path.join(process.env.SystemRoot, 'System32', 'reg.exe'), args, {encoding: 'utf8'});
  const PREWARM = 'ChroMinimum Prewarm', PARENT = String.raw`HKCU\Software\ChroMinimum`;
  const TEST_KEY = String.raw`${PARENT}\SmokeTest`, REAL_RUN = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
  const realBefore = reg('query', REAL_RUN, '/v', PREWARM);
  const parentExisted = reg('query', PARENT).status === 0;
  reg('delete', TEST_KEY, '/f');
  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-menu', '--test-address-input', `--url=${base}`], {env, stdio: 'ignore'});
  const state = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  const log = () => fs.existsSync(path.join(data, 'smoke.log')) ? fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/) : [];
  const count = prefix => log().filter(l => l.startsWith(prefix)).length;
  let main, settings;
  try {
    for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(p => p.type === 'page');
    const until = async (what, test, ms = 20000) => {
      for (let t = 0; t < ms; t += 100) { requireRunning(state); const v = await test(); if (v) return v; await delay(100); }
      throw Error(`timed out: ${what}`);
    };
    main = await connect((await until('page', async () => (await pages()).find(p => p.url === base))).webSocketDebuggerUrl);
    await until('fixture ready', async () => await main.evaluate("document.readyState==='complete'"));
    let n = 0;
    const title = async (prefix, command) => main.evaluate(`document.title=${JSON.stringify(`${prefix}${command}#${++n}`)}`);
    const menu = async command => {
      const before = count('menu_');
      await title('ChroMinimum test menu ', command);
      await until(`menu ${command}`, async () => count('menu_') > before, 5000);
      return log().filter(l => l.startsWith('menu_')).at(-1);
    };
    const settingsTargets = async () => (await pages()).filter(p => p.url.startsWith('chrominimum:'));
    const openSettings = async () => {
      const target = await until('settings window', async () => (await settingsTargets())[0]);
      const page = await connect(target.webSocketDebuggerUrl);
      await until('settings rendered', async () => await page.evaluate(`location.href === '${SETTINGS}' && document.readyState === 'complete' && (document.getElementById('version')?.textContent ?? '') !== ''`).catch(() => false));
      return {target, page};
    };
    const closeSettings = async () => {
      const before = count('settings_window_closed');
      await settings.page.call('Page.close').catch(() => {});
      settings.page.close();
      await until('settings closed', async () => count('settings_window_closed') > before && (await settingsTargets()).length === 0);
    };

    // 1. The menu item has no prewarm check any more and opens a separate window.
    const items = Object.fromEntries((await menu('items')).replace(/^menu_items; /, '').split('|').map(s => {
      const [id, enabled, checked, ...label] = s.split(':'); return [id, {enabled: enabled === '1', checked: checked === '1', label: label.join(':')}];
    }));
    record('menu_items', items);
    assert(!items['3'], 'the prewarm item moved to the settings page');
    assert.equal(items['32']?.label, 'Настройки');
    assert.equal(items['31']?.label?.startsWith('Удалить данные'), true);
    assert.equal(await menu('run:32'), 'menu_command; id=32');
    settings = await openSettings();
    const all = (await pages()).map(p => p.url);
    record('pages_after_menu', all);
    assert.equal(all.length, 2, 'settings open in a second window');
    assert(all.includes(base), 'the browser window keeps its page');

    // 2. Rendered state, CSP, theme.
    const view = await settings.page.evaluate(`({
      title: document.title, version: version.textContent, engine: engine.textContent,
      prewarm: {checked: prewarm.checked, disabled: prewarm.disabled, role: prewarm.getAttribute('role')},
      prewarmUnavailable: !document.getElementById('prewarm-unavailable').hidden,
      updates: {label: document.getElementById('updates-label').textContent, disabled: document.getElementById('updates-check').disabled},
      links: [...document.querySelectorAll('[data-target]')].map(b => b.dataset.target),
    })`);
    record('view', view);
    assert(view.version && view.engine, 'version and engine shown');
    assert.equal(view.prewarm.checked, false, 'prewarm is off by default');
    assert.equal(view.prewarm.disabled, false, 'prewarm is available when started by the launcher');
    assert.deepEqual(view.links, Object.keys(ENGINE));
    const inline = await settings.page.evaluate(`new Promise(resolve => {
      let violation = '';
      document.addEventListener('securitypolicyviolation', e => { violation = e.violatedDirective; }, {once: true});
      const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s);
      setTimeout(() => resolve({ran: window.__inline === 1, violation}), 300);
    })`, true);
    record('csp_inline_script', inline);
    assert(!inline.ran, 'CSP blocks inline scripts');
    const background = async scheme => {
      await settings.page.call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: scheme}]});
      return settings.page.evaluate("getComputedStyle(document.documentElement).backgroundColor");
    };
    const theme = {light: await background('light'), dark: await background('dark')};
    await settings.page.call('Emulation.setEmulatedMedia', {features: []});
    record('theme', theme);
    assert.notEqual(theme.light, theme.dark, 'dark theme follows the system');

    // 3. API rules inside the settings page: POST only, exact paths.
    const status = async (target, expr) => target.evaluate(`fetch(${expr}).then(r => r.status, e => 'error: ' + e.message)`, true);
    const api = {
      getState: await status(settings.page, "'api/state'"),
      postState: await status(settings.page, "'api/state', {method: 'POST'}"),
      unknown: await status(settings.page, "'api/other', {method: 'POST'}"),
      badPrewarm: await status(settings.page, "'api/prewarm?on=2', {method: 'POST'}"),
      badOpen: await status(settings.page, "'api/open?target=chrome%3A%2F%2Fflags', {method: 'POST'}"),
    };
    record('api_rules', api);
    assert.equal(api.postState, 200);
    for (const k of ['getState', 'unknown', 'badPrewarm', 'badOpen']) assert.equal(api[k], 404, k);

    // 4. Prewarm through the page writes only the smoke registry key.
    const stored = sub => reg('query', `${TEST_KEY}\\${sub}`, '/v', PREWARM);
    const toggle = async wanted => {
      const before = count('settings_api; call=prewarm');
      await settings.page.evaluate('prewarm.click()');
      await until('prewarm saved', async () => count('settings_api; call=prewarm') > before);
      await until('prewarm rendered', async () => await settings.page.evaluate(`prewarm.checked === ${wanted} && !prewarm.disabled && document.getElementById('status').textContent !== ''`));
      return {event: log().filter(l => l.startsWith('settings_api; call=prewarm')).at(-1), status: await settings.page.evaluate("document.getElementById('status').textContent")};
    };
    const on = await toggle(true);
    const value = stored('Run');
    assert(value.status === 0 && value.stdout.includes(`"${launcher}" --prewarm`), `Run value must start the launcher with --prewarm: ${value.status} ${value.stdout} ${value.stderr}`);
    const reloaded = await settings.page.evaluate("fetch('api/state', {method: 'POST'}).then(r => r.json())", true);
    const off = await toggle(false);
    const removed = stored('Run').status !== 0;
    record('prewarm', {on, off, value: value.stdout.trim().split(/\r?\n/).at(-1).trim(), stateAfterOn: reloaded.prewarmOn, removed});
    assert.equal(on.event, 'settings_api; call=prewarm; on=true; saved=true');
    assert.equal(off.event, 'settings_api; call=prewarm; on=false; saved=true');
    assert(reloaded.prewarmOn && removed, 'prewarm state round trip');

    // 5. Update check: the fake launcher fails to start; the browser process
    // pushes the new state to the page (an event, no polling).
    const label = await settings.page.evaluate("document.getElementById('updates-label').textContent");
    await settings.page.evaluate("document.getElementById('updates-check').click()");
    await until('update call', async () => count('settings_api; call=updates') > 0);
    const after = await until('label pushed', async () => {
      const l = await settings.page.evaluate("document.getElementById('updates-label').textContent");
      return l !== label && l;
    }, 10000).catch(() => null);
    record('updates', {before: label, after, statuses: log().filter(l => l.startsWith('core_update_status')).slice(-3)});
    assert(after, 'the settings page shows the update status change');

    // 6. Only one settings window; the menu brings it to the front.
    const activated = count('settings_window_activated');
    await menu('run:32');
    await until('activated', async () => count('settings_window_activated') > activated);
    assert.equal((await settingsTargets()).length, 1, 'one settings window');

    // 7. Web content cannot reach chrominimum://: navigation, frames, fetch.
    const blocked = count('settings_navigation_blocked');
    const attack = await main.evaluate(`(async () => {
      const result = {};
      result.fetch = await fetch('${SETTINGS}api/state', {method: 'POST'}).then(r => r.status, e => 'error: ' + e.message);
      result.asset = await fetch('${SETTINGS}settings.js').then(r => r.status, e => 'error: ' + e.message);
      const frame = document.createElement('iframe'); frame.src = '${SETTINGS}'; document.body.append(frame);
      await new Promise(r => setTimeout(r, 1000));
      try { result.frame = frame.contentWindow.location.href; } catch (e) { result.frame = 'cross-origin: ' + e.name; }
      return result;
    })()`, true);
    const tree = (await main.call('Page.getFrameTree')).frameTree;
    attack.childFrames = (tree.childFrames || []).map(f => f.frame.url + (f.frame.unreachableUrl ? ` (unreachable ${f.frame.unreachableUrl})` : ''));
    await main.evaluate(`location.href = '${SETTINGS}'`);
    await delay(1500);
    attack.mainUrl = await main.evaluate('location.href');
    attack.blockedEvents = count('settings_navigation_blocked') - blocked;
    attack.refusedEvents = count('settings_api_refused');
    record('web_attack', attack);
    assert.equal(attack.mainUrl, base, 'a web page cannot navigate to chrominimum://');
    assert(typeof attack.fetch !== 'number' || attack.fetch >= 400, 'a web page cannot call the API');
    assert(typeof attack.asset !== 'number' || attack.asset >= 400, 'a web page cannot read the page assets');
    assert(attack.childFrames.every(u => !u.startsWith('chrominimum:')), 'a web page cannot frame chrominimum://');
    // Chromium refuses these first (DISPLAY_ISOLATED); OnBeforeBrowse is the
    // second line and may not see them, so its events are only recorded.

    // 8. A web link opened in the settings window goes to a normal window.
    const moved = count('settings_web_link_moved');
    await settings.page.evaluate(`location.href = '${base}?aside'`);
    const aside = await until('aside window', async () => (await pages()).find(p => p.url === `${base}?aside`), 10000).catch(() => null);
    record('web_link', {moved: count('settings_web_link_moved') - moved, aside: !!aside, settingsUrl: await settings.page.evaluate('location.href')});
    assert(aside, 'a web link opens a normal window');
    assert.equal(await settings.page.evaluate('location.href'), SETTINGS);
    if (aside) { const w = await connect(aside.webSocketDebuggerUrl); await w.call('Page.close').catch(() => {}); w.close(); }
    await until('aside closed', async () => !(await pages()).some(p => p.url === `${base}?aside`), 10000);

    // 9. Engine pages open in the settings window; Back returns to settings.
    const engine = {};
    for (const [key, url] of Object.entries(ENGINE)) {
      await settings.page.evaluate(`document.querySelector('[data-target="${key}"]').click()`);
      const reached = await until(`${key} page`, async () => {
        const href = await settings.page.evaluate('location.href').catch(() => '');
        return href !== SETTINGS && href;
      }, 10000).catch(() => null);
      await delay(800);
      const loaded = reached && await settings.page.evaluate("({href: location.href, title: document.title, })").catch(e => ({error: e.message}));
      // A chrome:// frame in the settings window cannot use the API either.
      const fromEngine = reached ? await status(settings.page, `'${SETTINGS}api/state', {method: 'POST'}`) : null;
      await settings.page.evaluate('history.back()').catch(() => {});
      const back = await until('back to settings', async () => await settings.page.evaluate(`location.href === '${SETTINGS}' && document.readyState === 'complete' && version.textContent !== ''`).catch(() => false), 10000).then(() => true, () => false);
      engine[key] = {expected: url, loaded, fromEngine, back};
      console.log('engine', key, JSON.stringify(engine[key]));
      if (!back) await settings.page.call('Page.navigate', {url: SETTINGS}).catch(() => {});
    }
    record('engine', engine);
    record('pages_after_engine', (await pages()).map(p => p.url));
    for (const [key, r] of Object.entries(engine)) {
      assert(r.loaded?.href?.startsWith(r.expected.replace(/\/$/, '')), `${key}: ${JSON.stringify(r.loaded)}`);
      // WebUI renders in shadow roots, so body text is empty; the title is set
      // by the page's own script.
      assert(r.loaded.title && r.loaded.title !== r.loaded.href, `${key}: the engine page did not render`);
      assert(typeof r.fromEngine !== 'number' || r.fromEngine >= 400, `${key}: the engine page reached the API`);
      assert(r.back, `${key}: Back returns to settings`);
    }

    // 10. A typed address opens the settings window too.
    await closeSettings();
    const opened = count('settings_window_opened');
    await title('ChroMinimum test address ', `type:chrominimum://settings`);
    await delay(200);
    await title('ChroMinimum test address ', 'enter');
    settings = await openSettings();
    record('typed', {opened: count('settings_window_opened') - opened, mainUrl: await main.evaluate('location.href')});
    assert.equal(await main.evaluate('location.href'), base, 'the browser window stays on its page');
    await closeSettings();
    settings = null;
  } finally {
    try { if (settings) { await settings.page.call('Page.close'); settings.page.close(); } } catch {}
    try { await main?.call('Page.close'); } catch {}
    main?.close();
    try { await waitForExit(state, 20000); } catch { child.kill(); }
    state.detach();
    for (const f of ['smoke.log', 'cef.log']) if (fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(data, f), path.join(output, f));
    record('shutdown', log().includes('shutdown_complete'));
    record('handler_failed', log().includes('settings_scheme_handler_failed'));
    reg('delete', TEST_KEY, '/f');
    if (!parentExisted) reg('delete', PARENT, '/f');
    const realAfter = reg('query', REAL_RUN, '/v', PREWARM);
    record('real_run_key_unchanged', realAfter.status === realBefore.status && realAfter.stdout === realBefore.stdout);
    server.close();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(results, null, 2));
  }
  assert(results.shutdown, 'clean shutdown');
  assert(!results.handler_failed, 'scheme handler registered');
  assert(results.real_run_key_unchanged, 'the real Run key must not change');
  console.log('settings: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
