"""Check PCM/EOF evidence for the fixed eight-case AAC fixture matrix.

This checks content only. Sandbox, decoder provenance and clean shutdown must
be checked separately; a successful result is not release approval.
"""
import argparse
import json
import math
from pathlib import Path


def check(rows):
    failures = []
    expected = {
        'aac-element.adts': None,
        'aac-element.m4a': None,
        'webaudio-offline.aac': (123244, 2, 0.08, 0.12),
        'webaudio-offline.m4a': (123244, 2, 0.08, 0.12),
        'webaudio-live.aac': (123244, 2, 0.08, 0.12),
        'webaudio-live.m4a': (123244, 2, 0.08, 0.12),
        'webaudio-control.wav': (22050, 1, 0.24, 0.25),
        'webaudio-live-control.wav': (22050, 1, 0.24, 0.25),
    }
    if not isinstance(rows, list):
        return ['playback.json must contain an array']
    if len(rows) != len(expected):
        failures.append('Expected exactly eight observations')
    for name, pcm in expected.items():
        matches = [row for row in rows if isinstance(row, dict)
                   and row.get('file') == name]
        if len(matches) != 1:
            failures.append(f'{name}: expected one observation')
            continue
        row = matches[0]
        if row.get('error') or row.get('playError') or row.get('audioError'):
            failures.append(f'{name}: decoder/playback error')
        if pcm is None:
            if row.get('ended') is not True:
                failures.append(f'{name}: EOF not reached')
            continue
        frames, channels, minimum, maximum = pcm
        if (row.get('status') != 'decoded'
                or row.get('decodedAudioFrames') != frames
                or row.get('audioChannels') != channels
                or row.get('audioSampleRate') != 44100):
            failures.append(f'{name}: unexpected decoded PCM dimensions')
        peak = row.get('audioPeak')
        if (not isinstance(peak, (float, int)) or isinstance(peak, bool)
                or not math.isfinite(peak) or not minimum < peak < maximum):
            failures.append(f'{name}: missing/invalid/nonmatching PCM peak')
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        failures = check(json.loads((args.report / 'playback.json').read_text(
            encoding='utf-8-sig')))
    except (OSError, ValueError) as error:
        failures = [str(error)]
    print(json.dumps({'passed': not failures, 'scope': 'fixture PCM and EOF only',
                      'failures': failures}, indent=2))
    raise SystemExit(bool(failures))


if __name__ == '__main__':
    main()
