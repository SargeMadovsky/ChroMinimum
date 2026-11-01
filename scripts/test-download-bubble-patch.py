"""Check download patch input guards on disposable source copies (no CEF build)."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--chromium-src', required=True, type=Path)
    a = p.parse_args()
    repo = Path(__file__).resolve().parents[1]
    policy = json.loads((repo / 'patches/chromium/0005-download-bubble-anchor.json').read_text())
    with tempfile.TemporaryDirectory(prefix='ChroMinimum-download-patch-') as folder:
        fixture = Path(folder)
        for name, identity in policy['files'].items():
            source = a.chromium_src / name
            assert hashlib.sha256(source.read_bytes().replace(b'\r\n', b'\n')).hexdigest() == identity['before_sha256']
            target = fixture / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        shutil.copyfile(a.chromium_src / 'chrome/VERSION', fixture / 'chrome/VERSION')
        subprocess.run(['git', 'init', '--quiet', str(fixture)], check=True)
        command = [sys.executable, str(repo / 'scripts/apply-cef-patches.py'),
                   '--chromium-src', str(fixture), '--download-ui']
        for _ in range(2):
            result = subprocess.run(command, capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)['status'] == 'download_ui_patch_applied_not_runtime_validation'
        name = next(iter(policy['files']))
        patched = (fixture / name).read_bytes()
        shutil.copyfile(a.chromium_src / name, fixture / name)
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0 and 'Partial' in result.stderr
        (fixture / name).write_bytes(patched + b'\n// unexpected input\n')
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0 and 'Upstream file changed' in result.stderr
        (fixture / name).write_bytes(patched)
        (fixture / 'chrome/VERSION').write_text('MAJOR=999\nMINOR=0\nBUILD=0\nPATCH=0\n')
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0 and 'needs a reviewed patch' in result.stderr
    print(json.dumps({'apply': True, 'reapply': True, 'partial_rejected': True,
                      'modified_rejected': True, 'version_rejected': True}))


if __name__ == '__main__':
    main()
