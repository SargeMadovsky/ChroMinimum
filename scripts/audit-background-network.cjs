// Diagnostic only: fresh profiles, loopback fixtures, no real credentials.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const [launcherArg, outputArg] = process.argv.slice(2);
const launcher = launcherArg && path.resolve(launcherArg), output = outputArg && path.resolve(outputArg);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = {
  '/default': '<!doctype html><title>Default background</title><p>Black text on default background</p>',
  '/dark': '<!doctype html><style>body{background:rgb(12,34,56);color:white}</style><p>Explicit dark background</p>',
  '/gradient': '<!doctype html><style>html{height:100%;background:linear-gradient(#00aa00,#0000aa)}</style><p>Explicit gradient</p>',
  '/form': '<!doctype html><title>Local test form</title><form method=post action="/never-submit"><label>User<input name=username autocomplete=username></label><label>Password<input name=password type=password autocomplete=current-password></label><button>Sign in</button></form>',
};

async function screenshotCases(work) {
  const portFile = path.join(work, 'profile-smoke', 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page');
  if (!tab) throw Error('No diagnostic page');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (pending.has(m.id)) {
      const [resolve, reject] = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, [resolve, reject]); socket.send(JSON.stringify({id, method, params}));
  });
  try {
    await call('Page.enable');
    const origin = new URL(tab.url).origin;
    for (const name of ['default', 'dark', 'gradient', 'form']) {
      await call('Page.navigate', { url: `${origin}/${name}` });
      await delay(800);
      if (name === 'form' && process.env.CM_AUDIT_FORM_INPUT === '1') {
        await call('Runtime.evaluate', {expression: 'document.querySelector("[name=username]").focus()'});
        await call('Input.insertText', {text: 'synthetic-test-user'});
        await call('Runtime.evaluate', {expression: 'document.querySelector("[name=password]").focus()'});
        await call('Input.insertText', {text: 'synthetic-test-only'});
        const check = await call('Runtime.evaluate', {returnByValue: true, expression: `(() => {
          const form = document.querySelector('form');
          let submitted = false;
          form.addEventListener('submit', e => { e.preventDefault(); submitted = true; }, {once:true});
          form.requestSubmit();
          return {username_input: form.elements.username.value === 'synthetic-test-user',
            password_input: form.elements.password.value === 'synthetic-test-only',
            submit_event: submitted, network_submission_prevented: true};
        })()`});
        const result = check.result.value;
        if (!result?.username_input || !result?.password_input || !result?.submit_event)
          throw Error('Synthetic form input/submit failed');
        fs.writeFileSync(path.join(work, 'form-input.json'), JSON.stringify(result, null, 2));
      }
      if (name === 'form' && process.env.CM_AUDIT_COOKIE_CHECK === '1') {
        const check = await call('Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression: `(async () => {
          document.cookie = 'cm_synthetic_cookie=enabled; SameSite=Lax; Path=/';
          return {javascript_cookie: document.cookie.includes('cm_synthetic_cookie=enabled'),
            http_cookie: (await (await fetch('/cookie-check')).json()).received};
        })()`});
        const result = check.result.value;
        if (!result?.javascript_cookie || !result?.http_cookie) throw Error('Site cookies failed');
        fs.writeFileSync(path.join(work, 'cookie-check.json'), JSON.stringify(result, null, 2));
      }
      if (name !== 'form') {
        const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: false });
        fs.writeFileSync(path.join(work, `background-${name}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  } finally { socket.close(); }
}

function summarize(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k,v]) => [v,k]));
  const jobs = [], current = new Map(), dns = new Set();
  for (const event of log.events) {
    const type = types[event.type], p = event.params || {};
    if (type === 'URL_REQUEST_START_JOB' && p.url) {
      const url = new URL(p.url);
      if (['http:', 'https:'].includes(url.protocol)) {
        const job = {
        host: url.hostname, url: url.origin + url.pathname, method: p.method, response: null, net_error: null,
        };
        jobs.push(job); current.set(event.source.id, job);
      }
    }
    const job = current.get(event.source.id);
    if (job && type === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS') job.response = p.headers?.[0] || null;
    if (job && p.net_error !== undefined) job.net_error = p.net_error;
    if (type?.includes('HOST_RESOLVER') && typeof p.host === 'string') dns.add(p.host);
  }
  return { requests: jobs, dns_hosts: [...dns].sort(), queries_and_headers_omitted: true };
}

module.exports = { summarize };
if (require.main === module) (async () => {
  if (!launcher || !output) throw Error('Usage: node audit-background-network.cjs <launcher> <new-output>');
  fs.mkdirSync(output, {recursive:false});
  const server = http.createServer((req, res) => {
    if (req.url === '/cookie-check') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({received: (req.headers.cookie || '').split(';').some(c => c.trim() === 'cm_synthetic_cookie=enabled')}));
      return;
    }
    const body = pages[req.url];
    res.writeHead(body ? 200 : 204, {'Content-Type':'text/html; charset=utf-8'});
    res.end(body || '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = {};
    for (const name of process.env.CM_AUDIT_COLOR_ONLY === '1' ? ['local-form'] : ['blank', 'local-form', 'prepared-blank']) {
      const work = path.join(output, name); fs.mkdirSync(work);
      if (name === 'prepared-blank') fs.cpSync(path.join(output, 'blank', 'profile-smoke'), path.join(work, 'profile-smoke'), {recursive:true});
      const url = name === 'local-form' ? `http://127.0.0.1:${server.address().port}/form` : 'about:blank';
      const args = ['--smoke-test', '--test-net-log', `--url=${url}`];
      if (name === 'local-form') args.push('--test-cdp');
      const child = spawn(launcher, args, {env:{...process.env,CHROMINIMUM_DATA_DIR:work}, windowsHide:true, stdio:'ignore'});
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code)); });
      if (name === 'local-form') await screenshotCases(work);
      let timer;
      let code;
      try {
        code = await Promise.race([done, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Timeout: ${name}; process left for diagnosis`)), 65000);
        })]);
      } finally { clearTimeout(timer); }
      const evidence = fs.readFileSync(path.join(work, 'smoke.log'),'utf8');
      if (code !== 0 || !evidence.includes('shutdown_complete')) throw Error(`Unclean exit: ${name}`);
      results[name] = {exit_code:code, ...summarize(path.join(work,'netlog.json'))};
      fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(results,null,2));
      process.stdout.write(JSON.stringify({case:name,...results[name]})+'\n');
    }
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
