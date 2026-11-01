"""Measure locale payloads and optionally smoke-test a disposable EN/RU copy.

Uses Python's standard library; never modifies the input bundle or a user profile.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--bundle', type=Path, required=True)
p.add_argument('--output', type=Path, required=True, help='New disposable directory')
p.add_argument('--smoke', action='store_true')
p.add_argument('--locale-set', choices=['en-ru', 'all'], default='en-ru')
p.add_argument('--test-cef-locale', choices=['en-US', 'ru'])
p.add_argument('--adapter', type=Path, help='New test DLL built from current sources')
a = p.parse_args()
source = a.bundle.resolve(strict=True)
output = a.output.resolve()
if output.exists() or source == output or source in output.parents:
    raise SystemExit('Output must be a new directory outside the input bundle')
locales = sorted((source / 'locales').glob('*.pak'))
if not locales:
    raise SystemExit('No locale packs found')
selected = [f for f in locales if f.stem.split('_')[0] in {'en-US', 'ru'}]
if not {'en-US.pak', 'ru.pak'} <= {f.name for f in selected}:
    raise SystemExit('EN/RU packs missing')
output.mkdir(parents=True)

def measure(files):
    # Same gzip settings for comparison; this is not the updater tar.gz size.
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode='wb', compresslevel=6, mtime=0) as zipped:
        for file in files:
            zipped.write(file.read_bytes())
    return dict(files=len(files), bytes=sum(f.stat().st_size for f in files),
                gzip_payload_bytes=len(stream.getvalue()))

result = dict(source=str(source), all_locales=measure(locales),
              en_ru=measure(selected), en_only=measure([f for f in selected if f.stem.split('_')[0] == 'en-US']),
              selected=[f.name for f in selected],
              libcef_sha256=hashlib.file_digest((source / 'libcef.dll').open('rb'), 'sha256').hexdigest())
if a.smoke:
    bundle = output / 'bundle'
    bundle.mkdir()
    for file in source.iterdir():
        if file.is_file() and file.suffix not in {'.pdb', '.lib', '.log'} and file.name != 'core-running.lock':
            shutil.copy2(file, bundle / file.name)
    (bundle / 'locales').mkdir()
    if a.adapter:
        shutil.copy2(a.adapter.resolve(strict=True), bundle / 'chrominimum.dll')
    for file in (locales if a.locale_set == 'all' else selected):
        shutil.copy2(file, bundle / 'locales' / file.name)
    fixture = output / 'locale-check.html'
    fixture.write_text('<!doctype html><meta charset="utf-8"><title>Loading</title>'
                       '<p>Русский English 日本語 العربية</p>'
                       '<input id="required" required><script>'
                       'fetch("/evidence",{method:"POST",body:JSON.stringify({'
                       'validationMessage:document.getElementById("required").validationMessage,'
                       'language:navigator.language})}).then(r=>{if(r.ok)'
                       'document.title="ChroMinimum smoke JS OK"});</script>', encoding='utf-8')
    env = os.environ.copy()
    env['CHROMINIMUM_DATA_DIR'] = str(output / 'test-data')
    localized = []
    class FixtureHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            size = int(self.headers.get('Content-Length', '0'))
            if self.path != '/evidence' or not 0 < size <= 4096:
                self.send_error(400)
                return
            localized.append(json.loads(self.rfile.read(size)))
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            body = fixture.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        arguments = [str(bundle / 'chrominimum.exe'), '--smoke-test',
                     f'--url=http://127.0.0.1:{server.server_port}/locale-check.html']
        if a.test_cef_locale:
            arguments.append('--test-cef-locale=' + a.test_cef_locale)
        run = subprocess.run(arguments,
                             env=env, timeout=60)
    finally:
        server.shutdown()
        server.server_close()
    evidence = (output / 'test-data' / 'smoke.log').read_text(encoding='utf-8')
    required = ['engine_version=154.0.34', 'toolbar_created', 'browser_created',
                'fixture_javascript_ok', 'main_frame_loaded; status=200',
                'browser_closed', 'shutdown_complete']
    result['locale_set'] = a.locale_set
    result['localized_evidence'] = localized
    if a.test_cef_locale:
        required.append('test_cef_locale=' + a.test_cef_locale)
        expected = 'заполн' if a.test_cef_locale == 'ru' else 'fill out'
        result['localized_message_passed'] = bool(localized) and all(
            expected in item.get('validationMessage', '').lower() for item in localized)
    result['smoke'] = dict(exit_code=run.returncode,
                           passed=run.returncode == 0 and all(x in evidence for x in required)
                           and 'main_frame_error;' not in evidence, evidence=evidence)
    result['smoke']['passed'] &= result.get('localized_message_passed', True)
    result['copy_libcef_sha256'] = hashlib.file_digest((bundle / 'libcef.dll').open('rb'), 'sha256').hexdigest()
(output / 'audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
if a.smoke and not result['smoke']['passed']:
    raise SystemExit('Smoke did not pass; inspect disposable evidence')
