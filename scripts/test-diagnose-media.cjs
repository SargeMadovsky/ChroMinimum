// Lifecycle regressions use short Node processes; no browser or personal profile.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {observeChild, requireRunning, waitForExit, runDiagnostic} = require('./diagnose-media.cjs');

test('spawn failure is observed without an unhandled rejection', async () => {
  const child = spawn(path.join(__dirname, 'nonexistent-media-probe.exe'), [], {windowsHide:true});
  const state = observeChild(child);
  await state.done;
  assert.equal(state.finished, true);
  assert.equal(state.error.code, 'ENOENT');
  assert.throws(() => requireRunning(state), /ended before CDP was ready/);
  await assert.rejects(waitForExit(state, 1000), {code:'ENOENT'});
});

test('early nonzero exit is retained and rejected by readiness', async () => {
  const state = observeChild(spawn(process.execPath, ['-e', 'process.exit(7)'], {windowsHide:true}));
  assert.equal(await waitForExit(state, 5000), 7);
  assert.throws(() => requireRunning(state), /exit=7/);
});

test('already completed clean process can be awaited', async () => {
  const state = observeChild(spawn(process.execPath, ['-e', 'process.exit(0)'], {windowsHide:true}));
  await state.done;
  assert.equal(await waitForExit(state, 1000), 0);
});

test('shutdown timeout reports PID without killing a process', async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  let detached = false;
  child.unref = () => {detached = true;};
  const state = observeChild(child);
  assert.doesNotThrow(() => requireRunning(state));
  await assert.rejects(waitForExit(state, 20), /PID=12345; process not terminated/);
  assert.equal(state.finished, false);
  assert.equal(detached, true);
  child.emit('exit', 0, null);
  assert.equal(await waitForExit(state, 1000), 0);
});

test('CLI fails promptly when executable is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-media-cli-'));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'diagnose-media.cjs'),
      path.join(root, 'missing.exe'), path.join(root, 'output')], {windowsHide:true});
    let stderr = '';
    child.stderr.on('data', chunk => {stderr += chunk;});
    const state = observeChild(child);
    assert.equal(await waitForExit(state, 5000), 1);
    assert.match(stderr, /Diagnostic process ended before CDP was ready/);
    assert.doesNotMatch(stderr, /UnhandledPromiseRejection/);
    assert.equal(fs.existsSync(path.join(root, 'output/capabilities.json')), false);
  } finally { fs.rmSync(root, {recursive:true}); }
});

test('overall watchdog stops runner despite a live socket and pending promise', async () => {
  const script = `
    const net = require('node:net');
    const {runDiagnostic} = require(${JSON.stringify(path.join(__dirname, 'diagnose-media.cjs'))});
    runDiagnostic(() => new Promise(() => {
      const server = net.createServer(() => {});
      server.listen(0, '127.0.0.1', () => {
        net.connect(server.address().port, '127.0.0.1');
      });
    }), 100);
  `;
  const child = spawn(process.execPath, ['-e', script], {windowsHide:true});
  let stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  assert.equal(await waitForExit(observeChild(child), 5000), 1);
  assert.match(stderr, /Diagnostic overall timeout after 100 ms/);
  assert.match(stderr, /browser not terminated/);
});

test('watchdog is cleared after success and failure', async () => {
  await runDiagnostic(async () => {}, 50);
  await assert.rejects(runDiagnostic(async () => {throw Error('fixture failure');}, 50), /fixture failure/);
  // A leaked timer would terminate the test runner before this assertion.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(true);
});


test('requiring the platform backend does not inject its test activation switch', () => {
  const {buildLaunchArguments} = require('./diagnose-media.cjs');
  const normal = buildLaunchArguments('http://127.0.0.1/fixture', false);
  assert.deepEqual(normal, ['--smoke-test', '--test-cdp', '--url=http://127.0.0.1/fixture']);
  assert(!normal.includes('--test-platform-aac'));
  assert(buildLaunchArguments('about:blank', true).includes('--test-platform-aac'));
  const extended = buildLaunchArguments('about:blank', false, true);
  assert(extended.includes('--test-chrome-downloads'));
  assert(!extended.includes('--test-platform-aac'));
});
