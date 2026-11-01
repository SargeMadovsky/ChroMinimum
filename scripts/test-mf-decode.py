"""Exercise a separately built MF probe on pinned local fixtures; no browser or network."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    fixtures = args.fixtures.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    pinned = {item['file']: item for item in json.loads((fixtures / 'sources.json').read_text())}
    for name in ['bear-1280x720.mp4', 'bear-audio-lc-aac.aac']:
        assert sha(fixtures / name) == pinned[name]['sha256'], name
    cases = [('h264', 'h264', 'bear-1280x720.mp4', True),
             ('aac', 'aac', 'bear-audio-lc-aac.aac', True),
             ('wrong-stream', 'h264', 'bear-audio-lc-aac.aac', False),
             ('missing', 'aac', 'does-not-exist.aac', False)]
    results = []
    for name, mode, file, expected in cases:
        start = time.perf_counter()
        completed = subprocess.run([str(exe), mode, str(fixtures / file)],
                                   capture_output=True, text=True, timeout=45)
        result = json.loads(completed.stdout)
        row = dict(case=name, fixture=file, exit_code=completed.returncode,
                   seconds=time.perf_counter()-start, result=result, stderr=completed.stderr)
        results.append(row)
        (output / 'results.json').write_text(json.dumps(results, indent=2))
        assert result['passed'] == expected and (completed.returncode == 0) == expected, row
        if expected:
            assert result['eos'] and result['samples'] > 1 and result['nonzero_bytes'] > 0
            assert result['last_100ns'] > result['first_100ns']
            assert result['decoder_in_system_directory'], row
            if mode == 'aac':
                assert result['output'] == 'PCM16' and result['pcm_peak'] > 0
                assert result['pcm_frames'] > 0 and result['channels'] == 2 and result['sample_rate'] == 48000
            else:
                assert result['output'] == 'NV12' and (result['width'], result['height']) == (1280, 720)
                assert result['bytes'] == result['samples'] * 1280 * 720 * 3 // 2
        print(json.dumps(row), flush=True)
    metadata = dict(passed=True, windows=platform.platform(),
                    probe_bytes=exe.stat().st_size, probe_sha256=sha(exe),
                    source_sha256=sha(Path(__file__).with_name('probe-mf-decode.cc')),
                    cef_launched=False, browser_sandbox_tested=False,
                    hardware_transforms_enabled=False, dxva_disabled=True,
                    new_cef_build_started=False, fixture_sha256={name: pinned[name]['sha256'] for name in
                        ['bear-1280x720.mp4', 'bear-audio-lc-aac.aac']})
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    main()
