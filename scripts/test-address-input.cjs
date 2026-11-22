// Address bar acceptance with a disposable profile: typed-address resolution,
// HTTPS→HTTP retry, edit preservation, Esc, select-on-focus and blank-start focus.
// Drives the real native field delegate through --test-address-input (set_text
// stands in for typing); no desktop input. Usage: <exe> <new-output-dir>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const transient = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context/;

async function launch(exe, dir, args) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-address-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-address-input', ...args], {env, stdio: 'ignore'});
  const state = observeChild(child);
  const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 1200; i++) { requireRunning(state); await delay(100); }
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
  assert(page, 'no page target');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let serial = 0; const pending = new Map();
  socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, t = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${method}`)); }, 12000);
    pending.set(id, {resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    for (let i = 0; ; i++) {
      try { return (await call('Runtime.evaluate', {expression, returnByValue: true})).result.value; }
      catch (error) { if (!transient.test(error.message) || i > 50) throw error; await delay(100); }
    }
  };
  const log = () => fs.existsSync(path.join(data, 'smoke.log')) ? fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/) : [];
  const count = prefix => log().filter(l => l.startsWith(prefix)).length;
  const until = async (what, test, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) { requireRunning(state); if (await test()) return; await delay(100); }
    fs.writeFileSync(path.join(dir, 'smoke.log'), log().join('\n'));
    throw Error(`timed out: ${what}`);
  };
  let n = 0;
  const command = async cmd => {
    const before = count('address_field;');
    await evaluate(`document.title=${JSON.stringify(`ChroMinimum test address ${cmd}#${++n}`)}`);
    if (cmd !== 'report') { await delay(400); return; }
    await until('address report', () => count('address_field;') > before);
    const line = log().filter(l => l.startsWith('address_field;')).at(-1);
    const [, focused, text, selected] = line.match(/^address_field; focused=(\d); text=(.*); selected=(.*)$/);
    return {focused: focused === '1', text, selected};
  };
  const at = (url, ms) => until(`location ${url}`, async () =>
    await evaluate(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`), ms);
  const finish = async () => {
    try { await call('Page.close'); } catch {}
    socket.close();
    try { await waitForExit(state, 15000); } catch { child.kill(); }
    state.detach();
    for (const f of ['smoke.log', 'cef.log']) if (fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(data, f), path.join(dir, f));
    return log().includes('shutdown_complete');
  };
  return {data, evaluate, log, count, until, command, at, finish};
}

async function main() {
  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
  assert(exe && output, 'Usage: <exe> <new-output-dir>');
  fs.mkdirSync(output);
  const results = {};
  const record = (name, value) => { results[name] = value; console.log(name, JSON.stringify(value)); };

  // 1. Empty start: the field is focused and shows the placeholder, not about:blank.
  {
    const dir = path.join(output, 'blank-start'); fs.mkdirSync(dir);
    const b = await launch(exe, dir, []);
    await b.until('blank page', async () => await b.evaluate("location.href==='about:blank'"));
    const r = await b.command('report');
    record('blank_start', r);
    assert.equal(r.text, '', 'about:blank must show an empty field');
    assert(r.focused, 'address field must have focus on an empty start');
    record('blank_start_shutdown', await b.finish());
  }

  // 2. Fixture page: edit, Esc, select-on-focus, address resolution and HTTP retry.
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><title>Address fixture</title>${req.url}`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const closed = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = path.join(output, 'fixture'); fs.mkdirSync(dir);
  const b = await launch(exe, dir, [`--url=${base}/`]);
  let tlsServer, tlsRequests = 0;
  try {
    await b.at(`${base}/`, 60000);
    let r = await b.command('report');
    record('initial', r);
    assert.equal(r.text, `${base}/`);

    await b.command('focus');
    r = await b.command('report');
    record('focus_selects_address', r);
    assert(r.focused && r.selected === `${base}/`, 'focusing the field must select the page address');

    await b.command('type:draft text');
    const preserved = b.count('address_edit_preserved');
    await b.evaluate("history.pushState({},'','/pushed')");
    await b.until('edit preserved', () => b.count('address_edit_preserved') > preserved);
    r = await b.command('report');
    record('edit_survives_address_change', r);
    assert.equal(r.text, 'draft text');

    await b.command('escape');
    r = await b.command('report');
    record('escape_restores', r);
    assert(r.text === `${base}/pushed` && r.selected === `${base}/pushed`);

    await b.command('type:localhost:' + port + '/local');
    await b.command('enter');
    await b.at(`http://localhost:${port}/local`);
    r = await b.command('report');
    record('localhost_plain_http', r);
    assert(r.text === `http://localhost:${port}/local` && !r.focused);

    let fallbacks = b.count('address_http_fallback');
    await b.command('focus'); await b.command(`type:fallback.example:${port}/tls`); await b.command('enter');
    await b.at(`http://fallback.example:${port}/tls`, 30000);
    await delay(3000); // A late error-page commit must not replace the retried page.
    assert.equal(await b.evaluate('location.href'), `http://fallback.example:${port}/tls`);
    assert.equal((await b.command('report')).text, `http://fallback.example:${port}/tls`);
    record('https_guess_retried_over_http', b.log().filter(l => l.startsWith('address_http_fallback')).slice(fallbacks));
    assert.equal(b.count('address_http_fallback'), fallbacks + 1);

    fallbacks = b.count('address_http_fallback');
    let errors = b.count('main_frame_error');
    await b.command('focus'); await b.command(`type:fallback.example:${closed}/refused`); await b.command('enter');
    await b.until('retry failed too', () => b.count('address_http_fallback') > fallbacks && b.count('main_frame_error') > errors, 30000);
    await delay(3000);
    r = await b.command('report');
    record('refused_single_retry', {fallbacks: b.count('address_http_fallback') - fallbacks, text: r.text});
    assert.equal(b.count('address_http_fallback'), fallbacks + 1, 'exactly one HTTP retry');
    assert.equal(r.text, `http://fallback.example:${closed}/refused`, 'the field shows the failed retry URL');

    const openssl = process.env.CHROMINIMUM_TEST_OPENSSL || 'C:/Program Files/Git/usr/bin/openssl.exe';
    if (fs.existsSync(openssl)) {
      const key = path.join(b.data, 'key.pem'), cert = path.join(b.data, 'cert.pem');
      const made = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], {encoding: 'utf8'});
      assert.equal(made.status, 0, made.stderr);
      tlsServer = https.createServer({key: fs.readFileSync(key), cert: fs.readFileSync(cert)}, (_q, s) => { tlsRequests++; s.end('bypassed'); });
      await new Promise(r => tlsServer.listen(0, '127.0.0.1', r));
      fallbacks = b.count('address_http_fallback'); errors = b.count('main_frame_error');
      await b.command('focus'); await b.command(`type:fallback.example:${tlsServer.address().port}/cert`); await b.command('enter');
      await b.until('certificate error', () => b.count('main_frame_error') > errors, 30000);
      await delay(2000);
      const error = b.log().filter(l => l.startsWith('main_frame_error')).at(-1);
      record('certificate_error_not_downgraded', {error, fallbacks: b.count('address_http_fallback') - fallbacks, tlsRequests});
      assert.equal(b.count('address_http_fallback'), fallbacks, 'certificate errors must not fall back to HTTP');
      assert.equal(tlsRequests, 0);
    } else record('certificate_error_not_downgraded', 'skipped: openssl not found');

    const file = path.join(b.data, 'address test #1.html');
    fs.writeFileSync(file, '<!doctype html><title>Typed file</title>file');
    await b.command('focus'); await b.command(`type:${file}`); await b.command('enter');
    const expected = pathToFileURL(file).href;
    await b.until(`file ${expected}`, async () => decodeURIComponent(await b.evaluate('location.href')).toLowerCase() === decodeURIComponent(expected).toLowerCase());
    record('typed_path_opens_file', await b.evaluate('location.href'));
  } finally {
    record('fixture_shutdown', await b.finish());
    server.close(); tlsServer?.close();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(results, null, 2));
  }
  assert(results.blank_start_shutdown && results.fixture_shutdown, 'clean shutdown');
  console.log('address input: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
