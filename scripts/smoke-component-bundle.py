"""Exercise an assembled Windows bundle with a fresh test profile.

Run outside the agent's restricted environment. Never changes the input bundle.
PDF cases confirm loading, not visual rendering or PDF toolbar interactions.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import shutil
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def hashes(bundle):
    result = {}
    for file in sorted(bundle.rglob('*')):
        if file.is_file():
            if file.parent == bundle and file.name == 'core-running.lock' and file.stat().st_size == 0 and not file.is_symlink():
                continue
            with file.open('rb') as stream:
                result[file.relative_to(bundle).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--case', choices=['html', 'html-file', 'pdf-http', 'pdf-file', 'locale'], required=True)
    p.add_argument('--launcher', type=Path)
    p.add_argument('--installed-launcher', type=Path, help='Installed format=1 launcher; isolated data-dir only')
    p.add_argument('--installation-root', type=Path)
    p.add_argument('--expected-locale', choices=['ru', 'en-US'])
    p.add_argument('--net-log', action='store_true', help='Collect CEF NetLog in this test profile')
    p.add_argument('--startup-trace', action='store_true', help='Collect CEF startup trace in this test profile')
    p.add_argument('--clone-test-profile', type=Path, help='Clone profile-smoke from a completed successful run')
    p.add_argument('--first-response-delay', type=float, default=0,
                   help='Controlled delay of the first HTML response, seconds (0..25)')
    a = p.parse_args()
    if bool(a.launcher) != bool(a.installation_root):
        p.error('launcher and installation-root must be supplied together')
    if a.installed_launcher and a.launcher:
        p.error('choose installed-launcher or modular launcher')
    if not 0 <= a.first_response_delay <= 25:
        p.error('first-response-delay must be between 0 and 25')
    bundle, output = a.bundle.resolve(strict=True), a.output.resolve()
    if bundle == output or bundle in output.parents or output.exists():
        raise ValueError('Output must be new and outside the assembled bundle')
    output.mkdir(parents=True)
    if a.clone_test_profile:
        previous = a.clone_test_profile.resolve(strict=True)
        prior_result = json.loads((previous / 'result.json').read_text(encoding='utf-8'))
        if prior_result.get('passed') is not True:
            raise ValueError('Profile source must be a completed successful smoke run')
        shutil.copytree(previous / 'profile-smoke', output / 'profile-smoke')
    before = hashes(bundle)
    requests = []
    connections = []
    localized = []
    fixtures = ROOT / 'tests/fixtures'

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            connections.append(dict(port=self.client_address[1], accepted_seconds=round(time.monotonic() - start, 3)))

        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/locale-evidence' or not 0 < length <= 4096:
                self.send_error(400)
                return
            localized.append(json.loads(self.rfile.read(length)))
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            name = self.path.split('?', 1)[0].removeprefix('/')
            if name not in {'smoke.html', 'navigation.html', 'smoke.pdf', 'locale.html'}:
                requests.append(dict(path=name, status=404))
                self.send_error(404)
                return
            data = (b'<!doctype html><meta charset="utf-8"><input id="field" required>'
                    b'<script>fetch("/locale-evidence",{method:"POST",body:JSON.stringify({'
                    b'message:document.getElementById("field").validationMessage,language:navigator.language})})'
                    b'.then(r=>{if(r.ok)document.title="ChroMinimum smoke JS OK"})</script>') if name == 'locale.html' else (fixtures / name).read_bytes()
            requests.append(dict(path=name, bytes=len(data), received_seconds=round(time.monotonic() - start, 3)))
            if name == 'smoke.html' and a.first_response_delay and not any(r.get('delayed') for r in requests):
                requests[-1]['delayed'] = True
                time.sleep(a.first_response_delay)
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf' if name.endswith('.pdf') else 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

        def log_error(self, message, *args):
            requests.append(dict(server_error=message % args))

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = (fixtures / ('smoke.html' if a.case == 'html-file' else 'smoke.pdf')).as_uri() if a.case in {'html-file', 'pdf-file'} else (
        f'http://127.0.0.1:{server.server_port}/' + ('locale.html' if a.case == 'locale' else 'smoke.html' if a.case == 'html' else 'smoke.pdf'))
    env = os.environ.copy()
    env['CHROMINIMUM_DATA_DIR'] = str(output)
    start = time.monotonic()
    timeline = []
    stop = threading.Event()

    def observe_log():
        count = 0
        while True:
            log = output / 'smoke.log'
            lines = log.read_text(encoding='utf-8').splitlines() if log.exists() else []
            for line in lines[count:]:
                timeline.append(dict(seconds=round(time.monotonic() - start, 3), event=line))
            count = len(lines)
            if stop.wait(0.05):
                break

    observer = threading.Thread(target=observe_log, daemon=True)
    observer.start()
    arguments = [str(bundle / 'chrominimum.exe')]
    if a.launcher:
        arguments = [str(a.launcher.resolve(strict=True)), '--launch-components', str(a.installation_root.resolve(strict=True))]
    elif a.installed_launcher:
        arguments = [str(a.installed_launcher.resolve(strict=True))]
    process = subprocess.Popen(arguments + ['--smoke-test', '--url=' + url]
                               + (['--test-net-log'] if a.net_log else [])
                               + (['--test-startup-trace'] if a.startup_trace else []), env=env)
    timed_out = False
    try:
        process.wait(timeout=90 if a.case in {'html', 'html-file'} else 60)
    except subprocess.TimeoutExpired:
        timed_out = True  # Leave the process available for diagnosis; do not kill user processes.
    finally:
        server.shutdown()
        server.server_close()
        stop.set()
        observer.join()
    log = output / 'smoke.log'
    evidence = log.read_text(encoding='utf-8') if log.exists() else ''
    required = ['engine_version=154.0.34', 'sandbox_requested=true', 'toolbar_created', 'browser_created',
                'main_frame_loaded; status=200', 'browser_closed', 'shutdown_complete']
    if a.case in {'html', 'html-file'}:
        required += ['fixture_javascript_ok', 'navigation_controls_drawn', 'address_enter_navigated',
                     'back_button_navigated', 'forward_button_navigated', 'reload_button_navigated',
                     'window_resized', 'window_maximized', 'window_restored', 'window_minimized',
                     'window_returned_to_normal']
    if a.launcher:
        required += ['component_readiness_reported']
    if a.expected_locale:
        required += [('installed_locale=' if a.installed_launcher else 'component_locale=') + a.expected_locale]
    if a.case == 'locale':
        required += ['fixture_javascript_ok']
    after = hashes(bundle)
    cef_log = output / 'cef.log'
    cef = cef_log.read_text(encoding='utf-8', errors='replace') if cef_log.exists() else ''
    missing = [item for item in required if item not in evidence]
    served = a.case in {'html-file', 'pdf-file'} or any(r.get('path') == ('locale.html' if a.case == 'locale' else 'smoke.html' if a.case == 'html' else 'smoke.pdf') for r in requests)
    report = dict(case=a.case, url=url, pid=process.pid, exit_code=process.returncode, timed_out=timed_out,
                  duration_seconds=round(time.monotonic() - start, 3), missing=missing,
                  bundle_unchanged=before == after, requests=requests, evidence=evidence,
                  fatal_log='FATAL:' in cef, timeline=timeline)
    report['first_response_delay'] = a.first_response_delay
    report['connections'] = connections
    report['net_log_requested'] = a.net_log
    report['startup_trace_requested'] = a.startup_trace
    report['cloned_test_profile'] = str(a.clone_test_profile.resolve()) if a.clone_test_profile else None
    report['localized_evidence'] = localized
    locale_ok = True
    if a.case == 'locale' and a.expected_locale:
        expected = 'заполн' if a.expected_locale == 'ru' else 'fill out'
        locale_ok = bool(localized) and all(expected in item.get('message', '').lower() for item in localized)
    report['passed'] = (not timed_out and process.returncode == 0 and not missing and before == after
                        and served and locale_ok and not report['fatal_log'] and 'main_frame_error;' not in evidence)
    (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
