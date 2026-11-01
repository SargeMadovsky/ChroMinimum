"""Apply the pinned ChroMinimum source patches before compiling CEF.

Accepts an existing Chromium src checkout. Refuses changed upstream files;
new CEF versions require reviewing and repinning the patch metadata.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def apply_platform_aac(src, policy, patch, status='platform_aac_patch_applied_not_runtime_validation'):
    # Validate all inputs before applying any file from this multi-file patch.
    current = {}
    for name, identity in policy['files'].items():
        target = (src / name).resolve(strict=True)
        if not target.is_relative_to(src):
            raise ValueError('Patch target escapes checkout')
        current[name] = digest(target)
        if current[name] not in (identity['before_sha256'], identity['after_sha256']):
            raise ValueError(f'Upstream file changed: {name}')
    before = all(current[name] == identity['before_sha256'] for name, identity in policy['files'].items())
    after = all(current[name] == identity['after_sha256'] for name, identity in policy['files'].items())
    if not before and not after:
        raise ValueError('Partial platform patch detected; review the checkout')
    if before:
        data = patch.read_bytes().replace(b'\r\n', b'\n')
        subprocess.run(['git', 'apply', '--check', '-'], input=data, cwd=src, check=True)
        subprocess.run(['git', 'apply', '-'], input=data, cwd=src, check=True)
    for name, identity in policy['files'].items():
        if digest(src / name) != identity['after_sha256']:
            raise ValueError(f'Patched source hash mismatch: {name}')
    print(json.dumps({'status': status,
                      'files': len(current), 'runtime_validated': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--verify-unpatched', action='store_true',
                        help='Only verify the original source for the separate media experiment')
    parser.add_argument('--build-fixes', action='store_true',
                        help='Apply the pinned build-only MIDL locale normalization')
    parser.add_argument('--runtime-fixes', action='store_true',
                        help='Apply the pinned instance tracer reentrancy fix')
    parser.add_argument('--platform-aac', action='store_true',
                        help='Apply the separate experimental Windows platform AAC patch')
    parser.add_argument('--download-ui', action='store_true',
                        help='Apply the optional native download bubble anchor patch (requires a core rebuild)')
    args = parser.parse_args()
    if sum((args.verify_unpatched, args.build_fixes, args.runtime_fixes, args.platform_aac, args.download_ui)) > 1:
        parser.error('Select only one patch/verification mode')
    src = args.chromium_src.resolve(strict=True)
    project = Path(__file__).resolve().parents[1]
    metadata = project / ('patches/chromium/0005-download-bubble-anchor.json'
                          if args.download_ui else 'patches/chromium/0004-windows-platform-aac.json'
                          if args.platform_aac else 'patches/chromium/0003-instance-tracer-untrace-reentrancy.json'
                          if args.runtime_fixes else 'patches/chromium/0002-deterministic-midl-name-hash.json'
                          if args.build_fixes else 'patches/chromium/0001-no-startup-listaccounts.json')
    patch = metadata.with_suffix('.patch')
    policy = json.loads(metadata.read_text(encoding='utf-8'))
    version = dict(line.split('=', 1) for line in
                   (src / 'chrome/VERSION').read_text().splitlines() if '=' in line)
    actual_version = '.'.join(version[key] for key in ('MAJOR', 'MINOR', 'BUILD', 'PATCH'))
    if actual_version != policy['chromium']:
        raise ValueError(f'Chromium {actual_version} needs a reviewed patch; expected {policy["chromium"]}')
    if args.platform_aac:
        apply_platform_aac(src, policy, patch)
        return
    if args.download_ui:
        apply_platform_aac(src, policy, patch, 'download_ui_patch_applied_not_runtime_validation')
        return
    target = (src / policy['path']).resolve(strict=True)
    if not target.is_relative_to(src):
        raise ValueError('Patch target escapes checkout')
    current = digest(target)
    if args.verify_unpatched:
        if current != policy['before_sha256']:
            raise ValueError('Media experiment requires the original source without the ListAccounts patch')
        print(json.dumps({'status': 'original_source_verified', 'source_sha256': current}))
        return
    if current == policy['before_sha256']:
        # Windows checkout line endings must not alter the unified diff.
        patch_bytes = patch.read_bytes().replace(b'\r\n', b'\n')
        subprocess.run(['git', 'apply', '--check', '-'], input=patch_bytes, cwd=src, check=True)
        subprocess.run(['git', 'apply', '-'], input=patch_bytes, cwd=src, check=True)
    elif current != policy['after_sha256']:
        raise ValueError('Upstream file changed: review patch instead of building an unpatched core')
    if digest(target) != policy['after_sha256']:
        raise ValueError('Patched source hash mismatch')
    print(json.dumps({'status': 'source_patch_applied_not_build_validation',
                      'chromium': actual_version,
                      'source_sha256': policy['after_sha256'],
                      'required_enabled_feature': policy['required_enabled_feature']}))


if __name__ == '__main__':
    main()
