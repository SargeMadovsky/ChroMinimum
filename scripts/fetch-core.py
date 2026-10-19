"""Get latest stable CEF metadata and overlay its runtime into fresh CI staging.

Never extracts arbitrary archive paths or modifies installed/user runtime files.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import time
import tarfile
import urllib.error
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--bundle', required=True)
p.add_argument('--sequence', type=int, required=True)
p.add_argument('--skip-unchanged', action='store_true')
p.add_argument('--version', help='Explicit stable version for disposable compatibility tests only')
a = p.parse_args()
bundle = pathlib.Path(a.bundle).resolve()
project = pathlib.Path(__file__).resolve().parent.parent
assert bundle.is_relative_to(project / 'target') and bundle != project / 'target'
assert (bundle / 'core' / 'seed' / 'chrominimum.dll').is_file()
assert not (bundle / 'core' / 'seed' / 'core-running.lock').exists(), 'Use fresh staging, not a previously launched runtime'
with urllib.request.urlopen('https://cef-builds.spotifycdn.com/index.json', timeout=60) as stream:
    index = json.loads(stream.read(30 * 1024 * 1024))
versions = [v for v in index['windows64']['versions']
            if v['channel'] == 'stable' and re.match(r'^\d+\.\d+\.\d+\+', v['cef_version'])]
versions.sort(key=lambda v: tuple(map(int, re.match(r'^(\d+)\.(\d+)\.(\d+)', v['cef_version']).groups())), reverse=True)
version = next(v for v in versions if v['cef_version'] == a.version) if a.version else versions[0]
if a.skip_unchanged:
    try:
        with urllib.request.urlopen('https://github.com/SargeMadovsky/ChroMinimum/releases/download/core-windows-x64/core-update.json', timeout=60) as response:
            cached = response.read(16 * 1024 + 1)
        receipt = bundle / 'previous-core-metadata.json'
        receipt.write_bytes(cached)
        checked = subprocess.run(['updater/target/release/cm-update.exe', '--inspect', str(receipt)], check=True, capture_output=True, text=True)
        previous = json.loads(checked.stdout)
        if previous['engine_version'] == version['cef_version'] and previous['expires'] > time.time() + 7 * 86400:
            (bundle / 'candidate-needed.txt').write_text('false')
            print('Already published and metadata is fresh:', version['cef_version'])
            raise SystemExit(0)
        assert a.sequence > previous['sequence'], 'Workflow sequence must increase'
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
(bundle / 'candidate-needed.txt').write_text('true')
archive_info = next(f for f in version['files'] if f['type'] == 'minimal')
assert re.fullmatch(r'[A-Za-z0-9_.+\-]+\.tar\.bz2', archive_info['name'])
assert 0 < archive_info['size'] < 512 * 1024 * 1024
archive = bundle.parent / f'cef-candidate-{a.sequence}.tar.bz2'
sha1 = hashlib.sha1()
size = 0
with urllib.request.urlopen('https://cef-builds.spotifycdn.com/' + archive_info['name'], timeout=120) as stream, archive.open('xb') as out:
    while block := stream.read(1024 * 1024):
        size += len(block)
        if size > archive_info['size']:
            raise ValueError('CEF archive size exceeded')
        sha1.update(block)
        out.write(block)
assert size == archive_info['size'] and sha1.hexdigest() == archive_info['sha1']
runtime = bundle / 'core' / 'seed'
# Fresh staging only; preserve the compiled adapter, replace old CEF resources.
for file in runtime.rglob('*'):
    if file.is_symlink():
        raise ValueError('Symlink in runtime staging')
    if file.is_file() and file.name != 'chrominimum.dll' and file.suffix in {'.dll', '.exe', '.bin', '.dat', '.pak', '.json'}:
        file.unlink()
files = 0
with tarfile.open(archive, 'r:bz2') as tar:
    for entry in tar:
        parts = pathlib.PurePosixPath(entry.name).parts
        if entry.isfile() and len(parts) == 2 and parts[1] in ('CREDITS.html', 'LICENSE.txt'):
            assert entry.size <= 12 * 1024 * 1024, 'Unexpectedly large CEF license file'
            with tar.extractfile(entry) as source:
                (runtime / parts[1]).write_bytes(source.read(12 * 1024 * 1024))
            continue
        if not entry.isfile() or len(parts) < 3:
            continue
        section = parts[1]
        relative = pathlib.PurePosixPath(*parts[2:])
        destination = None
        if section == 'Release' and len(relative.parts) == 1 and (relative.suffix in {'.dll', '.exe', '.bin'}):
            destination = runtime / ('chrominimum.exe' if relative.name == 'bootstrap.exe' else relative.name)
            if relative.suffix == '.exe' and relative.name != 'bootstrap.exe':
                destination = None
        elif section == 'Resources' and all(p not in ('..', '.') for p in relative.parts):
            destination = runtime.joinpath(*relative.parts)
        if destination:
            assert destination.resolve().is_relative_to(runtime)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(entry) as source, destination.open('wb') as out:
                while block := source.read(1024 * 1024):
                    out.write(block)
            files += 1
assert files > 10 and (runtime / 'libcef.dll').is_file()
(bundle / 'candidate-version.txt').write_text(version['cef_version'], encoding='utf-8')
print('Candidate CEF:', version['cef_version'])
