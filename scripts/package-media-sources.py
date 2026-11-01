"""Snapshot reviewed source roots and build evidence; no secrets, binary runtimes or publishing.

FFmpeg/CEF Git archives must already be present. This is source material, not
an assertion that all LGPL/relinking or patent requirements have been met.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular(path):
    for item in (path, *path.parents):
        if item.is_symlink() or getattr(item.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Reparse source is not permitted: {item}')
    if not path.is_file():
        raise ValueError(f'Regular file required: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-root', type=Path, default=Path('C:/cm-media154'))
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/alpha8-source-materials')
    parser.add_argument('--snapshot-name', default='chrominimum-alpha8-source-snapshot.zip')
    args = parser.parse_args()
    output = args.output.resolve(strict=True)
    if Path(args.snapshot_name).name != args.snapshot_name or not args.snapshot_name.endswith('.zip'):
        raise ValueError('Snapshot must be a plain ZIP filename')
    snapshot = output / args.snapshot_name
    if snapshot.exists():
        raise ValueError('Source snapshot already exists; preserve it and use a new output')
    revisions = {
        'ffmpeg': ('third_party/ffmpeg', 'a06d51a20a28f980b2ddc6b7d73d69b2d29bf323'),
        'cef': ('cef', '14c5a089e8452874cb1a556dc3fde26ed2d87723'),
    }
    archives = {}
    for name, (relative, commit) in revisions.items():
        checkout = args.build_root / 'chromium/src' / relative
        command = ['git', '-c', f'safe.directory={checkout.as_posix()}', '-C', str(checkout)]
        assert subprocess.check_output(command + ['rev-parse', 'HEAD'], text=True).strip() == commit
        assert not subprocess.check_output(command + ['status', '--porcelain'], text=True).strip()
        archive = output / f'{name}-{commit}.zip'
        regular(archive)
        with zipfile.ZipFile(archive) as z:
            assert z.testzip() is None
            assert z.comment.decode().strip() == commit
        archives[name] = dict(commit=commit, path=archive.name, bytes=archive.stat().st_size,
                              sha256=digest(archive), working_tree_clean=True)
    sources = {}
    names = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'LICENSE',
             'THIRD_PARTY.md', 'README.md', 'about.toml', 'about.hbs',
             'updater/Cargo.toml', 'updater/Cargo.lock', 'updater/public-key.hex',
             '.cargo/config.toml']
    for name in names:
        path = ROOT / name
        if path.exists():
            sources[name] = path
    roots = ['src', 'updater/src', 'updater/tests', 'scripts', 'patches/chromium',
             'installer', 'third_party/cef', 'third_party/cef-rs', 'assets']
    suffixes = {'.rs', '.cc', '.h', '.py', '.ps1', '.cjs', '.sh', '.json', '.patch',
                '.iss', '.toml', '.svg', '.png', '.alpha', '.ico', '.txt', '.hbs'}
    for name in roots:
        for path in (ROOT / name).rglob('*'):
            relative = path.relative_to(ROOT)
            if any(part in {'dist', '__pycache__', 'readme'} for part in relative.parts):
                continue
            if path.is_file() and (path.suffix in suffixes or path.name.startswith('LICENSE')):
                sources[relative.as_posix()] = path
    for name in ['MEDIA_DISTRIBUTION_REVIEW.md', 'CEF_MEDIA_RELEASE_EXPERIMENT.md',
                 'CUSTOM_CEF_BUILD.md', 'MEDIA_ENGINE_UPDATES.md', 'RELEASE_ALPHA8.md']:
        sources[f'docs/{name}'] = ROOT / 'docs' / name
    evidence = ROOT / '.local/media-release-20261022'
    for name in ['args.gn', 'effective-args.txt']:
        sources[f'build-evidence/{name}'] = evidence / name
    inspection = {}
    for name, path in sources.items():
        regular(path)
        inspection[name] = dict(bytes=path.stat().st_size, sha256=digest(path))
    with zipfile.ZipFile(snapshot, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name, path in sorted(sources.items()):
            z.write(path, 'chrominimum/' + name)
        z.writestr('chrominimum/SOURCE-SNAPSHOT.json', json.dumps(inspection, indent=2))
    with zipfile.ZipFile(snapshot) as z:
        assert z.testzip() is None
        for name, item in inspection.items():
            assert hashlib.sha256(z.read('chrominimum/' + name)).hexdigest() == item['sha256']
    archives['chrominimum'] = dict(path=snapshot.name, bytes=snapshot.stat().st_size,
                                   sha256=digest(snapshot), files=len(sources))
    manifest = dict(status='local_source_materials_not_distribution_clearance',
                    chromium_commit='b859317bf11f6be47f9b7799ec690a0a42a1fb33',
                    complete_chromium_dependency_archive=False, bit_reproducibility_verified=False,
                    patent_rights_verified=False, full_lgpl_relinking_compliance_verified=False,
                    archives=archives)
    (output / 'source-materials.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    for item in archives.values():
        (output / (item['path'] + '.sha256')).write_text(item['sha256'] + '  ' + item['path'] + '\n')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
