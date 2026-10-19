"""Stage only release files; never include browser profiles, caches or logs."""
import argparse
import hashlib
import pathlib
import platform
import shutil
import tarfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--name', required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
dist = root / 'dist'
stage = dist / args.name
stage.mkdir(parents=True, exist_ok=False)
bundle = root / 'target' / 'release-bundle'
is_mac = platform.system() == 'Darwin'
if is_mac:
    shutil.copytree(bundle / 'chrominimum.app', stage / 'chrominimum.app', symlinks=True)
else:
    managed = (bundle / 'core' / 'seed').is_dir()
    for file in bundle.iterdir():
        if file.is_file() and file.suffix.lower() not in {'.log', '.pdb'} and (not managed or file.name == 'chrominimum.exe'):
            shutil.copy2(file, stage / file.name)
    if (bundle / 'locales').is_dir():
        shutil.copytree(bundle / 'locales', stage / 'locales')
    if (bundle / 'core' / 'seed').is_dir():
        shutil.copytree(bundle / 'core' / 'seed', stage / 'core' / 'seed',
                        ignore=shutil.ignore_patterns('*.pdb', '*.log', 'profile*', 'core-running.lock'))
        shutil.copy2(dist / 'LICENSES-UPDATER.html', stage / 'LICENSES-UPDATER.html')
for name in ('LICENSE', 'README.md', 'THIRD_PARTY.md'):
    shutil.copy2(root / name, stage / name)
shutil.copytree(root / 'third_party', stage / 'third_party')
shutil.copy2(dist / 'LICENSES-RUST.html', stage / 'LICENSES-RUST.html')
# CREDITS.html is supplied by the pinned CEF binary distribution.
credits = [bundle / 'core' / 'seed' / 'CREDITS.html'] if (bundle / 'core' / 'seed').is_dir() else list(bundle.rglob('CREDITS.html'))
if not credits:
    raise SystemExit('CEF/Chromium CREDITS.html missing: refusing incomplete release')
shutil.copy2(credits[0], stage / 'CREDITS.html')
for path in stage.rglob('*'):
    if path.name.startswith('profile') or path.suffix.lower() == '.log':
        raise SystemExit(f'Unexpected private state in release: {path}')
if platform.system() == 'Windows':
    archive = dist / f'{args.name}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as out:
        for path in stage.rglob('*'):
            if path.is_file():
                out.write(path, path.relative_to(dist))
else:
    archive = dist / f'{args.name}.tar.gz'
    with tarfile.open(archive, 'w:gz', dereference=False) as out:
        out.add(stage, arcname=stage.name)
digest = hashlib.sha256()
with archive.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
digest = digest.hexdigest()
archive.with_name(archive.name + '.sha256').write_text(f'{digest}  {archive.name}\n')
print(archive)
