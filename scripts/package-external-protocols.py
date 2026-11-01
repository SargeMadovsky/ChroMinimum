"""Package the accepted protocol runtime as a local portable build, never profiles."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LAUNCH = '''@echo off
setlocal
if not exist "%~dp0runtime\\.appcontainer-ready" (
  "%SystemRoot%\\System32\\icacls.exe" "%~dp0runtime" /grant "*S-1-15-2-1:(OI)(CI)(RX)" >nul
  if errorlevel 1 exit /b 1
  >"%~dp0runtime\\.appcontainer-ready" echo ready
)
set "CHROMINIMUM_DATA_DIR=%~dp0data"
start "" "%~dp0runtime\\chrominimum.exe" %*
'''


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preview', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    archive = Path(str(output) + '.zip')
    if not output.is_relative_to(ROOT / 'dist') or output == ROOT / 'dist' or output.exists() or archive.exists():
        raise ValueError('Use a new directory/archive inside dist')
    report = json.loads(args.report.read_text(encoding='utf-8'))
    if report['status'] != 'automated_acceptance_passed' or report['case_count'] != 19 or not report['registry_cleanup_verified']:
        raise ValueError('Complete protocol acceptance required')
    manifest = json.loads((args.preview / 'runtime-manifest.json').read_text(encoding='utf-8'))
    spec = importlib.util.spec_from_file_location('components', ROOT / 'scripts/package-components.py')
    components = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(components)
    allowed = components.RUNTIME | {'installer-seed.json'}
    for locale in components.LOCALES:
        allowed |= components.locale_names(locale)
    if set(manifest) != allowed:
        raise ValueError('Only the complete runtime allowlist is permitted; no profiles')
    for name, row in manifest.items():
        relative = Path(name)
        source = args.preview / 'runtime' / relative
        components.regular(source)
        if relative.is_absolute() or '..' in relative.parts or sha(source) != row['sha256']:
            raise ValueError(f'Runtime identity/path mismatch: {name}')
    for name, identity in report['artifacts'].items():
        if manifest[name]['sha256'] != identity['sha256']:
            raise ValueError('Acceptance belongs to a different runtime')
    credits = (args.preview / 'runtime/CREDITS.html').read_text(encoding='utf-8')
    if len(credits) < 100_000 or 'This is sample credits page.' in credits:
        raise ValueError('Full Chromium credits required')
    # Portable runtime does not use the old installer's pinned seed policy.
    selected = {name: row for name, row in manifest.items() if name != 'installer-seed.json'}
    output.mkdir(parents=True)
    packaged = {}
    for name, row in selected.items():
        target = output / 'runtime' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.preview / 'runtime' / name, target)
        if sha(target) != row['sha256']:
            raise ValueError(f'Copied runtime differs: {name}')
        packaged[name] = {'sha256': row['sha256'], 'bytes': target.stat().st_size}
    for name, source in [('LICENSE', ROOT / 'LICENSE'), ('THIRD_PARTY.md', ROOT / 'THIRD_PARTY.md'),
                         ('LICENSES-RUST.html', ROOT / 'dist/LICENSES-RUST.html')]:
        shutil.copy2(source, output / name)
    shutil.copytree(ROOT / 'third_party', output / 'third_party')
    shutil.copy2(args.report, output / 'ACCEPTANCE.json')
    (output / 'runtime-manifest.json').write_text(json.dumps(packaged, indent=2) + '\n', encoding='utf-8')
    (output / 'Launch.cmd').write_text(LAUNCH, encoding='ascii')
    (output / 'README-RU.txt').write_text(
        'ChroMinimum alpha.8: локальная Windows x64 сборка с внешними протоколами.\n'
        'Запуск: Launch.cmd. Профиль сохраняется в data рядом с программой.\n'
        'При первом запуске выдаётся чтение runtime для AppContainer; sandbox включён.\n'
        'Обработчик Chromium принят: 19 автоматических сценариев и проверка владельцем.\n'
        'Ядро содержит экспериментальный media0011; отдельная media-приёмка не завершена.\n'
        'Это не опубликованный релиз и не обновление основной установки.\n', encoding='utf-8')
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                bundle.write(file, (Path(output.name) / file.relative_to(output)).as_posix())
    archive.with_suffix('.zip.sha256').write_text(sha(archive) + '  ' + archive.name + '\n', encoding='ascii')
    # ACLs are local setup, not ZIP payload. An extracted copy prepares them on first launch.
    subprocess.run(['icacls', str(output / 'runtime'), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], check=True, capture_output=True)
    (output / 'runtime/.appcontainer-ready').write_text('ready\n', encoding='ascii')
    print(json.dumps({'directory': str(output), 'archive': str(archive), 'runtime_files': len(packaged),
                      'bytes': archive.stat().st_size, 'sha256': sha(archive)}))


if __name__ == '__main__':
    main()
