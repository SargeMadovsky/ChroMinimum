"""Collect the reviewed alpha.8 local release. Does not install, sign or publish."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'libcef.dll': 'fd6327f87d21a6db6922e9dc8bd12e2c3717a82be6bdcecd1ef3eeaac8ebd5b2',
    'chrominimum.dll': 'cb0558b0e55596403f09f097fbfd6d361c4d09963e0a1a3a8624c3e233c2ea08',
    'resources.pak': 'e245f9f46432d2ea01eadae246065cd3ee9498691d13895afe0a64739e80c6e0',
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular(path):
    if not path.is_file() or any(p.is_symlink() or getattr(p.lstat(), 'st_file_attributes', 0) & 0x400
                                 for p in (path, *path.parents)):
        raise ValueError(f'Regular source required: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--installer', type=Path, required=True)
    parser.add_argument('--validation', type=Path, required=True)
    parser.add_argument('--build-src', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(ROOT / 'dist') or output == ROOT / 'dist':
        raise ValueError('Use a new release directory inside dist')
    for name, expected in PINS.items():
        regular(args.runtime / name)
        if digest(args.runtime / name) != expected:
            raise ValueError(f'Unreviewed runtime: {name}')
    validation = json.loads(args.validation.read_text(encoding='utf-8'))
    assert validation['higher_floor_refused_before_copy']
    for locale in ('en-US', 'ru'):
        assert all(validation[locale][key] for key in ('payload_hashes_checked', 'uninstalled', 'user_data_preserved', 'owner_application_registration_unchanged'))
        branding = json.loads((args.validation.parent / locale / 'branding/result.json').read_text(encoding='utf-8'))
        assert branding['one_page'] and branding['shutdown_complete'] and len(branding['results']) == 2
        # The fixture must really be Cyrillic, not an already garbled name.
        assert (args.validation.parent / locale / '\u0422\u0435\u0441\u0442 #100% --file.pdf').is_file()
    regular(args.installer)
    assert args.installer.name == 'ChroMinimum-0.0.1-alpha.8-setup-x64.exe'
    archives = {}
    for name, commit in [('cef', '14c5a089e8452874cb1a556dc3fde26ed2d87723'),
                         ('ffmpeg', 'a06d51a20a28f980b2ddc6b7d73d69b2d29bf323')]:
        path = ROOT / 'dist/alpha8-source-materials' / f'{name}-{commit}.zip'
        regular(path)
        with zipfile.ZipFile(path) as archive:
            assert archive.comment.decode().strip() == commit and archive.testzip() is None
        archives[path.name] = path
    output.mkdir()
    shutil.copyfile(args.installer, output / args.installer.name)
    for name, source in {'LICENSE': ROOT / 'LICENSE', 'THIRD_PARTY.md': ROOT / 'THIRD_PARTY.md',
                         'RELEASE-NOTES.md': ROOT / 'docs/RELEASE_ALPHA8_20261101.md',
                         'LICENSES-RUST.html': ROOT / 'dist/LICENSES-RUST.html',
                         'LICENSES-UPDATER.html': ROOT / 'dist/LICENSES-UPDATER.html'}.items():
        regular(source)
        shutil.copyfile(source, output / name)
    sources = {}
    for name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'LICENSE', 'README.md',
                 'THIRD_PARTY.md', 'about.toml', 'about.hbs', '.cargo/config.toml',
                 'updater/Cargo.toml', 'updater/Cargo.lock', 'updater/public-key.hex'):
        if (ROOT / name).is_file():
            sources[name] = ROOT / name
    suffixes = {'.rs', '.cc', '.h', '.py', '.ps1', '.cjs', '.json', '.patch', '.iss',
                '.toml', '.svg', '.png', '.alpha', '.ico', '.txt', '.hbs', '.html', '.pdf', '.js'}
    for directory in ('src', 'updater/src', 'updater/tests', 'scripts', 'tests', 'patches/chromium', 'installer', 'assets', 'third_party/cef', 'third_party/cef-rs'):
        for path in (ROOT / directory).rglob('*'):
            relative = path.relative_to(ROOT)
            if any(p in {'__pycache__', 'readme', 'benchmarks', 'dist'} for p in relative.parts):
                continue
            if path.is_file() and (path.suffix in suffixes or path.name.startswith('LICENSE')):
                sources[relative.as_posix()] = path
    for name in ('PLATFORM_CODECS_BUILD_RECIPE.md', 'PLATFORM_CODECS_RELEASE_INTEGRATION.md',
                 'TOOLBAR_BUTTON_STATES.md', 'DOWNLOAD_PROGRESS_RING.md', 'DOWNLOAD_HISTORY_CURRENT_TAB.md',
                 'UPDATER_ADAPTER_BINDING.md', 'WEBAUDIO_PLATFORM_AAC_PLAN.md', 'DOWNLOADS_BRANDING.md', 'RELEASE_ALPHA8_20261101.md'):
        sources['docs/' + name] = ROOT / 'docs' / name
    sources['build-evidence/args.gn'] = args.build_src / 'out/Release_Platform_Codecs_Only_x64/args.gn'
    inspection = {}
    for name, path in sources.items():
        regular(path)
        inspection[name] = dict(bytes=path.stat().st_size, sha256=digest(path))
    folder = output / 'source-materials'
    folder.mkdir()
    for name, path in archives.items():
        shutil.copyfile(path, folder / name)
    snapshot = folder / 'chrominimum-alpha8-20261101-source.zip'
    with zipfile.ZipFile(snapshot, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in sorted(sources.items()):
            archive.write(path, 'chrominimum/' + name)
        archive.writestr('chrominimum/SOURCE-SNAPSHOT.json', json.dumps(inspection, indent=2))
    with zipfile.ZipFile(snapshot) as archive:
        assert archive.testzip() is None
        for name, row in inspection.items():
            assert hashlib.sha256(archive.read('chrominimum/' + name)).hexdigest() == row['sha256']
    files = {p.relative_to(output).as_posix(): dict(bytes=p.stat().st_size, sha256=digest(p))
             for p in output.rglob('*') if p.is_file()}
    manifest = dict(status='local_release_package_not_published', runtime_sha256=PINS,
                    validation_identity='ChroMinimumReleaseCandidateTest', files=files,
                    source_files=len(sources), installed_media_retested=False,
                    distribution_terms_cleared=False, authenticode_signed=False)
    (output / 'RELEASE-MANIFEST.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    (output / 'SHA256SUMS.txt').write_text(''.join(f"{row['sha256']}  {name}\n" for name, row in sorted(files.items())), encoding='utf-8')
    print(json.dumps(dict(output=str(output), files=len(files), source_files=len(sources))))


if __name__ == '__main__':
    main()
