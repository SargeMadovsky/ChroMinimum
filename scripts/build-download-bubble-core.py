"""Build an isolated native download UI candidate from the accepted protocol core.

Copies only patched source files, preserves GN compile/archive flags, substitutes
two objects and one archive, and keeps the accepted protocol objects in the link.
No source checkout, original object, library or installed runtime is overwritten.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_sha(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--base-core', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--link-only', action='store_true')
    parser.add_argument('--run-prepared', action='store_true')
    parser.add_argument('--progress-ring', action='store_true')
    parser.add_argument('--single-page-downloads', action='store_true')
    args = parser.parse_args()
    if args.single_page_downloads and not args.progress_ring:
        parser.error('--single-page-downloads requires --progress-ring')
    repo = Path(__file__).resolve().parents[1]
    src, base = args.chromium_src.resolve(strict=True), args.base_core.resolve(strict=True)
    build = src / 'out/Release_Platform_Codecs_Only_x64'
    target = args.output.resolve()
    if not args.prepare_only and shutil.disk_usage(target.parent).free < 25 * 1024**3:
        raise RuntimeError('Less than 25 GiB free; do not start the large CEF link')
    policy = json.loads((repo / 'patches/chromium/0005-download-bubble-anchor.json').read_text())
    final_sources = {name: row['after_sha256'] for name, row in policy['files'].items()}
    if args.progress_ring:
        ring_policy = json.loads((repo / 'patches/chromium/0014-download-progress-ring.json').read_text())
        for name, row in ring_policy['files'].items():
            assert final_sources[name] == row['before_sha256']
            final_sources[name] = row['after_sha256']
    if args.single_page_downloads:
        fallback_policy = json.loads((repo / 'patches/chromium/0015-download-history-current-tab.json').read_text())
        for name, row in fallback_policy['files'].items():
            assert final_sources[name] == row['before_sha256']
            final_sources[name] = row['after_sha256']
    previous = json.loads((base / 'result.json').read_text())
    assert previous['status'] == 'completed'
    assert sha(base / 'libcef.dll') == previous['dll_sha256']
    accepted = json.loads((repo / 'docs/reports/native-external-protocol-20261030/summary.json').read_text())
    assert previous['dll_sha256'] == accepted['artifacts']['libcef.dll']['sha256']
    for name, digest in previous['object_sha256'].items():
        assert sha(Path(name)) == digest
    if not args.link_only and not args.run_prepared:
        target.mkdir(parents=True, exist_ok=False)
        (target / 'objects').mkdir()
        sources = target / 'sources'
        for name, identity in policy['files'].items():
            assert source_sha(src / name) == identity['before_sha256'], name
            copy = sources / name
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src / name, copy)
        (sources / 'chrome/VERSION').write_bytes((src / 'chrome/VERSION').read_bytes())
        subprocess.run(['git', 'init', '--quiet', str(sources)], check=True)
        subprocess.run([os.sys.executable, str(repo / 'scripts/apply-cef-patches.py'),
                        '--chromium-src', str(sources), '--download-ui'], check=True)
        if args.progress_ring:
            subprocess.run([os.sys.executable, str(repo / 'scripts/apply-download-progress-ring.py'),
                            '--chromium-src', str(sources)], check=True)
        if args.single_page_downloads:
            subprocess.run([os.sys.executable, str(repo / 'scripts/apply-download-progress-ring.py'),
                            '--chromium-src', str(sources), '--single-page-downloads'], check=True)
    sources = target / 'sources'
    for name, identity in policy['files'].items():
        assert source_sha(src / name) == identity['before_sha256'], name
        assert source_sha(sources / name) == final_sources[name], name
    spec = importlib.util.spec_from_file_location('cm_link', repo / 'scripts/link-platform-aac-experiment.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    toolchain = build / 'toolchain.ninja'
    template = re.search(r'^rule cxx\r?\n  command = (.*)$', toolchain.read_text(), re.M)[1]
    targets = {
        'chrome/browser/ui/views/download/bubble/download_toolbar_ui_controller.cc':
            ('obj/chrome/browser/ui/views/download/download.ninja',
             'obj/chrome/browser/ui/views/download/download/download_toolbar_ui_controller.obj'),
        'chrome/browser/ui/browser_command_controller.cc':
            ('obj/chrome/browser/ui/ui.ninja', 'obj/chrome/browser/ui/ui/browser_command_controller.obj'),
    }
    commands, originals, swaps = {}, {}, {}
    for name, (ninja, obj) in targets.items():
        text = (build / ninja).read_text()
        variables = dict(re.findall(r'^(\w+) = (.*)$', text.split('\nbuild ', 1)[0], re.M))
        edge = helper.block(build / ninja, 'build ' + obj + ':')
        variables.update({line.split('=', 1)[0].strip(): line.split('=', 1)[1].strip()
                          for line in edge[1:] if '=' in line})
        label = Path(name).stem
        variables.update({'in': (sources / name).as_posix(), 'target_out_dir': target.as_posix(),
                          'label_name': 'objects', 'source_name_part': label})
        command = template
        for _ in range(8):
            command = re.sub(r'\$\{(\w+)\}|\$(\w+)', lambda m: variables[m[1] or m[2]], command)
        command = command.replace('$:', ':').replace('$ ', ' ').replace('$$', '$')
        swaps[obj] = (target / 'objects' / (label + '.obj')).as_posix()
        assert swaps[obj] in command
        originals[obj] = sha(build / obj)
        commands['compile-' + label] = command
    archive = 'obj/chrome/browser/ui/ui.lib'
    originals[archive] = sha(build / archive)
    edge = helper.block(build / 'obj/chrome/browser/ui/ui.ninja', 'build ' + archive + ':')
    rule = helper.block(toolchain, 'rule alink')
    inputs = edge[0].split(': alink ', 1)[1].split(' |', 1)[0]
    command_obj = targets['chrome/browser/ui/browser_command_controller.cc'][1]
    assert inputs.split().count(command_obj) == 1
    inputs = inputs.replace(command_obj, swaps[command_obj])
    variables = {line.split('=', 1)[0].strip(): line.split('=', 1)[1].strip()
                 for line in edge[1:] if '=' in line}
    variables.update(out=(target / 'ui.lib').as_posix(), in_newline=inputs.replace(' ', '\n'))
    variables.setdefault('arflags', '')
    content = helper.expand(next(line.split(' = ', 1)[1] for line in rule if line.startswith('  rspfile_content = ')), variables)
    archive_response = target / 'ui.lib.rsp'
    archive_response.write_text(content)
    commands['archive'] = helper.expand(next(line.split(' = ', 1)[1] for line in rule if line.startswith('  command = ')), variables)
    response = (base / 'libcef.dll.rsp').read_text()
    direct_obj = targets['chrome/browser/ui/views/download/bubble/download_toolbar_ui_controller.cc'][1]
    for old, new in ((archive, (target / 'ui.lib').as_posix()), (direct_obj, swaps[direct_obj])):
        assert response.split().count(old) == 1, old
        response = response.replace(old, new)
    (target / 'libcef.dll.rsp').write_text(response)
    link = json.loads((base / 'commands.json').read_text())['link']
    commands['link'] = link.replace(base.as_posix(), target.as_posix())
    assert target.as_posix() in commands['link'] and base.as_posix() not in commands['link']
    record_path = target / 'result.json'
    if args.link_only or args.run_prepared:
        record = json.loads(record_path.read_text())
        assert record['status'] == ('compiled_only' if args.link_only else 'prepared')
        assert json.loads((target / 'commands.json').read_text()) == commands
        for name, digest in record.get('object_sha256', {}).items():
            assert sha(Path(name)) == digest
    else:
        record = {'status': 'prepared', 'runtime_validated': False,
                  'base_dll_sha256': previous['dll_sha256'], 'base_core': str(base),
                  'source_sha256': final_sources, 'progress_ring': args.progress_ring,
                  'single_page_downloads': args.single_page_downloads,
                  'base_object_sha256': originals, 'lto_jobs': 2}
        (target / 'commands.json').write_text(json.dumps(commands, indent=2))
    def save():
        record_path.write_text(json.dumps(record, indent=2) + '\n')
    save()
    if args.prepare_only:
        print(json.dumps({'status': record['status'], 'commands': list(commands)}), flush=True)
        return
    env = os.environ.copy()
    env.update(PYTHONDONTWRITEBYTECODE='1', DEPOT_TOOLS_UPDATE='0', DEPOT_TOOLS_WIN_TOOLCHAIN='0')
    try:
        for name, command in commands.items():
            if args.link_only and name != 'link':
                continue
            record['status'] = name
            save()
            start = time.monotonic()
            with (target / (name + '.log')).open('w') as log:
                result = subprocess.run(command, executable=str((build / command.split(' ', 1)[0]).resolve()),
                                        cwd=build, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=14400)
            record[name + '_seconds'] = time.monotonic() - start
            record[name + '_exit_code'] = result.returncode
            save()
            print(json.dumps({'phase': name, 'exit_code': result.returncode, 'seconds': record[name + '_seconds']}), flush=True)
            if result.returncode:
                raise RuntimeError(name + ' failed; inspect its log')
            if name == 'archive':
                record['object_sha256'] = {path: sha(Path(path)) for path in [*swaps.values(), (target / 'ui.lib').as_posix()]}
                record['status'] = 'compiled_only'
                save()
        record.update(status='completed', dll_sha256=sha(target / 'libcef.dll'), dll_bytes=(target / 'libcef.dll').stat().st_size)
    except Exception as error:
        record.update(status='failed', error=str(error))
        raise
    finally:
        record['base_dll_unchanged'] = sha(base / 'libcef.dll') == previous['dll_sha256']
        record['base_object_unchanged'] = all(sha(build / name) == digest for name, digest in originals.items())
        record['checkout_unchanged'] = all(source_sha(src / name) == row['before_sha256'] for name, row in policy['files'].items())
        save()
        assert record['base_dll_unchanged'] and record['base_object_unchanged'] and record['checkout_unchanged']


if __name__ == '__main__':
    main()
