"""Compare staged CEF runtimes on fresh profiles; no personal data or UI input.

Uses the existing benchmark-only psutil installation, not an app dependency.
Startup means completion of a loopback JavaScript callback, not first paint.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.local/benchmark-python'))
import psutil

PAGE = b'''<!doctype html><title>Runtime variant measurement</title><p>Local fixture</p>
<script>fetch('/ready'+location.search,{cache:'no-store'});</script>'''


def artifact(file):
    with file.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return dict(path=str(file), bytes=file.stat().st_size, sha256=digest)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith('/ready?'):
            with self.server.condition:
                self.server.ready[self.path.split('?', 1)[1]] = time.perf_counter()
                self.server.condition.notify_all()
            data = b'ok'
        else:
            data = PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


def trial(exe, directory, server):
    directory.mkdir()
    token = uuid.uuid4().hex
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('CHROMINIMUM_')}
    env['CHROMINIMUM_DATA_DIR'] = str(directory)
    start = time.perf_counter()
    process = subprocess.Popen([str(exe), '--smoke-test',
                                f'--url=http://127.0.0.1:{server.server_port}/?{token}'], env=env)
    with server.condition:
        ready = server.condition.wait_for(lambda: token in server.ready, timeout=25)
    if not ready:
        raise RuntimeError(f'No JavaScript callback; diagnostic process PID {process.pid}')
    ready_at = server.ready[token]
    parent = psutil.Process(process.pid)
    seen_cpu, cumulative_cpu, samples = {}, 0.0, []
    for second in range(11):
        time.sleep(max(0, ready_at + second - time.perf_counter()))
        private, working, count = 0, 0, 0
        for child in [parent, *parent.children(recursive=True)]:
            try:
                key = (child.pid, child.create_time())
                cpu = child.cpu_times()
                total = cpu.user + cpu.system
                cumulative_cpu += max(0, total - seen_cpu.get(key, 0))
                seen_cpu[key] = total
                memory = child.memory_info()
                private += memory.private
                working += memory.rss
                count += 1
            except psutil.NoSuchProcess:
                continue
        samples.append(dict(seconds=time.perf_counter() - ready_at, private_bytes=private,
                            working_set_sum_bytes=working, processes=count, cpu_seconds=cumulative_cpu))
    process.wait(timeout=65)
    log = (directory / 'smoke.log').read_text(encoding='utf-8')
    if process.returncode != 0 or 'shutdown_complete' not in log:
        raise RuntimeError('Unclean diagnostic shutdown')
    idle = samples[5:]
    elapsed = samples[-1]['seconds'] - samples[5]['seconds']
    result = dict(startup_js_ms=(ready_at - start) * 1000,
                  idle_private_mib=statistics.median(s['private_bytes'] for s in idle) / 2**20,
                  idle_working_set_sum_mib=statistics.median(s['working_set_sum_bytes'] for s in idle) / 2**20,
                  idle_cpu_machine_percent=(samples[-1]['cpu_seconds'] - samples[5]['cpu_seconds']) /
                  elapsed / psutil.cpu_count() * 100,
                  exit_code=process.returncode, samples=samples)
    (directory / 'measurement.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.runs <= 20:
        parser.error('--runs must be between 1 and 20')
    paths = {name: path.resolve(strict=True) for name, path in
             [('stock', args.stock), ('candidate', args.candidate)]}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    metadata = dict(logical_cpus=psutil.cpu_count(), python=sys.version, psutil=psutil.__version__,
                    runs=args.runs, metric='startup to loopback JS callback; idle 5-10 seconds',
                    first_paint_measured=False, working_set_may_double_count_shared_pages=True,
                    cold_cache_controlled=False, binaries_prehashed=True,
                    machine_not_isolated=True, comparison_is_not_codec_only=True,
                    profiles='fresh for every run; no user data', artifacts={})
    for name, exe in paths.items():
        files = [exe, exe.parent / 'chrominimum.dll', exe.parent / 'libcef.dll']
        metadata['artifacts'][name] = {file.name: artifact(file) for file in files}
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.condition, server.ready = threading.Condition(), {}
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        for iteration in range(args.runs):
            for name in (['stock', 'candidate'] if iteration % 2 == 0 else ['candidate', 'stock']):
                result = trial(paths[name], output / f'{iteration + 1:02}-{name}', server)
                result.update(variant=name, iteration=iteration + 1)
                results.append(result)
                (output / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
                print(json.dumps({key: value for key, value in result.items() if key != 'samples'}), flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
