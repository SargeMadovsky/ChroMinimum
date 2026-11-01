"""Link an isolated AAC experiment from the pinned, already compiled GN output.

Does not invoke Ninja or modify the original source/object/runtime files.
The existing GN solink/alink commands and explicit inputs are preserved, with
three validated object substitutions and all outputs redirected to --output.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def block(path, prefix):
    lines = path.read_text(encoding='utf-8').splitlines()
    index = next(i for i, line in enumerate(lines) if line.startswith(prefix))
    result = [lines[index]]
    for line in lines[index + 1:]:
        if not line.startswith('  '):
            break
        result.append(line)
    return result


def expand(value, variables):
    for _ in range(8):
        updated = re.sub(r'\$\{(\w+)\}', lambda m: variables[m[1]], value)
        if updated == value:
            break
        value = updated
    if '${' in value:
        raise ValueError('Unresolved GN variable')
    return value.replace('$:', ':').replace('$$', '$')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--objects', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    src = args.chromium_src.resolve(strict=True)
    out = src / 'out/Release_Media_Official_x64'
    objects = args.objects.resolve(strict=True)
    target = args.output.resolve()
    target.mkdir(parents=True, exist_ok=False)
    policy = json.loads((root / 'patches/chromium/0004-windows-platform-aac.json').read_text())
    compilation = json.loads((objects / 'compile.json').read_text())
    assert compilation['passed'] and len(compilation['objects']) == 3
    replacements = {}
    for index, (name, identity) in enumerate(policy['files'].items()):
        assert digest(src / name) == identity['before_sha256'], name
        row = compilation['objects'][index]
        obj = objects / f'{index}.obj'
        assert row['source'] == name and hashlib.sha256(obj.read_bytes()).hexdigest() == row['sha256']
        replacements[name] = obj.as_posix()
    original_dll = out / 'libcef.dll'
    original_hash = hashlib.sha256(original_dll.read_bytes()).hexdigest()
    assert original_hash == 'ef8d6219fb826b586ca25b60f6583ba0c1453cb9172051521a02f5fb8057e020'

    archive_name = 'obj/media/mojo/services/media_mojo_services.lib'
    archive = block(out / 'obj/media/mojo/services/services.ninja', 'build ' + archive_name + ':')
    dll = block(out / 'obj/cef/libcef.ninja', 'build ./libcef.dll ')
    rules = {name: block(out / 'toolchain.ninja', 'rule ' + name) for name in ('alink', 'solink')}

    def command(edge, rule, output_name, swaps):
        inputs = edge[0].split(': ' + rule + ' ', 1)[1].split(' |', 1)[0]
        for before, after in swaps.items():
            assert inputs.split().count(before) == 1, before
            inputs = inputs.replace(before, after)
        variables = {line.split('=', 1)[0].strip(): line.split('=', 1)[1].strip() for line in edge[1:]}
        variables.update(out=(target / output_name).as_posix(),
                         output_dir=target.as_posix(), target_output_name='libcef',
                         in_newline=inputs.replace(' ', '\n'))
        for default in ('solibs', 'libs', 'rlibs', 'arflags'):
            variables.setdefault(default, '')
        response = next(line.split(' = ', 1)[1] for line in rules[rule] if line.startswith('  rspfile_content = '))
        rsp = target / (output_name + '.rsp')
        content = expand(response, variables)
        if rule == 'solink':
            # Keep the existing cache read/write policy and bound LTO concurrency.
            content = content.replace('/opt:lldltojobs=all', '/opt:lldltojobs=2')
        rsp.write_text(content, encoding='utf-8')
        template = next(line.split(' = ', 1)[1] for line in rules[rule] if line.startswith('  command = '))
        return expand(template, variables)

    archive_command = command(archive, 'alink', 'media_mojo_services.lib', {
        'obj/media/mojo/services/services/gpu_mojo_media_client_win.obj':
            replacements['media/mojo/services/gpu_mojo_media_client_win.cc']})
    dll_command = command(dll, 'solink', 'libcef.dll', {
        'obj/media/filters/filters/media_foundation_audio_decoder.obj':
            replacements['media/filters/win/media_foundation_audio_decoder.cc'],
        'obj/media/renderers/renderers/default_decoder_factory.obj':
            replacements['media/renderers/default_decoder_factory.cc'],
        archive_name: (target / 'media_mojo_services.lib').as_posix()})
    commands = [archive_command, dll_command]
    (target / 'commands.json').write_text(json.dumps(commands, indent=2))
    result = {'linked': False, 'runtime_validated': False, 'original_dll_sha256': original_hash}
    (target / 'patch-metadata.json').write_text(json.dumps(policy, indent=2))
    if args.prepare_only:
        print('Prepared isolated archive and DLL commands; no linker executed')
        return
    linker = src / 'third_party/llvm-build/Release+Asserts/bin/lld-link.exe'
    try:
        for index, cmd in enumerate(commands):
            start = time.monotonic()
            with (target / f'link-{index}.log').open('w', encoding='utf-8') as log:
                completed = subprocess.run(cmd, executable=str(linker), cwd=out,
                                           stdout=log, stderr=subprocess.STDOUT, timeout=7200)
            print(f'link step {index}: exit={completed.returncode}, seconds={time.monotonic()-start:.1f}', flush=True)
            assert completed.returncode == 0, f'Inspect link-{index}.log'
        result['linked'] = True
        result['dll_sha256'] = hashlib.sha256((target / 'libcef.dll').read_bytes()).hexdigest()
        result['dll_bytes'] = (target / 'libcef.dll').stat().st_size
    finally:
        result['original_dll_unchanged'] = hashlib.sha256(original_dll.read_bytes()).hexdigest() == original_hash
        (target / 'result.json').write_text(json.dumps(result, indent=2))
        assert result['original_dll_unchanged']


if __name__ == '__main__':
    main()
