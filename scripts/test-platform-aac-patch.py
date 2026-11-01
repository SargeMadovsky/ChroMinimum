"""Verify the pinned multi-file patch on isolated source fixtures, never the live checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = args.chromium_src.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    policy = json.loads((ROOT / 'patches/chromium/0004-windows-platform-aac.json').read_text())
    command = ['git', '-c', f'safe.directory={source.as_posix()}', '-C', str(source)]
    originals = {name: subprocess.check_output(command + ['show', policy['chromium_commit'] + ':' + name])
                 for name in [*policy['files'], 'chrome/VERSION']}
    for name, identity in policy['files'].items():
        assert hashlib.sha256(originals[name]).hexdigest() == identity['before_sha256']
    rows = []

    def fixture(name):
        directory = output / name
        directory.mkdir()
        for relative, content in originals.items():
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        subprocess.run(['git', 'init', '-q', str(directory)], check=True)
        return directory

    def run(directory, expected):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/apply-cef-patches.py'),
                                 '--chromium-src', str(directory), '--platform-aac'],
                                capture_output=True, text=True, timeout=30)
        rows.append(dict(case=directory.name, exit_code=result.returncode,
                         stdout=result.stdout, stderr=result.stderr))
        assert (result.returncode == 0) == expected, rows[-1]

    normal = fixture('apply-and-reapply')
    run(normal, True)
    for name, identity in policy['files'].items():
        assert digest(normal / name) == identity['after_sha256']
    before = {name: (normal / name).read_bytes() for name in policy['files']}
    run(normal, True)
    assert all((normal / name).read_bytes() == data for name, data in before.items())
    changed = fixture('changed-upstream')
    target = changed / list(policy['files'])[1]
    target.write_bytes(target.read_bytes() + b'\n// fixture change\n')
    before = {name: (changed / name).read_bytes() for name in policy['files']}
    run(changed, False)
    assert all((changed / name).read_bytes() == data for name, data in before.items())
    partial = fixture('partial-patch')
    name = next(iter(policy['files']))
    (partial / name).write_bytes((normal / name).read_bytes())
    before = {name: (partial / name).read_bytes() for name in policy['files']}
    run(partial, False)
    assert all((partial / name).read_bytes() == data for name, data in before.items())
    wrong = fixture('wrong-version')
    (wrong / 'chrome/VERSION').write_text('MAJOR=154\nMINOR=0\nBUILD=8037\nPATCH=99\n')
    run(wrong, False)
    assert all(digest(wrong / name) == item['before_sha256'] for name, item in policy['files'].items())
    (output / 'results.json').write_text(json.dumps(dict(passed=True, checks=rows), indent=2))
    print('5 patch checks passed; no live source writes or compilation')


if __name__ == '__main__':
    main()
