"""Apply the pinned CEF native external-protocol fix; never bypass Chrome policy."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', required=True, type=Path)
    parser.add_argument('--patch', choices=['0012', '0013'], default='0012')
    args = parser.parse_args()
    src = args.chromium_src.resolve(strict=True)
    name = {'0012': '0012-cef-native-external-protocols', '0013': '0013-cef-explicit-numeric-protocol'}[args.patch]
    patch = Path(__file__).resolve().parents[1] / ('patches/chromium/' + name + '.patch')
    policy = json.loads(patch.with_suffix('.json').read_text())
    for relative, identity in policy['files'].items():
        target = (src / relative).resolve(strict=True)
        if not target.is_relative_to(src):
            raise ValueError('Target escapes Chromium checkout')
        current = digest(target)
        if current not in (identity['before_sha256'], identity['after_sha256']):
            raise ValueError(f'Unexpected source: {relative}')
        if current == identity['before_sha256']:
            data = patch.read_bytes().replace(b'\r\n', b'\n')
            subprocess.run(['git', 'apply', '--check', '-'], input=data, cwd=src, check=True)
            subprocess.run(['git', 'apply', '-'], input=data, cwd=src, check=True)
        if digest(target) != identity['after_sha256']:
            raise ValueError('Patched hash mismatch')
    print(json.dumps({'applied': True, 'runtime_validated': False}))


if __name__ == '__main__':
    main()
