"""Exercise registered HTML/PDF commands of an installed copy with test data only."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import winreg

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer_test', ROOT / 'scripts/test-windows-installer.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--launcher', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    launcher = a.launcher.resolve(strict=True)
    output = a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    config = json.loads((launcher.parent / 'installation.json').read_text(encoding='utf-8'))
    commands = {}
    for kind in ('HTML', 'PDF'):
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, fr'Software\Classes\ChroMinimum.{kind}\shell\open\command') as key:
            commands[kind] = winreg.QueryValueEx(key, '')[0]
        assert commands[kind] == f'"{launcher}" --open "%1"'
    assert commands['HTML'] == commands['PDF']
    html, pdf = output / 'Локальный #100% --file.html', output / 'Локальный #100% --file.pdf'
    shutil.copyfile(ROOT / 'tests/fixtures/smoke.html', html)
    shutil.copyfile(ROOT / 'tests/fixtures/smoke.pdf', pdf)
    before = helper.defaults()
    result = helper.run_browser(commands['HTML'], html, output, output / 'Fake LocalAppData', config['ui_locale'], relaunch=pdf)
    assert helper.defaults() == before
    result.update(registered_html_pdf_commands=True, defaults_unchanged=True, user_profile_used=False)
    (output / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
