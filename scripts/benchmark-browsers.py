"""Windows-only visible browser pilot. Uses disposable copies of test profiles.

Tools (not application dependencies):
python -m pip install --target .local/benchmark-python psutil==7.2.2 matplotlib==3.10.8
python scripts/benchmark-browsers.py --runs 10
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import shutil
import statistics as stats
import subprocess
import sys
import threading
import time
import uuid
import winreg
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.local/benchmark-python'))
import psutil

BASE = ROOT / 'test-profiles/comparison-2026-10-19'
U = C.WinDLL('user32', use_last_error=True)
U.EnumWindows.argtypes = [C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM), W.LPARAM]
U.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
U.IsWindowVisible.argtypes = [W.HWND]
U.MoveWindow.argtypes = [W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.BOOL]
U.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
U.SetForegroundWindow.argtypes = [W.HWND]
U.BringWindowToTop.argtypes = [W.HWND]
U.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
K = C.WinDLL('kernel32')
K.GetCurrentThreadId.restype = W.DWORD
U.GetForegroundWindow.restype = W.HWND
U.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
U.SetWindowPos.argtypes = [W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT]
U.SetProcessDPIAware()

PAGE = '''<!doctype html><meta charset="utf-8"><title>ChroMinimum benchmark</title>
<style>body{margin:0;background:#10182a;color:#f0f4ff;font:16px Arial}header{padding:24px;background:#203656}
main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px}article{background:#24334b;border-radius:10px;padding:18px}
small{color:#a9c8ee}h2{font-size:18px}</style><header><h1>Browser comparison</h1>
<p>Local deterministic fixture · 200 cards · 1000 × 600 CSS px</p></header><main id="cards"></main>
<script>
const token=new URL(location).searchParams.get('token');
addEventListener('error',e=>fetch('/ready?'+new URLSearchParams({token,error:e.message})));
const cards=document.getElementById('cards');
cards.innerHTML=Array.from({length:200},(_,i)=>`<article><small>ITEM ${i+1}</small><h2>Performance sample</h2><p>One page. Same content.</p></article>`).join('');
let last='', pending=false;
function report(){if(pending)return;pending=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{
 pending=false; const value=[innerWidth,innerHeight,document.visibilityState,document.hasFocus()].join(',');
 if(value===last)return;last=value;
 fetch('/ready?'+new URLSearchParams({token,w:innerWidth,h:innerHeight,visible:document.visibilityState,
 focus:document.hasFocus(),ow:outerWidth,oh:outerHeight,cards:cards.children.length,dpr:devicePixelRatio,ua:navigator.userAgent}),{cache:'no-store'});
}));}
addEventListener('resize',report);addEventListener('focus',report);addEventListener('blur',report);
document.addEventListener('visibilitychange',report);report();
</script>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        parsed = urlparse(self.path)
        if parsed.path == '/ready':
            q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            q['received'] = time.perf_counter()
            with self.server.condition:
                self.server.messages[q.get('token')] = q
                self.server.condition.notify_all()
            data = b'ok'
        else:
            data = PAGE.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def processes(exe):
    found = []
    for p in psutil.process_iter(['exe']):
        if p.info['exe'] and os.path.normcase(p.info['exe']) == os.path.normcase(str(exe)):
            found.append(p)
    return found


def windows(pids):
    result = []
    @C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def visit(hwnd, _):
        pid = W.DWORD()
        U.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if pid.value in pids and U.IsWindowVisible(hwnd):
            result.append(hwnd)
        return True
    U.EnumWindows(visit, 0)
    return result


def foreground(hwnd):
    other = U.GetWindowThreadProcessId(U.GetForegroundWindow(), None)
    own = K.GetCurrentThreadId()
    attached = bool(other and other != own and U.AttachThreadInput(own, other, True))
    try:
        U.BringWindowToTop(hwnd)
        U.SetForegroundWindow(hwnd)
    finally:
        if attached:
            U.AttachThreadInput(own, other, False)


def snapshot(exe):
    rows = []
    for p in processes(exe):
        try:
            m, t = p.memory_info(), p.cpu_times()
            rows.append({'pid': p.pid, 'created': p.create_time(), 'private': m.private,
                         'working_set': m.rss, 'cpu': t.user + t.system,
                         'parent': p.ppid(), 'command': p.cmdline()})
        except psutil.NoSuchProcess:
            continue
    if not rows:
        raise RuntimeError('Browser has no live processes')
    return rows


def close(exe):
    for hwnd in windows({p.pid for p in processes(exe)}):
        U.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE, no force termination
    deadline = time.monotonic() + 30
    while processes(exe):
        if time.monotonic() > deadline:
            raise RuntimeError(f'Browser did not exit normally: {exe}')
        time.sleep(.1)


def trial(server, name, exe, dest, outer, out):
    if processes(exe):
        raise RuntimeError(f'Close this test browser before running: {exe}')
    source = BASE / 'baseline-initialized' / name
    target = dest / ('profile' if name == 'chrominimum' else 'user-data')
    shutil.copytree(source, target)  # unique destination; never delete profiles
    token = uuid.uuid4().hex
    url = f'http://127.0.0.1:{server.server_port}/?token={token}'
    env = os.environ.copy()
    env.pop('CHROMINIMUM_DATA_DIR', None)
    if name == 'chrominimum':
        env['CHROMINIMUM_DATA_DIR'] = str(dest)
        args = [str(exe), '--url=' + url]
    else:
        args = [str(exe), '--user-data-dir=' + str(target), '--new-window', url]
    start = time.perf_counter()
    log = (out / (dest.name + '.log')).open('w')
    subprocess.Popen(args, env=env, stdout=log, stderr=log)
    try:
        deadline, hwnd, last_adjust = start + 30, None, 0
        while time.perf_counter() < deadline:
            if hwnd is None:
                ws = windows({p.pid for p in processes(exe)})
                if ws:
                    hwnd = ws[0]
                    if not U.MoveWindow(hwnd, 20, 20, *outer, True):
                        raise C.WinError(C.get_last_error())
                    # Keep the fixture unobscured even if the host app gets focus.
                    if not U.SetWindowPos(hwnd, W.HWND(-1), 0, 0, 0, 0, 0x0003):
                        raise C.WinError(C.get_last_error())
                    foreground(hwnd)
            with server.condition:
                msg = server.messages.get(token)
                if msg and hwnd:
                    if 'error' in msg:
                        raise RuntimeError(f'Fixture JavaScript error: {msg}')
                    w, h = int(msg['w']), int(msg['h'])
                    if w == 1000 and h == 600 and msg['visible'] == 'visible':
                        break
                    # Only calibration trials may correct the viewport.
                    if dest.name.startswith('calibrate') and time.perf_counter()-last_adjust > .2 and (int(msg['ow']),int(msg['oh'])) == outer:
                        outer = (outer[0] + 1000 - w, outer[1] + 600 - h)
                        U.MoveWindow(hwnd, 20, 20, *outer, True)
                        foreground(hwnd)
                        last_adjust = time.perf_counter()
                server.condition.wait(.02)
        else:
            raise RuntimeError(f'{name}: ready timeout, last message={msg if "msg" in locals() else None}; recent requests={server.requests[-8:]}')
        if msg['cards'] != '200':
            raise RuntimeError('Wrong fixture content')
        startup_ms = (msg['received'] - start) * 1000
        time.sleep(5)
        samples, cpu_map, cpu_seconds = [], {}, 0.0
        begin = time.perf_counter()
        system_start = psutil.cpu_times()
        for index in range(6):
            rows = snapshot(exe)
            if not any('--type=renderer' in row['command'] for row in rows):
                raise RuntimeError('Renderer missing during resource sampling')
            now = time.perf_counter()
            current = {(r['pid'], r['created']): r['cpu'] for r in rows}
            if index:
                # New processes contribute their lifetime CPU; exited ones may be missed.
                cpu_seconds += sum(max(0, value - cpu_map.get(key, 0)) for key, value in current.items())
            cpu_map = current
            latest = server.messages[token]
            if (latest['w'],latest['h'],latest['visible']) != ('1000','600','visible'):
                raise RuntimeError(f'Viewport changed during idle: {latest}')
            samples.append({'seconds': now-begin, 'private_mib': sum(r['private'] for r in rows)/2**20,
                            'working_set_sum_mib': sum(r['working_set'] for r in rows)/2**20,
                            'foreground': U.GetForegroundWindow() == hwnd, 'processes': rows})
            if index < 5:
                time.sleep(1)
        system_end = psutil.cpu_times()
        elapsed = time.perf_counter() - begin
        system_total = sum(getattr(system_end,k)-getattr(system_start,k) for k in ('user','system','idle'))
        system_idle = system_end.idle - system_start.idle
        result = {'browser': name, 'startup_ms': startup_ms, 'ready': msg,
                  'outer': outer, 'samples': samples, 'command': args,
                  'idle_private_mib': stats.median(s['private_mib'] for s in samples),
                  'idle_working_set_sum_mib': stats.median(s['working_set_sum_mib'] for s in samples),
                  'idle_cpu_machine_percent': 100*cpu_seconds/elapsed/psutil.cpu_count(),
                  'system_cpu_percent': 100*(1-system_idle/system_total),
                  'cpu_interval_seconds': elapsed}
        return result
    finally:
        close(exe)
        log.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runs', type=int, default=10)
    parser.add_argument('--output', default='.local/browser-benchmark-2026-10-20')
    parser.add_argument('--resume', action='store_true', help='Continue successful runs after a rejected attempt; keep its files')
    args = parser.parse_args()
    if args.runs < 1:
        parser.error('runs must be positive')
    out = ROOT / args.output
    out.mkdir(parents=True, exist_ok=args.resume)
    paths = {'chrome': BASE/'browsers/chrome/Chrome-bin/chrome.exe',
             'ungoogled-chromium': BASE/'browsers/ungoogled-chromium/ungoogled-chromium_155.0.8059.79-1.1_windows_x64/chrome.exe',
             'chrominimum': BASE/'chrominimum/chrominimum.exe'}
    for exe in paths.values():
        if not exe.is_file() or processes(exe):
            raise RuntimeError(f'Executable missing or already running: {exe}')
    meta = {'os': platform.platform(), 'cpu': platform.processor(), 'logical_cpus': psutil.cpu_count(),
            'physical_cpus': psutil.cpu_count(logical=False), 'ram_bytes': psutil.virtual_memory().total,
            'python': sys.version, 'psutil': psutil.__version__, 'runs': args.runs,
            'executables': {k: {'path': str(v), 'sha256': hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in paths.items()},
            'fixture_sha256': hashlib.sha256(PAGE.encode()).hexdigest(),
            'power': str(psutil.sensors_battery()), 'started': time.strftime('%Y-%m-%d %H:%M:%S%z')}
    power_raw = subprocess.run(['powercfg','/getactivescheme'],capture_output=True).stdout
    try:
        meta['power_plan'] = power_raw.decode('utf-8').strip()
    except UnicodeDecodeError:
        meta['power_plan'] = power_raw.decode('oem',errors='replace').strip()
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:
        meta['cpu_model'] = winreg.QueryValueEx(key,'ProcessorNameString')[0].strip()
    meta['engine_sha256'] = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (BASE/'chrominimum').glob('*.dll')}
    if args.resume:
        previous = json.loads((out/'metadata.json').read_text(encoding='utf-8'))
        for key in ('executables','fixture_sha256','runs','engine_sha256'):
            if meta[key] != previous[key]:
                raise RuntimeError(f'Cannot resume: {key} changed')
        previous.setdefault('resumed_at',[]).append(meta['started'])
        meta = previous
    (out/'metadata.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    (out/'fixture.html').write_text(PAGE, encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.condition, server.messages, server.requests = threading.Condition(), {}, []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = json.loads((out/'results.json').read_text(encoding='utf-8')) if args.resume and (out/'results.json').exists() else []
    calibrated = {}
    try:
        for name, exe in paths.items():
            if args.resume and (out/f'calibrate-{name}.json').exists():
                calibrated[name] = tuple(json.loads((out/f'calibrate-{name}.json').read_text(encoding='utf-8'))['outer'])
                continue
            r = trial(server, name, exe, out/f'calibrate-{name}', (1100,760), out)
            calibrated[name] = r['outer']
            (out/f'calibrate-{name}.json').write_text(json.dumps(r, indent=2), encoding='utf-8')
            print(f'Calibration {name}: {r["ready"]["w"]}x{r["ready"]["h"]}, outer={r["outer"]}', flush=True)
        names = list(paths)
        for iteration in range(args.runs):
            # Rotate ABC/BCA/CAB to reduce order bias; no parallel browsers.
            order = names[iteration%3:] + names[:iteration%3]
            for name in order:
                if any(r['browser']==name and r['iteration']==iteration+1 for r in results):
                    continue
                dest = out/f'run-{iteration+1:02}-{name}'
                if dest.exists():
                    dest = out/(dest.name+'-retry-'+uuid.uuid4().hex[:8])
                try:
                    r = trial(server, name, paths[name], dest, calibrated[name], out)
                except Exception as error:
                    failure_file = out/'failed-attempts.json'
                    failures = json.loads(failure_file.read_text(encoding='utf-8')) if failure_file.exists() else []
                    failures.append({'browser':name,'iteration':iteration+1,'directory':dest.name,
                                     'error':str(error),'time':time.strftime('%Y-%m-%d %H:%M:%S%z')})
                    failure_file.write_text(json.dumps(failures,indent=2),encoding='utf-8')
                    raise
                r['iteration'] = iteration+1
                results.append(r)
                (out/'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
                print(f'{iteration+1}/{args.runs} {name}: {r["startup_ms"]:.0f} ms; {r["idle_private_mib"]:.1f} MiB private; CPU {r["idle_cpu_machine_percent"]:.3f}%', flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
