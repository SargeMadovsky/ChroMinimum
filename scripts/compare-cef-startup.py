"""Alternate isolated reference/candidate CEF smoke runs with identical adapters.

Both receive the experimental flag. The reference lacks that feature, so its
expected FFmpeg selection is recorded separately from startup/media failures.
No builds, profile reuse, process termination, or system policy changes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def identities(directory):
    return {p.relative_to(directory).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*') if p.is_file()}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--trials', type=int, default=3, choices=range(1, 6))
    parser.add_argument('--candidate-first', action='store_true')
    parser.add_argument('--only-role', choices=('reference', 'candidate'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    runtimes = {'reference': args.reference.resolve(strict=True),
                'candidate': args.candidate.resolve(strict=True)}
    fixtures = args.fixtures.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    hashes = {role: identities(path) for role, path in runtimes.items()}
    assert hashes['reference'].keys() == hashes['candidate'].keys()
    different = [name for name in hashes['reference']
                 if hashes['reference'][name] != hashes['candidate'][name]]
    assert different == ['libcef.dll'], different
    result = {'different_files': different, 'runtime_hashes': hashes, 'runs': [],
              'scope': 'Small sequential diagnostic series; not a performance benchmark'}
    (output / 'results.json').write_text(json.dumps(result, indent=2))
    for trial in range(1, args.trials + 1):
        order = ['reference', 'candidate'] if trial % 2 else ['candidate', 'reference']
        if args.candidate_first:
            order.reverse()
        if args.only_role:
            order = [args.only_role]
        for role in order:
            name = f'{trial}-{role}'
            report = output / name
            started = time.monotonic()
            with (output / (name + '.log')).open('w', encoding='utf-8') as log:
                completed = subprocess.run(['node', str(root / 'scripts/diagnose-media.cjs'),
                                            str(runtimes[role] / 'chrominimum.exe'), str(report),
                                            str(fixtures), '--platform-aac'], cwd=root,
                                           stdout=log, stderr=subprocess.STDOUT, timeout=110)
            # Failed diagnostics leave the browser's bounded native smoke
            # watchdog intact. Wait for its shutdown before the next launch.
            deadline = time.monotonic() + 45
            smoke = report / 'smoke.log'
            while time.monotonic() < deadline:
                text = smoke.read_text(encoding='utf-8') if smoke.exists() else ''
                if 'shutdown_complete' in text.splitlines():
                    break
                time.sleep(0.2)
            shutdown = 'shutdown_complete' in text.splitlines()
            checker = subprocess.run([sys.executable, str(root / 'scripts/check-platform-aac-report.py'),
                                      str(report)], capture_output=True, text=True, timeout=15)
            checked = json.loads(checker.stdout)
            selection = read_json(report / 'platform-selection.json')
            expected_reference = (role == 'reference' and selection is not None and
                                  not selection['selected'] and checked['failures'] ==
                                  ['Media Foundation AAC was not selected'])
            expected_decoder = 'FFmpegAudioDecoder' if role == 'reference' else 'MediaFoundationAudioDecoder'
            decoder_seen = selection is not None and any(
                p.get('kAudioDecoderName') == expected_decoder and
                '"codec":"aac"' in p.get('kAudioTracks', '') for p in selection['players'])
            row = {'trial': trial, 'role': role, 'runner_exit': completed.returncode,
                   'seconds_including_native_watchdog': round(time.monotonic() - started, 2),
                   'initial_load': read_json(report / 'initial-load.json'),
                   'shutdown_complete': shutdown, 'expected_decoder_seen': decoder_seen,
                   'full_scenario_passed': shutdown and decoder_seen and
                       (checked['passed'] or expected_reference), 'checker': checked}
            result['runs'].append(row)
            (output / 'results.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(row), flush=True)
            if not shutdown:
                raise RuntimeError('No clean native shutdown; series stopped to avoid overlapping runs')
    result['runtime_files_unchanged'] = all(identities(path) == hashes[role] for role, path in runtimes.items())
    assert result['runtime_files_unchanged']
    (output / 'results.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
