"""Build and inspect local Windows component archives. Never signs or publishes."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = {
    'chrominimum.exe', 'chrominimum.dll', 'chrominimum.exe.manifest',
    'libcef.dll', 'chrome_elf.dll', 'icudtl.dat', 'v8_context_snapshot.bin',
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
    'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'CREDITS.html',
}
LOCALES = ('en-US', 'ru')
MAX_DOWNLOAD = 512 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def locale_names(locale):
    return {f'locales/{locale}{suffix}.pak' for suffix in ('', '_FEMININE', '_MASCULINE', '_NEUTER')}


def regular(path):
    # Reject directory junctions/reparse points as well as symbolic links.
    if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400:
        raise ValueError(f'Reparse point or symlink: {path}')
    if not path.is_file():
        raise ValueError(f'Regular file required: {path}')
    for parent in path.parents:
        if parent.is_symlink() or getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Reparse parent: {parent}')


def archive(path, files):
    for source in files.values():
        regular(source)
    if sum(p.stat().st_size for p in files.values()) > MAX_EXPANDED or len(files) > 4096:
        raise ValueError('Archive input exceeds limits')
    # Stable ordering, gzip header and tar metadata; no directory/link entries.
    with path.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=6) as zipped:
            with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as out:
                for name, source in sorted(files.items()):
                    info = tarfile.TarInfo(name)
                    info.size = source.stat().st_size
                    info.mode = 0o644
                    with source.open('rb') as stream:
                        out.addfile(info, stream)
    if not 0 < path.stat().st_size <= MAX_DOWNLOAD:
        raise ValueError('Compressed package exceeds limits')


def inspect(path, expected):
    seen = set()
    total = 0
    hashes = {}
    with tarfile.open(path, 'r:gz') as package:
        for member in package:
            if not member.isfile() or member.name not in expected or member.name in seen:
                raise ValueError(f'Unexpected, duplicate or non-file entry: {member.name}')
            seen.add(member.name)
            total += member.size
            if total > MAX_EXPANDED or len(seen) > 4096:
                raise ValueError('Expanded package exceeds limits')
            stream = package.extractfile(member)
            hashes[member.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
            if hashes[member.name] != digest(expected[member.name]):
                raise ValueError(f'Archive content differs from input: {member.name}')
    if seen != set(expected):
        raise ValueError('Missing archive files')
    return dict(files=len(seen), expanded_bytes=total, sha256=digest(path),
                size=path.stat().st_size, file_sha256=hashes)


def build(bundle, output, sequence, min_safe, engine, tag, licenses, issued):
    if not 0 <= min_safe <= sequence <= 2**64 - 1 or sequence == 0:
        raise ValueError('Invalid release sequence')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', tag) or tag in {'.', '..'}:
        raise ValueError('Invalid release tag')
    if not engine or len(engine) > 160 or not all(33 <= ord(c) <= 126 for c in engine):
        raise ValueError('Invalid engine version')
    if not 0 <= issued <= 2**64 - 1 - 30 * 86400:
        raise ValueError('Invalid timestamp')
    # Do not resolve away symlinks before regular() checks the supplied inputs.
    bundle, output, licenses = Path(bundle).absolute(), Path(output).absolute(), Path(licenses).absolute()
    if bundle == output or bundle in output.parents:
        raise ValueError('Output must be outside the bundle')
    files = {name: bundle / name for name in RUNTIME}
    files['LICENSES-RUST.html'] = licenses
    for name in ('LICENSE', 'THIRD_PARTY.md'):
        files[name] = ROOT / name
    for file in (ROOT / 'third_party').rglob('*'):
        if file.is_file() or file.is_symlink():
            files[file.relative_to(ROOT).as_posix()] = file
    groups = [('core', {'kind': 'core'}, files)]
    for locale in LOCALES:
        groups.append((locale, {'kind': 'locale', 'locale': locale},
                       {name: bundle / name for name in locale_names(locale)}))
    # Validate every input before creating output. Existing output is never overwritten.
    for _, _, group in groups:
        for file in group.values():
            regular(file)
    output.mkdir(parents=True, exist_ok=False)
    adapter = None
    packages, reports = [], {}
    all_names = set()
    for label, component, group in groups:
        if all_names.intersection(group):
            raise ValueError('Component file overlap')
        all_names.update(group)
        name = f'components-{sequence}-windows-x64-{label}.tar.gz'
        path = output / name
        archive(path, group)
        report = inspect(path, group)
        if label == 'core':
            # Bind metadata to the bytes in the inspected archive, not an earlier read.
            adapter = report['file_sha256']['chrominimum.dll']
        reports[label] = report
        packages.append(dict(component=component, sequence=sequence, engine_version=engine,
                             adapter_sha256=adapter,
                             url=f'https://github.com/SargeMadovsky/ChroMinimum/releases/download/{tag}/{name}',
                             size=report['size'], sha256=report['sha256']))
    if sum(p['size'] for p in packages) > MAX_DOWNLOAD:
        raise ValueError('Combined package download exceeds limit')
    if sum(r['expanded_bytes'] for r in reports.values()) > MAX_EXPANDED:
        raise ValueError('Combined expanded size exceeds limit')
    if sum(r['files'] for r in reports.values()) > 4096:
        raise ValueError('Combined file count exceeds limit')
    catalog = dict(format=2, purpose='chrominimum-components', launcher_api=2,
                   sequence=sequence, min_safe_sequence=min_safe, platform='windows-x64',
                   engine_version=engine, adapter_sha256=adapter, issued=issued,
                   expires=issued + 30 * 86400, packages=packages)
    (output / 'catalog.unsigned.json').write_text(json.dumps(catalog, indent=2), encoding='utf-8')
    (output / 'inspection.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
    return catalog


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--sequence', required=True, type=int)
    parser.add_argument('--min-safe-sequence', required=True, type=int)
    parser.add_argument('--engine-version', required=True)
    parser.add_argument('--release-tag', required=True)
    parser.add_argument('--licenses', type=Path, default=ROOT / 'dist/LICENSES-RUST.html')
    parser.add_argument('--issued', type=int, default=int(time.time()))
    args = parser.parse_args()
    result = build(args.bundle, args.output, args.sequence, args.min_safe_sequence,
                   args.engine_version, args.release_tag, args.licenses, args.issued)
    print(json.dumps(result, indent=2))
