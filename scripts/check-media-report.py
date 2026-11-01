"""Check local codec probe evidence; does not certify sandbox, TLS or real sites."""
import argparse
import json
import math
from pathlib import Path


def positive(value, minimum=0):
    return (type(value) in (int, float) and (type(value) is int or math.isfinite(value))
            and value > minimum)


def check(directory):
    failures = []
    try:
        playback = json.loads((directory / 'playback.json').read_text(encoding='utf-8'))
        log = (directory / 'smoke.log').read_text(encoding='utf-8')
    except (OSError, ValueError) as error:
        return {'passed': False, 'failures': [f'Cannot read evidence: {error}']}
    if not isinstance(playback, list) or not all(isinstance(row, dict) for row in playback):
        return {'passed': False, 'failures': ['playback.json must be an array of objects']}
    if 'shutdown_complete' not in log.splitlines():
        failures.append('Missing standalone shutdown_complete marker')
    required = ('bear-1280x720.mp4', 'bear-vp9-opus.webm', 'bear-audio-lc-aac.aac')
    for name in required:
        rows = [row for row in playback if row.get('file') == name]
        if len(rows) != 1:
            failures.append(f'{name}: expected exactly one observation, got {len(rows)}')
            continue
        row = rows[0]
        if row.get('error') is not None:
            failures.append(f'{name}: reported media error')
        if name.endswith('.aac'):
            if not (row.get('status') == 'decoded'
                    and positive(row.get('decodedAudioFrames'))
                    and positive(row.get('audioChannels'))
                    and positive(row.get('audioSampleRate'))
                    and positive(row.get('audioPeak'))):
                failures.append(f'{name}: missing successful non-silent PCM decode')
        elif not (row.get('status') == 'playing'
                  and row.get('playError') is None
                  and positive(row.get('currentTime'), 0.3)
                  and positive(row.get('decodedFrames'))
                  and type(row.get('readyState')) is int and row['readyState'] >= 2):
            failures.append(f'{name}: missing successful video playback')
    return {'passed': not failures, 'failures': failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Output of diagnose-media.cjs with fixtures')
    args = parser.parse_args()
    result = check(args.directory)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
