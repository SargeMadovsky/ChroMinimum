"""Negative test: missing runtime AppContainer access must not become unsandboxed networking."""
import argparse
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-root', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--inventory', type=Path, default=ROOT / '.local/installer-final-payload-2026-10-20/payload-inspection.json')
    a = p.parse_args()
    output = a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    app = output / 'private-runtime'
    inventory = json.loads(a.inventory.read_text())
    for name in [*inventory, 'installation.json']:
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        source, target = a.source_root / relative, app / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Copy bytes only, deliberately do not copy the source's granted ACL.
        with source.open('rb') as incoming, target.open('xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = os.environ.copy()
    data = output / 'test-data'
    env['CHROMINIMUM_DATA_DIR'] = str(data)
    try:
        process = subprocess.run([str(app / 'chrominimum.exe'), '--smoke-test',
            f'--url=http://127.0.0.1:{server.server_port}/'], env=env, timeout=30)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    evidence = (data / 'smoke.log').read_text(encoding='utf-8')
    assert process.returncode == 1, process.returncode
    assert 'network_sandbox_refused' in evidence, evidence
    assert not requests, requests
    result = dict(exit_code=process.returncode, unsafe_fallback_refused=True, http_requests=requests,
                  expected_abrupt_security_exit=True)
    (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
