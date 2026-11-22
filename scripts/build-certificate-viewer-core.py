"""Isolated 0017 candidate; preserve all accepted 0016 link inputs except viewer UI."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


def sha(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--chromium-src', type=Path, required=True)
    ap.add_argument('--base-core', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    src, base, out = args.chromium_src.resolve(), args.base_core.resolve(), args.output.resolve()
    repo = Path(__file__).resolve().parents[1]
    build = src / 'out/Release_Platform_Codecs_Only_x64'
    policy = json.loads((repo / 'patches/chromium/0017-certificate-viewer-ui-disposition.json').read_text())
    version = dict(x.split('=', 1) for x in (src / 'chrome/VERSION').read_text().splitlines())
    assert '.'.join(version[k] for k in ('MAJOR', 'MINOR', 'BUILD', 'PATCH')) == policy['chromium']
    expected = 'ffe32909759d31f096916b6ff3ecc5bc8751a699c31c6a3526089475a4709d27'
    assert sha(base / 'libcef.dll') == expected
    assert shutil.disk_usage(out.parent).free > 25 * 1024**3
    out.mkdir()
    header = next(iter(policy['files']))
    original_header = (src / header).read_bytes()
    assert hashlib.sha256(original_header).hexdigest() == policy['files'][header]['before_sha256']
    dest = out / 'sources' / header
    dest.parent.mkdir(parents=True)
    dest.write_bytes(original_header)
    subprocess.run(['git', 'init', '--quiet', str(out / 'sources')], check=True)
    subprocess.run(['git', '-C', str(out / 'sources'), 'apply', str(repo / 'patches/chromium/0017-certificate-viewer-ui-disposition.patch')], check=True)
    dest.write_bytes(dest.read_bytes().replace(b'\r\n', b'\n'))
    assert sha(dest) == policy['files'][header]['after_sha256']
    source = header.replace('.h', '.cc')
    (out / 'sources' / source).write_bytes((src / source).read_bytes())
    ninja = build / 'obj/chrome/browser/ui/webui/certificate_viewer/certificate_viewer.ninja'
    variables = dict(line.split(' = ', 1) for line in ninja.read_text().splitlines() if ' = ' in line and not line.startswith(' '))
    variables.update({'in': (out / 'sources' / source).as_posix(),
                      'target_out_dir': out.as_posix(), 'label_name': 'objects',
                      'source_name_part': 'certificate_viewer_ui'})
    variables['include_dirs'] = '-I' + (out / 'sources').as_posix() + ' ' + variables['include_dirs']
    toolchain = (build / 'toolchain.ninja').read_text()
    command = toolchain.split('rule cxx\n', 1)[1].splitlines()[0].strip().removeprefix('command = ')
    command = re.sub(r'\$\{([^}]+)\}', lambda m: variables[m[1]], command)
    command = command.replace('$:', ':').replace('$ ', ' ').replace('$$', '$')
    assert '${' not in command
    (out / 'objects').mkdir()
    old_obj = 'obj/chrome/browser/ui/webui/certificate_viewer/certificate_viewer/certificate_viewer_ui.obj'
    response = (base / 'libcef.dll.rsp').read_text()
    assert response.split().count(old_obj) == 1
    old_obj_hash = sha(build / old_obj)
    (out / 'libcef.dll.rsp').write_text(response.replace(old_obj, (out / 'objects/certificate_viewer_ui.obj').as_posix()))
    link = json.loads((base / 'commands.json').read_text())['link'].replace(base.as_posix(), out.as_posix())
    commands = {'compile': command, 'link': link}
    (out / 'commands.json').write_text(json.dumps(commands, indent=2))
    record = {'status': 'prepared', 'base_sha256': expected, 'runtime_validated': False}
    env = os.environ.copy()
    env.update(TEMP=str(src.parents[1] / 'tmp'), TMP=str(src.parents[1] / 'tmp'), DEPOT_TOOLS_UPDATE='0', DEPOT_TOOLS_WIN_TOOLCHAIN='0')
    try:
        for name, cmd in commands.items():
            record['status'] = name
            (out / 'result.json').write_text(json.dumps(record, indent=2))
            start = time.monotonic()
            with (out / (name + '.log')).open('w') as log:
                result = subprocess.run(cmd, executable=str((build / cmd.split(' ', 1)[0]).resolve()), cwd=build, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=14400)
            record[name + '_seconds'] = time.monotonic() - start
            record[name + '_exit_code'] = result.returncode
            print(json.dumps({'phase': name, 'exit': result.returncode, 'seconds': record[name + '_seconds']}), flush=True)
            if result.returncode:
                raise RuntimeError(name + ' failed')
        record.update(status='completed', dll_sha256=sha(out / 'libcef.dll'), dll_bytes=(out / 'libcef.dll').stat().st_size)
    except Exception as e:
        record.update(status='failed', error=str(e))
        raise
    finally:
        record['base_unchanged'] = sha(base / 'libcef.dll') == expected
        record['original_object_unchanged'] = sha(build / old_obj) == old_obj_hash
        record['original_header_unchanged'] = (src / header).read_bytes() == original_header
        (out / 'result.json').write_text(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
