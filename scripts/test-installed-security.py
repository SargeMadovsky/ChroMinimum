"""Isolated installed-browser checks: invalid TLS, valid HTTPS and actual Windows tokens."""
import argparse
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def run_browser(launcher, output, url, probe=False, include_root=False):
    output.mkdir()
    env = os.environ.copy()
    env['CHROMINIMUM_DATA_DIR'] = str(output)
    process = subprocess.Popen([str(launcher), '--smoke-test', '--test-net-log', '--url=' + url], env=env)
    tokens = None
    if probe:
        deadline = time.monotonic() + 15
        log = output / 'smoke.log'
        while time.monotonic() < deadline:
            if log.exists() and 'main_frame_loaded;' in log.read_text(encoding='utf-8'):
                break
            time.sleep(0.05)
        else:
            raise AssertionError('Page did not load before token observation')
        shell = shutil.which('pwsh')
        if not shell:
            raise RuntimeError('PowerShell 7 is required for the read-only token probe')
        token_command = [shell, '-NoProfile', '-File', str(ROOT / 'scripts/inspect-test-process-tokens.ps1'),
                         '-RootProcessId', str(process.pid)]
        if include_root:
            token_command.append('-IncludeRoot')
        observed = subprocess.run(token_command, capture_output=True, text=True, check=True, timeout=15)
        tokens = json.loads(observed.stdout)
        (output / 'tokens.json').write_text(json.dumps(tokens, indent=2), encoding='utf-8')
    process.wait(timeout=65)
    evidence = (output / 'smoke.log').read_text(encoding='utf-8')
    assert process.returncode == 0
    assert all(marker in evidence for marker in ('sandbox_requested=true', 'browser_created', 'browser_closed', 'shutdown_complete'))
    assert 'FATAL:' not in (output / 'cef.log').read_text(encoding='utf-8', errors='replace')
    return evidence, tokens


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--launcher', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--openssl', type=Path, required=True)
    p.add_argument('--only-tokens', action='store_true', help='Observe token roles without repeating TLS cases')
    p.add_argument('--direct-bootstrap', action='store_true', help='Include root CEF browser token when bypassing the updater launcher')
    p.add_argument('--require-network-sandbox', action='store_true', help='Fail unless NetworkService uses Low AppContainer and sandbox type network')
    a = p.parse_args()
    launcher = a.launcher.resolve(strict=True)
    output = a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if a.only_tokens:
        _, tokens = run_browser(launcher, output / 'tokens', (ROOT / 'tests/fixtures/smoke.pdf').as_uri(), probe=True, include_root=a.direct_bootstrap)
        browser = [t for t in tokens if t['Role'] == 'browser' and t['Error'] == 0]
        renderers = [t for t in tokens if t['Role'] == 'renderer' and t['Error'] == 0]
        assert len(browser) == 1 and renderers
        assert all(t['Restricted'] and t['IntegrityRid'] < browser[0]['IntegrityRid'] for t in renderers)
        if a.require_network_sandbox:
            check_network(tokens)
        (output / 'result.json').write_text(json.dumps(dict(tokens=tokens, full_sandbox_audit=False), indent=2), encoding='utf-8')
        print(json.dumps(tokens, indent=2))
        return
    cert, key = output / 'server.pem', output / 'server-key.pem'
    generated = subprocess.run([str(a.openssl), 'req', '-x509', '-newkey', 'rsa:2048', '-noenc',
        '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost'], capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            body = b'<!doctype html><title>Unexpected TLS bypass</title>'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        evidence, _ = run_browser(launcher, output / 'invalid-tls', f'https://localhost:{server.server_port}/')
        assert 'ERR_CERT_AUTHORITY_INVALID' in evidence
        assert not requests, 'Untrusted HTTPS must not receive any HTTP GET'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        key.unlink(missing_ok=True)
    evidence, _ = run_browser(launcher, output / 'valid-https', 'https://example.com/')
    assert 'main_frame_loaded; status=200' in evidence and 'main_frame_error;' not in evidence
    # A local document keeps token inspection independent of external service availability.
    evidence, tokens = run_browser(launcher, output / 'tokens', (ROOT / 'tests/fixtures/smoke.pdf').as_uri(), probe=True, include_root=a.direct_bootstrap)
    browsers = [t for t in tokens if t['Role'] == 'browser' and t['Error'] == 0]
    renderers = [t for t in tokens if t['Role'] == 'renderer' and t['Error'] == 0]
    assert len(browsers) == 1 and renderers, tokens
    assert all(t['Restricted'] and t['IntegrityRid'] < browsers[0]['IntegrityRid'] for t in renderers), tokens
    if a.require_network_sandbox:
        check_network(tokens)
    result = dict(invalid_certificate_rejected=True, invalid_tls_http_requests=requests,
                  valid_https_loaded=True, restricted_renderer_tokens=True, tokens=tokens,
                  full_sandbox_audit=False, user_profile_used=False)
    result['network_sandbox_required'] = a.require_network_sandbox
    (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


def check_network(tokens):
    network = [t for t in tokens if t.get('Subtype') == 'network.mojom.NetworkService']
    assert network and all(t['Error'] == 0 and t['SandboxType'] == 'network'
                          and t['AppContainer'] == 1 and t['IntegrityRid'] <= 4096 for t in network), tokens


if __name__ == '__main__':
    main()
