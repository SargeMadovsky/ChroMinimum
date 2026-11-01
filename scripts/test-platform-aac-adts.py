"""Guard checks and native payload-boundary tests; requires MSVC developer shell."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-source', type=Path, required=True, help='Exact MF source after patch 0004')
    parser.add_argument('--output', type=Path, required=True, help='New output directory')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('adts_apply', ROOT / 'scripts/apply-platform-aac-adts.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source_root = output / 'fixture'
    source = source_root / module.NAME
    source.parent.mkdir(parents=True)
    shutil.copyfile(args.base_source, source)
    before = source.read_bytes()
    assert module.apply(source_root) == 'checked_not_written'
    assert source.read_bytes() == before
    assert module.apply(source_root, True) == 'applied'
    after = source.read_text()
    assert module.apply(source_root, True) == 'already_applied'
    source.write_text(after + '\n// changed upstream\n')
    try:
        module.apply(source_root, True)
    except ValueError:
        pass
    else:
        raise AssertionError('Changed upstream accepted')
    source.write_text(after)
    start = after.index('// MSE\'s MP4 parser can prefix')
    end = after.index('bool PopulateInputSample(', start)
    (output / 'adts-helper.inc').write_text(after[start:end])
    command = ['cl', '/nologo', '/W4', '/WX', '/O2', '/MT', '/EHsc', '/std:c++20',
               '/I' + str(output), str(ROOT / 'tests/native/aac_adts_payload_test.cc'),
               '/Fe:' + str(output / 'test-helper.exe'), '/Fo:' + str(output / 'test-helper.obj')]
    subprocess.run(command, check=True)
    subprocess.run([str(output / 'test-helper.exe')], check=True)
    (output / 'result.json').write_text(json.dumps({'passed': True, 'scope': 'application guards and native payload tests; not CEF playback'}, indent=2))
    print('ADTS source guards and native payload tests passed')


if __name__ == '__main__':
    main()
