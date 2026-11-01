"""Apply the pinned ring patch after 0005, refusing unknown source inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--single-page-downloads', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    patch_name = '0015-download-history-current-tab' if args.single_page_downloads else '0014-download-progress-ring'
    policy = json.loads((repo / f'patches/chromium/{patch_name}.json').read_text())
    src = args.chromium_src.resolve(strict=True)
    version = dict(line.split('=', 1) for line in (src / 'chrome/VERSION').read_text().splitlines() if '=' in line)
    if '.'.join(version[k] for k in ('MAJOR', 'MINOR', 'BUILD', 'PATCH')) != policy['chromium']:
        raise ValueError('Chromium version needs review')
    states = [digest(src / name) for name in policy['files']]
    before = [row['before_sha256'] for row in policy['files'].values()]
    after = [row['after_sha256'] for row in policy['files'].values()]
    if states == after:
        print('Already applied')
        return
    if states != before:
        raise ValueError('Unknown source input; require exact predecessor postimage')
    patch = repo / f'patches/chromium/{patch_name}.patch'
    subprocess.run(['git', '-C', str(src), 'apply', '--check', str(patch)], check=True)
    subprocess.run(['git', '-C', str(src), 'apply', str(patch)], check=True)
    assert [digest(src / name) for name in policy['files']] == after
    print('Applied; runtime not yet validated')


if __name__ == '__main__':
    main()
