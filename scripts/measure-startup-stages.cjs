// Startup stage timing on disposable profiles and a loopback fixture; no UI
// input, no personal data. The launcher and core write wall-clock marks to the
// smoke log (smoke runs only); this script lines them up with its own spawn
// time and the fixture's callbacks.
// Usage: <bundle chrominimum.exe> <new-output-dir> [--runs N] [--fresh-copy]
//   --fresh-copy  copy the bundle to a new folder for every run: the first
//                 launch of new files (antivirus scan, new image loads). This
//                 is not a cold boot; a cold start needs a run right after login.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');

const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
const median = values => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const STAGES = ['launcher_start', 'launcher_selected', 'launcher_spawn', 'core_process_created', 'core_dll_entry',
  'engine_loaded', 'browser_process', 'cef_initialize_start', 'context_initialized', 'window_created',
  'browser_created', 'toolbar_created', 'window_show_call', 'window_shown', 'cef_initialize_done', 'page_script', 'main_frame_loaded',
  'page_frame'];
// The first window opens inside CefInitialize (on_context_initialized runs
// before it returns), so cef_initialize_done follows window_shown.

async function main() {
  const argv = process.argv.slice(2);
  const flag = name => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
  const option = name => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const freshCopy = flag('--fresh-copy');
  const runs = Number(option('--runs') ?? 5);
  const [exe, output] = argv.map(p => path.resolve(p));
  assert(exe && output && runs > 0, 'Usage: <bundle chrominimum.exe> <new-output-dir> [--runs N] [--fresh-copy]');
  fs.mkdirSync(output);

  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mark') {
      hits.set(`${url.searchParams.get('run')}:${url.searchParams.get('stage')}`, nowUs());
      res.writeHead(204, {'Cache-Control': 'no-store'}); return res.end();
    }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    // page_script: the document's script ran; page_frame: two animation
    // frames later, an upper bound for the first painted frame.
    res.end(`<!doctype html><title>Startup fixture</title><p>Local startup fixture</p><script>
const run=new URLSearchParams(location.search).get('run');
const mark=s=>fetch('/mark?run='+run+'&stage='+s,{cache:'no-store'});
mark('page_script');requestAnimationFrame(()=>requestAnimationFrame(()=>mark('page_frame')));
</script>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const results = [];
  try {
    for (let run = 1; run <= runs; run++) {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-startup-'));
      let target = exe, copy = null;
      if (freshCopy) {
        copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-bundle-'));
        fs.cpSync(path.dirname(exe), copy, {recursive: true});
        // As the bundle step does: the network sandbox (AppContainer) needs RX
        // on core, or the browser refuses to start the network service.
        const icacls = spawnSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'),
          [path.join(copy, 'core'), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/Q'], {stdio: 'ignore'});
        assert.equal(icacls.status, 0, 'AppContainer read/execute grant failed');
        target = path.join(copy, path.basename(exe));
      }
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));
      env.CHROMINIMUM_DATA_DIR = data;
      const spawned = nowUs();
      // The smoke launcher waits for its core; the core closes 5 s after creation.
      const child = spawn(target, ['--smoke-test', '--test-startup-marks', `--url=${base}?run=${run}`], {env, stdio: 'ignore'});
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error(`run ${run} did not exit`)); }, 120000);
        child.on('exit', c => { clearTimeout(timer); resolve(c); });
        child.on('error', reject);
      });
      const log = fs.readFileSync(path.join(data, 'smoke.log'), 'utf8').split(/\r?\n/);
      const marks = {};
      for (const line of log) {
        const m = /^startup; stage=(\w+); t_us=(\d+)$/.exec(line);
        if (m && !(m[1] in marks)) marks[m[1]] = (Number(m[2]) - spawned) / 1000;
      }
      for (const stage of ['page_script', 'page_frame']) {
        const t = hits.get(`${run}:${stage}`);
        if (t) marks[stage] = (t - spawned) / 1000;
      }
      const record = {run, exit: code, shutdown: log.includes('shutdown_complete'), ms: marks};
      results.push(record);
      console.log(`run ${run}: ${STAGES.filter(s => s in marks).map(s => `${s}=${marks[s].toFixed(1)}`).join(' ')}`);
      fs.copyFileSync(path.join(data, 'smoke.log'), path.join(output, `smoke-${run}.log`));
      fs.rmSync(data, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      if (copy) fs.rmSync(copy, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { server.close(); }

  // Median time since spawn for each stage, and the median step from the previous stage.
  const summary = {};
  let previous = null;
  for (const stage of STAGES) {
    const values = results.map(r => r.ms[stage]).filter(v => v !== undefined);
    if (!values.length) continue;
    const steps = previous ? results.filter(r => stage in r.ms && previous in r.ms).map(r => r.ms[stage] - r.ms[previous]) : values;
    summary[stage] = {median_ms: +median(values).toFixed(1), min_ms: +Math.min(...values).toFixed(1), max_ms: +Math.max(...values).toFixed(1),
      step_median_ms: +median(steps).toFixed(1), runs: values.length};
    previous = stage;
  }
  console.table(summary);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({exe, runs, freshCopy, machine: {cpus: os.cpus()[0]?.model, cores: os.cpus().length, memory_gb: +(os.totalmem() / 2 ** 30).toFixed(1), os: os.release()}, summary, results}, null, 2));
  assert(results.every(r => r.exit === 0 && r.shutdown), 'every run must exit cleanly');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
