"""Build an isolated PageInfo candidate from the accepted 0015 core.

Reuse its exact explicit link inputs, replacing only the UI archive and one
object inside it. Original source tree, objects, DLL and installation stay intact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--base-core', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--run-prepared', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    src, base = args.chromium_src.resolve(strict=True), args.base_core.resolve(strict=True)
    build = src / 'out/Release_Platform_Codecs_Only_x64'
    target = args.output.resolve()
    policy = json.loads((repo / 'patches/chromium/0016-native-security-page.json').read_text())
    version = dict(line.split('=', 1) for line in
                   (src / 'chrome/VERSION').read_text(encoding='utf-8').splitlines() if '=' in line)
    actual_version = '.'.join(version[key] for key in ('MAJOR', 'MINOR', 'BUILD', 'PATCH'))
    if actual_version != policy['chromium']:
        raise ValueError(f'Chromium {actual_version} requires a reviewed/rebased patch')
    previous = json.loads((base / 'result.json').read_text())
    assert previous['status'] == 'completed'
    assert previous['dll_sha256'] == 'fd6327f87d21a6db6922e9dc8bd12e2c3717a82be6bdcecd1ef3eeaac8ebd5b2'
    assert sha(base / 'libcef.dll') == previous['dll_sha256']
    original = json.loads((base / 'commands.json').read_text())
    source = next(iter(policy['files']))
    for name, digest in previous['object_sha256'].items():
        assert sha(Path(name)) == digest
    if not args.run_prepared:
        target.mkdir(parents=True, exist_ok=False)
        (target / 'objects').mkdir()
        destination = target / 'sources' / source
        destination.parent.mkdir(parents=True)
        before = (base / 'sources' / source).read_text()
        assert hashlib.sha256(before.encode()).hexdigest() == policy['files'][source]['before_sha256']
        destination.write_text(before, encoding='utf-8', newline='\n')
        subprocess.run(['git', 'init', '--quiet', str(target / 'sources')], check=True)
        subprocess.run(['git', '-C', str(target / 'sources'), 'apply', '--check',
                        str(repo / 'patches/chromium/0016-native-security-page.patch')], check=True)
        subprocess.run(['git', '-C', str(target / 'sources'), 'apply',
                        str(repo / 'patches/chromium/0016-native-security-page.patch')], check=True)
        destination.write_bytes(destination.read_bytes().replace(b'\r\n', b'\n'))
        assert hashlib.sha256(destination.read_bytes()).hexdigest() == policy['files'][source]['after_sha256']
        commands = {}
        commands['compile'] = original['compile-browser_command_controller'].replace(base.as_posix(), target.as_posix())
        commands['archive'] = original['archive'].replace(base.as_posix(), target.as_posix())
        commands['link'] = original['link'].replace(base.as_posix(), target.as_posix())
        # Preserve every other input (including 0011 AAC, 0012/13 protocols,
        # and 0014/15 download objects) at its accepted absolute path.
        archive_response = (base / 'ui.lib.rsp').read_text()
        old_obj = (base / 'objects/browser_command_controller.obj').as_posix()
        assert archive_response.split().count(old_obj) == 1
        (target / 'ui.lib.rsp').write_text(archive_response.replace(old_obj,
            (target / 'objects/browser_command_controller.obj').as_posix()))
        response = (base / 'libcef.dll.rsp').read_text()
        old_archive = (base / 'ui.lib').as_posix()
        assert response.split().count(old_archive) == 1
        (target / 'libcef.dll.rsp').write_text(response.replace(old_archive, (target / 'ui.lib').as_posix()))
        (target / 'commands.json').write_text(json.dumps(commands, indent=2))
        record = {'status': 'prepared', 'base_dll_sha256': previous['dll_sha256'],
                  'source_sha256': policy['files'][source]['after_sha256'],
                  'base_core': str(base), 'runtime_validated': False}
        (target / 'result.json').write_text(json.dumps(record, indent=2))
    else:
        commands = json.loads((target / 'commands.json').read_text())
        record = json.loads((target / 'result.json').read_text())
        assert record['status'] == 'prepared'
        assert hashlib.sha256((target / 'sources' / source).read_bytes()).hexdigest() == record['source_sha256']
    if args.prepare_only:
        print(json.dumps({'status': record['status'], 'phases': list(commands)}), flush=True)
        return
    if shutil.disk_usage(target).free < 25 * 1024**3:
        raise RuntimeError('Less than 25 GiB free; refusing large CEF link')
    env = os.environ.copy()
    env.update(TEMP=str(src.parents[1] / 'tmp'), TMP=str(src.parents[1] / 'tmp'),
               DEPOT_TOOLS_UPDATE='0', DEPOT_TOOLS_WIN_TOOLCHAIN='0')
    try:
        for name, command in commands.items():
            record['status'] = name
            (target / 'result.json').write_text(json.dumps(record, indent=2))
            start = time.monotonic()
            executable = str((build / command.split(' ', 1)[0]).resolve())
            with (target / (name + '.log')).open('w') as log:
                result = subprocess.run(command, executable=executable, cwd=build, env=env,
                                        stdout=log, stderr=subprocess.STDOUT, timeout=14400)
            record[name + '_seconds'] = time.monotonic() - start
            record[name + '_exit_code'] = result.returncode
            print(json.dumps({'phase': name, 'exit_code': result.returncode,
                              'seconds': record[name + '_seconds']}), flush=True)
            if result.returncode:
                raise RuntimeError(name + ' failed; inspect its log')
        record.update(status='completed', dll_sha256=sha(target / 'libcef.dll'),
                      dll_bytes=(target / 'libcef.dll').stat().st_size,
                      object_sha256={str(target / 'objects/browser_command_controller.obj'):
                                     sha(target / 'objects/browser_command_controller.obj')})
    except Exception as error:
        record.update(status='failed', error=str(error))
        raise
    finally:
        record['base_dll_unchanged'] = sha(base / 'libcef.dll') == previous['dll_sha256']
        record['base_objects_unchanged'] = all(sha(Path(name)) == digest
            for name, digest in previous['object_sha256'].items())
        (target / 'result.json').write_text(json.dumps(record, indent=2) + '\n')


if __name__ == '__main__':
    main()
