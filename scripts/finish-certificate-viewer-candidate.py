"""Bounded one-shot continuation of an already running isolated build."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time


def digest(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--core', type=Path, required=True)
    ap.add_argument('--base-runtime', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    core, base, out = args.core.resolve(), args.base_runtime.resolve(), args.output.resolve()
    out.mkdir()
    report = {'status': 'waiting-build', 'runtime_validated': False}
    def save():
        (out / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    save()
    try:
        deadline = time.monotonic() + 14400
        while time.monotonic() < deadline:
            try:
                build = json.loads((core / 'result.json').read_text())
            except json.JSONDecodeError:
                time.sleep(1)
                continue
            if build['status'] == 'failed':
                raise RuntimeError('Build failed: ' + build.get('error', ''))
            if build['status'] == 'completed':
                break
            time.sleep(5)
        else:
            raise TimeoutError('Build did not finish within four hours')
        assert digest(core / 'libcef.dll') == build['dll_sha256']
        assert all(build[k] for k in ('base_unchanged', 'original_object_unchanged', 'original_header_unchanged'))
        runtime = out / 'runtime'
        shutil.copytree(base, runtime)
        shutil.copy2(core / 'libcef.dll', runtime / 'libcef.dll')
        subprocess.run(['icacls', str(runtime), '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], check=True, capture_output=True)
        differences = [p.name for p in base.iterdir() if p.is_file() and digest(p) != digest(runtime / p.name)]
        assert differences == ['libcef.dll']
        report.update(status='testing', changed_files=differences, core=build)
        save()
        exe = str(runtime / 'chrominimum.exe')
        for name, command in (
            ('viewer', ['node', 'scripts/test-certificate-viewer.cjs', exe, str(out / 'viewer')]),
            ('ssl-ru', ['node', 'scripts/test-native-security-panel.cjs', exe, str(out / 'ssl-ru'), '--ru']),
        ):
            report['phase'] = name
            save()
            with (out / (name + '.log')).open('w', encoding='utf-8') as log:
                p = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=900)
            report[name + '_exit_code'] = p.returncode
            save()
            if p.returncode:
                raise RuntimeError(name + ' failed; inspect log')
        viewer = json.loads((out / 'viewer/result.json').read_text())
        assert not viewer['newBrowserInfoTimeouts']
        assert all(c['loadMs'] < 1000 for c in viewer['cases']), 'Viewer still takes >= 1s'
        tokens = json.loads((out / 'viewer/tokens.json').read_text(encoding='utf-8-sig'))
        renderers = [t for t in tokens if t['Role'] == 'renderer']
        network = [t for t in tokens if t.get('Subtype') == 'network.mojom.NetworkService']
        assert renderers and all(t['Restricted'] and not t['Error'] for t in renderers)
        assert network and all(t['AppContainer'] == 1 and t['IntegrityRid'] == 4096 and not t['Error'] for t in network)
        report.update(status='completed', runtime_validated=True, viewer=viewer)
    except Exception as e:
        report.update(status='failed', error=str(e))
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
