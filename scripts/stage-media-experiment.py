"""Stage an uninstalled media experiment from a completed CEF minimal distribution.

Does not build, install, sign, publish, change ACLs or copy user profiles.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

def no_links(path):
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if item.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Reparse point or symlink: {item}')


def regular(path):
    no_links(path)
    if not path.is_file():
        raise ValueError(f'Regular file required: {path}')


def stage(distribution, adapter, output):
    # Do not resolve links or hide a linked directory behind a parent segment.
    if any('..' in p.parts for p in (distribution, adapter, output)):
        raise ValueError('Parent path segments are not allowed')
    distribution, adapter, output = (p.absolute() for p in (distribution, adapter, output))
    no_links(output)
    if output.exists():
        raise ValueError('Output must not exist')
    for source in (distribution, adapter):
        if source == output or source in output.parents or output in source.parents:
            raise ValueError('Output must be separate from both inputs')
    release, resources = distribution / 'Release', distribution / 'Resources'
    sources = {'chrominimum.exe': release / 'bootstrap.exe',
               'chrominimum.dll': adapter / 'chrominimum.dll',
               'chrominimum.exe.manifest': adapter / 'chrominimum.exe.manifest',
               'CREDITS.html': distribution / 'CREDITS.html'}
    for name in ('libcef.dll', 'chrome_elf.dll', 'd3dcompiler_47.dll',
                 'v8_context_snapshot.bin', 'vk_swiftshader.dll',
                 'vk_swiftshader_icd.json', 'vulkan-1.dll'):
        sources[name] = release / name
    for name in ('dxcompiler.dll', 'dxil.dll'):
        if (release / name).exists():
            sources[name] = release / name
    for name in ('chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat'):
        sources[name] = resources / name
    for locale in ('en-US', 'ru'):
        for suffix in ('', '_FEMININE', '_MASCULINE', '_NEUTER'):
            name = f'locales/{locale}{suffix}.pak'
            sources[name] = resources / name
    # Validate the entire input before creating any destination files.
    for source in sources.values():
        regular(source)
        if source.stat().st_size == 0:
            raise ValueError(f'Empty input: {source}')
    output.mkdir(parents=True)
    runtime = output / 'runtime'
    manifest = {'status': 'staged_not_validated', 'distribution': str(distribution),
                'adapter': str(adapter), 'files': {}}
    for name, source in sorted(sources.items()):
        destination = runtime / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        with destination.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        manifest['files'][name] = {'source': str(source), 'bytes': destination.stat().st_size,
                                   'sha256': digest}
    # PowerShell clears inherited managed-launcher context before a manual launch.
    # User data is outside runtime, whose code may need AppContainer read access.
    (output / 'launch.ps1').write_text('''$ErrorActionPreference = 'Stop'
Get-ChildItem Env:CHROMINIMUM_* | Remove-Item
$env:CHROMINIMUM_DATA_DIR = Join-Path $env:LOCALAPPDATA 'ChroMinimum-MediaExperiment-20261021'
& (Join-Path $PSScriptRoot 'runtime/chrominimum.exe') '--url=https://hdrezka.fi/films/documentary/93284-sidni-lyumet-o-sebe-2015.html'
''', encoding='utf-8')
    (output / 'stage-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--adapter', type=Path, required=True,
                        help='Flat application core/seed directory, not the updater launcher')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = stage(args.distribution, args.adapter, args.output)
    print(json.dumps({'status': manifest['status'], 'files': len(manifest['files']),
                      'bytes': sum(f['bytes'] for f in manifest['files'].values())}))


if __name__ == '__main__':
    main()
