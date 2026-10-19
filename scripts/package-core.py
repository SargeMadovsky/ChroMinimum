"""Build a complete Windows core archive and unsigned metadata for signing."""
import argparse
import hashlib
import json
import pathlib
import tarfile
import time

p = argparse.ArgumentParser()
p.add_argument('--bundle', required=True)
p.add_argument('--output', required=True)
p.add_argument('--sequence', type=int, required=True)
p.add_argument('--min-safe-sequence', type=int, required=True)
p.add_argument('--engine-version', required=True)
p.add_argument('--shell-version', default='0.0.1')
p.add_argument('--release-tag', required=True)
p.add_argument('--licenses', default='dist/LICENSES-RUST.html')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
bundle = pathlib.Path(a.bundle).resolve()
output = pathlib.Path(a.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
assert 0 <= a.min_safe_sequence <= a.sequence and a.sequence > 0
with tarfile.open(output, 'x:gz') as archive:
    for file in sorted(bundle.rglob('*')):
        relative = file.relative_to(bundle)
        if file.is_symlink():
            raise ValueError('Symlinks are not permitted')
        if not file.is_file() or file.suffix in {'.pdb', '.log', '.lib'} or file.name == 'core-running.lock':
            continue
        if any(part.startswith('profile') for part in relative.parts):
            raise ValueError('Private profile in core staging')
        archive.add(file, arcname=relative.as_posix(), recursive=False)
    archive.add(a.licenses, arcname='LICENSES-RUST.html', recursive=False)
    for name in ('LICENSE', 'THIRD_PARTY.md'):
        archive.add(root / name, arcname=name, recursive=False)
    for file in sorted((root / 'third_party').rglob('*')):
        if file.is_file():
            archive.add(file, arcname=file.relative_to(root).as_posix(), recursive=False)
digest = hashlib.sha256()
with output.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
timestamp = int(time.time())
manifest = dict(format=1, sequence=a.sequence, min_safe_sequence=a.min_safe_sequence,
                platform='windows-x64', launcher_api=1, shell_version=a.shell_version,
                engine_version=a.engine_version, issued=timestamp, expires=timestamp + 30 * 86400,
                url=f'https://github.com/SargeMadovsky/ChroMinimum/releases/download/{a.release_tag}/{output.name}',
                size=output.stat().st_size, sha256=digest.hexdigest())
output.with_suffix('.manifest.json').write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf-8')
print(output)
