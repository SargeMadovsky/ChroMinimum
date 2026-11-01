"""Real install/uninstall test for the separate TestInstall identity only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import winreg

ROOT = Path(__file__).resolve().parents[1]
KEY = 'ChroMinimumInstallerTest'
LAUNCHER = 'chrominimum-installer-test.exe'


def read_values(path):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            values = []
            index = 0
            while True:
                try:
                    values.append(winreg.EnumValue(key, index))
                    index += 1
                except OSError:
                    return sorted(values)
    except FileNotFoundError:
        return None


def defaults():
    return {ext: read_values(fr'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice')
            for ext in ('.html', '.htm', '.pdf')}


def application_registration():
    """Snapshot only the owner's public file-handler registration, never a profile."""
    base = r'Software\Classes\Applications\chrominimum.exe'
    result = {}
    def visit(path):
        values = read_values(path)
        result[path] = values
        if values is None:
            return
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            children = [winreg.EnumKey(key, i) for i in range(winreg.QueryInfoKey(key)[0])]
        for child in children:
            visit(path + '\\' + child)
    visit(base)
    return result


def run_browser(command, target, work, local_appdata, locale, relaunch=None, require_network=False):
    env = os.environ.copy()
    env.pop('CHROMINIMUM_DATA_DIR', None)
    env['LOCALAPPDATA'] = str(local_appdata)
    start = time.monotonic()
    process = subprocess.Popen(command.replace('%1', str(target)) + ' --smoke-test', env=env)
    if relaunch:
        deadline = time.monotonic() + 20
        log = local_appdata / 'ChroMinimum/smoke.log'
        while time.monotonic() < deadline:
            if log.exists() and 'fixture_javascript_ok' in log.read_text(encoding='utf-8'):
                break
            time.sleep(0.05)
        else:
            raise AssertionError('Initial file did not load before relaunch')
        second = subprocess.run(command.replace('%1', str(relaunch)) + ' --smoke-test', env=env, timeout=15)
        assert second.returncode == 0
    if require_network:
        log = local_appdata / 'ChroMinimum/smoke.log'
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if log.exists() and 'main_frame_loaded;' in log.read_text(encoding='utf-8'):
                break
            time.sleep(0.05)
        else:
            raise AssertionError('Initial file did not load before token probe')
        tokens = subprocess.run([shutil.which('pwsh'), '-NoProfile', '-File',
            str(ROOT / 'scripts/inspect-test-process-tokens.ps1'), '-RootProcessId', str(process.pid)],
            capture_output=True, text=True, check=True, timeout=15)
        observed = json.loads(tokens.stdout)
        (work / 'network-tokens.json').write_text(json.dumps(observed, indent=2), encoding='utf-8')
        network = [t for t in observed if t.get('Subtype') == 'network.mojom.NetworkService']
        assert network and all(t['Error'] == 0 and t['SandboxType'] == 'network'
                              and t['AppContainer'] == 1 and t['IntegrityRid'] <= 4096 for t in network)
    process.wait(timeout=75)
    data = local_appdata / 'ChroMinimum'
    evidence = (data / 'smoke.log').read_text(encoding='utf-8')
    (work / f'{target.suffix[1:]}-smoke.log').write_text(evidence, encoding='utf-8')
    assert process.returncode == 0
    assert not (data / 'profile-smoke/DevToolsActivePort').exists(), 'Unexpected debugging listener'
    assert all(marker in evidence for marker in ('sandbox_requested=true', 'main_frame_loaded;',
               'browser_closed', 'shutdown_complete', f'installed_locale={locale}'))
    if target.suffix == '.html':
        assert 'fixture_javascript_ok' in evidence
    assert 'main_frame_error;' not in evidence
    if relaunch:
        assert 'app_relaunch_received' in evidence
        assert evidence.count('browser_created') == 2
        assert evidence.count('toolbar_created') == 2
        assert evidence.count('main_frame_loaded;') >= 2
        assert f'main_frame_url={relaunch.resolve().as_uri()}' in evidence, 'Second window did not load the requested document'
    assert 'FATAL:' not in (data / 'cef.log').read_text(encoding='utf-8', errors='replace')
    return dict(exit_code=process.returncode, seconds=round(time.monotonic() - start, 3),
                profile_in_localappdata=(data / 'profile-smoke').is_dir(), relaunch_checked=bool(relaunch),
                network_sandbox_checked=require_network)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--installer', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--previous-installer', type=Path)
    p.add_argument('--media-fixtures', type=Path)
    p.add_argument('--payload-inspection', type=Path)
    p.add_argument('--require-platform-aac', action='store_true')
    a = p.parse_args()
    if a.previous_installer:
        assert a.previous_installer.name == 'ChroMinimum-0.0.1-alpha.7-test-setup-x64.exe'
    assert a.installer.name == 'ChroMinimum-0.0.1-alpha.8-test-setup-x64.exe', 'Only the current TestInstall build is accepted'
    assert read_values(fr'Software\{KEY}\Capabilities') is None, 'Existing test registration must not be overwritten'
    assert read_values(fr'Software\Classes\{KEY}.HTML') is None
    assert read_values(r'Software\Classes\Applications\chrominimum-installer-test.exe') is None
    output = a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    previous_defaults = defaults()
    previous_application = application_registration()
    results = {}
    # Refuse a lower security baseline before any installed files/registry writes.
    refused = output / 'higher-floor'
    refused.mkdir()
    (refused / LAUNCHER).write_bytes(b'keep existing launcher')
    old_state = dict(active=2, pending=None, attempted=True, highest=2, min_safe=2)
    (refused / 'core-state.json').write_text(json.dumps(old_state), encoding='utf-8')
    rejected = subprocess.run([str(a.installer.resolve()), '/VERYSILENT', '/SUPPRESSMSGBOXES',
        '/NORESTART', '/SP-', f'/DIR={refused}', f'/LOG={output / "higher-floor.log"}'], timeout=180)
    assert rejected.returncode != 0
    assert (refused / LAUNCHER).read_bytes() == b'keep existing launcher'
    assert json.loads((refused / 'core-state.json').read_text()) == old_state
    assert not (refused / 'core/seed').exists()
    assert application_registration() == previous_application and defaults() == previous_defaults
    assert read_values(fr'Software\{KEY}\Capabilities') is None
    results['higher_floor_refused_before_copy'] = True
    for locale in ('en-US', 'ru'):
        work = output / locale
        work.mkdir()
        app = work / 'Installed Browser'
        previous_dll = None
        if locale == 'en-US' and a.previous_installer:
            subprocess.run([str(a.previous_installer.resolve()), '/VERYSILENT', '/SUPPRESSMSGBOXES',
                '/NORESTART', '/SP-', f'/DIR={app}', '/TYPE=custom', '/COMPONENTS=core,english',
                f'/LOG={work / "alpha7-install.log"}'], check=True, timeout=180)
            previous_dll = hashlib.sha256((app / 'core/seed/libcef.dll').read_bytes()).hexdigest()
            (app / 'upgrade-sentinel.txt').write_text('preserve alpha7 test data')
        elif locale == 'en-US':
            legacy = app / 'core/v1'
            legacy.mkdir(parents=True)
            (legacy / 'chrominimum.dll').write_bytes(b'legacy adapter sentinel')
            (app / 'core-state.json').write_text(json.dumps(dict(active=1, pending=None,
                attempted=True, highest=1, min_safe=1)), encoding='utf-8')
        components = 'core,english' + (',russian' if locale == 'ru' else '')
        install = subprocess.run([str(a.installer.resolve()), '/VERYSILENT', '/SUPPRESSMSGBOXES',
            '/NORESTART', '/SP-', f'/DIR={app}', '/TYPE=custom', f'/COMPONENTS={components}',
            f'/LOG={work / "install.log"}'], timeout=180)
        assert install.returncode == 0
        try:
            if a.payload_inspection:
                inspected = json.loads(a.payload_inspection.read_text())
                for relative, expected in inspected.items():
                    if locale == 'en-US' and relative.startswith('core/seed/locales/ru'):
                        continue
                    installed = app / (LAUNCHER if relative == 'chrominimum.exe' else relative)
                    with installed.open('rb') as stream:
                        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected['sha256'], relative
                assert (app / 'core/seed/CREDITS.html').stat().st_size > 100_000
            migrated = json.loads((app / 'core-state.json').read_text(encoding='utf-8'))
            assert migrated['active'] == 0 and migrated['pending'] is None
            assert migrated['highest'] == migrated['min_safe'] == 1
            assert len(migrated['seed_policy_sha256']) == 64
            assert json.loads((app / 'core/seed/installer-seed.json').read_text())['media_codecs'] is True
            assert migrated['media_codecs_required'] is True
            if previous_dll:
                assert hashlib.sha256((app / 'core/seed/libcef.dll').read_bytes()).hexdigest() != previous_dll
                assert (app / 'upgrade-sentinel.txt').read_text() == 'preserve alpha7 test data'
            elif locale == 'en-US':
                assert (legacy / 'chrominimum.dll').read_bytes() == b'legacy adapter sentinel'
            config = json.loads((app / 'installation.json').read_text(encoding='utf-8'))
            assert config['ui_locale'] == locale
            packs = sorted(f.name for f in (app / 'core/seed/locales').iterdir())
            assert len(packs) == (8 if locale == 'ru' else 4), packs
            if locale == 'en-US':
                assert not any(p.startswith('ru') for p in packs)
            assert defaults() == previous_defaults
            assert application_registration() == previous_application
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\Applications\chrominimum-installer-test.exe') as key:
                assert winreg.QueryValueEx(key, 'FriendlyAppName')[0] == 'ChroMinimum Installer Test'
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\Applications\chrominimum-installer-test.exe\shell\open\command') as key:
                assert winreg.QueryValueEx(key, '')[0] == f'"{app}\\{LAUNCHER}" --open "%1"'
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Classes\Applications\chrominimum-installer-test.exe\SupportedTypes') as key:
                assert sorted(winreg.EnumValue(key, i)[0] for i in range(winreg.QueryInfoKey(key)[1])) == sorted(['.html', '.htm', '.pdf'])
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\RegisteredApplications') as key:
                assert winreg.QueryValueEx(key, KEY)[0] == fr'Software\{KEY}\Capabilities'
            commands = {}
            for kind in ('HTML', 'PDF'):
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, fr'Software\Classes\{KEY}.{kind}\shell\open\command') as key:
                    commands[kind] = winreg.QueryValueEx(key, '')[0]
                assert commands[kind] == f'"{app}\\{LAUNCHER}" --open "%1"'
            local = work / 'Test LocalAppData'
            # Keep the Unicode fixture spelling independent of shell encoding.
            stem = '\u0422\u0435\u0441\u0442 #100% --file'
            html = work / (stem + '.html')
            pdf = work / (stem + '.pdf')
            shutil.copyfile(ROOT / 'tests/fixtures/smoke.html', html)
            shutil.copyfile(ROOT / 'tests/fixtures/smoke.pdf', pdf)
            browser = {}
            # Different format for each language; both exercise the registered command.
            target, kind = (html, 'HTML') if locale == 'en-US' else (pdf, 'PDF')
            browser[kind] = run_browser(commands[kind], target, work, local, locale, pdf if locale == 'en-US' else None,
                                       require_network=True)
            if a.media_fixtures:
                media_args = ['--visible']
                checker = 'check-media-report.py'
                if a.require_platform_aac:
                    media_args += ['--require-platform-aac', '--native-window', '--extended-smoke', '--audible', '--ssd-profile']
                    checker = 'check-platform-aac-report.py'
                subprocess.run([shutil.which('node'), str(ROOT / 'scripts/diagnose-media.cjs'),
                    str(app / LAUNCHER), str(work / 'media'), str(a.media_fixtures.resolve()), *media_args],
                    check=True, timeout=240)
                subprocess.run([shutil.which('python'), str(ROOT / 'scripts' / checker),
                    str(work / 'media')], check=True, timeout=15)
            assert not (app / 'profile').exists() and not (app / 'profile-smoke').exists()
            sentinel = local / 'ChroMinimum/keep-user-data.txt'
            sentinel.write_text('preserve', encoding='utf-8')
            results[locale] = dict(installed=True, locale_paks=packs, registered_commands=True,
                                   installer_seed_migration=migrated,
                                   alpha7_upgrade_checked=bool(previous_dll),
                                   legacy_core_preserved=locale == 'en-US' and not a.previous_installer,
                                   installed_media_checked=bool(a.media_fixtures),
                                   payload_hashes_checked=bool(a.payload_inspection),
                                   installed_bytes=sum(p.stat().st_size for p in app.rglob('*') if p.is_file()),
                                   browser=browser, defaults_unchanged=True)
        finally:
            uninstaller = app / 'unins000.exe'
            if uninstaller.exists():
                removed = subprocess.run([str(uninstaller), '/VERYSILENT', '/SUPPRESSMSGBOXES',
                    '/NORESTART', f'/LOG={work / "uninstall.log"}'], timeout=120)
                assert removed.returncode == 0
        # The uninstaller spawns its temporary worker: wait for registered files to disappear.
        deadline = time.monotonic() + 15
        while (app / LAUNCHER).exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not (app / LAUNCHER).exists()
        assert not (app / 'installation.json').exists()
        assert read_values(fr'Software\Classes\{KEY}.HTML') is None
        assert read_values(fr'Software\Classes\{KEY}.PDF') is None
        assert read_values(r'Software\Classes\Applications\chrominimum-installer-test.exe') is None
        assert read_values(fr'Software\{KEY}\Capabilities') is None
        assert not any(v[0] == KEY for v in read_values(r'Software\RegisteredApplications') or [])
        for ext, kind in (('.html', 'HTML'), ('.htm', 'HTML'), ('.pdf', 'PDF')):
            assert not any(v[0] == f'{KEY}.{kind}' for v in read_values(fr'Software\Classes\{ext}\OpenWithProgids') or [])
        assert defaults() == previous_defaults
        assert application_registration() == previous_application
        assert sentinel.read_text(encoding='utf-8') == 'preserve'
        results[locale].update(uninstalled=True, user_data_preserved=True, owner_application_registration_unchanged=True)
    with a.installer.open('rb') as stream:
        results['installer_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (output / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
