"""Check platform-only candidate behavior/configuration; binary/link audit remains separate."""
import argparse
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('platform_plan', ROOT / 'scripts/prepare-platform-codecs-check.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def positive(value, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value > minimum


def check(directory):
    failures = []
    try:
        plan.validate_args(plan.parse_args((directory / 'effective-args.txt').read_text()))
        plan.inspect_ffmpeg((directory / 'ffmpeg-config_components.h').read_text(), (directory / 'ffmpeg-codec_list.c').read_text())
        includes = (directory / 'ffmpeg-includes.json').read_text()
        if 'config/Chromium/win/x64' not in includes or 'config/Chrome/' in includes:
            failures.append('FFmpeg compilation must select Chromium/win/x64')
        rows = json.loads((directory / 'playback.json').read_text())
        selection = json.loads((directory / 'platform-selection.json').read_text())
        tokens = json.loads((directory / 'tokens.json').read_text(encoding='utf-8-sig'))
        if not isinstance(rows, list) or not all(isinstance(v, dict) for v in rows):
            raise ValueError('playback must be an array of objects')
        if not isinstance(selection, dict) or not isinstance(tokens, list) or not all(isinstance(t, dict) for t in tokens):
            raise ValueError('invalid selection/tokens')
        if 'shutdown_complete' not in (directory / 'smoke.log').read_text().splitlines():
            failures.append('Missing standalone clean-shutdown marker')
        for name in ['bear-1280x720.mp4', 'bear-vp9-opus.webm']:
            matched = [v for v in rows if v.get('file') == name]
            if len(matched) != 1:
                failures.append(name + ': missing/duplicate observation')
                continue
            row = matched[0]
            if not (row.get('ended') is True and row.get('status') == 'playing'
                    and row.get('error') is None and row.get('playError') is None
                    and positive(row.get('decodedFrames')) and positive(row.get('currentTime'), 0.3)
                    and row.get('visibility') == 'visible'):
                failures.append(name + ': successful visible EOF required')
        aac = [v for v in rows if v.get('file') == 'bear-audio-lc-aac.aac']
        if len(aac) != 1 or aac[0].get('status') != 'error' or not aac[0].get('error') or aac[0].get('decodedAudioFrames', 0):
            failures.append('Expected explicit WebAudio AAC refusal; success requires investigation, timeout is not acceptance')
        players = selection.get('players', [])
        if not isinstance(players, list) or not all(isinstance(p, dict) for p in players):
            raise ValueError('invalid players')
        aac_players = [p for p in players if any(t.get('codec') == 'aac' for t in json.loads(p.get('kAudioTracks', '[]')))]
        if not aac_players or not all(p.get('kAudioDecoderName') == 'MediaFoundationAudioDecoder'
                                     and p.get('kIsPlatformAudioDecoder') == 'true'
                                     and p.get('kVideoDecoderName') in ['D3D11VideoDecoder', 'MediaFoundationVideoDecoder']
                                     for p in aac_players):
            failures.append('AAC/H264 must select system decoder paths')
        browser = [t for t in tokens if t.get('Role') == 'browser']
        if len(browser) != 1 or browser[0].get('Error') != 0 or browser[0].get('IntegrityRid') != 8192:
            failures.append('Ordinary Medium browser token required')
        for role in ['gpu-process', 'renderer']:
            found = [t for t in tokens if t.get('Role') == role]
            if not found or not all(t.get('Error') == 0 and t.get('Restricted') and t.get('IntegrityRid', 8192) < 8192 for t in found):
                failures.append('Missing restricted ' + role)
        network = [t for t in tokens if t.get('Subtype') == 'network.mojom.NetworkService']
        if not network or not all(t.get('Error') == 0 and t.get('SandboxType') == 'network' and t.get('AppContainer') == 1 and t.get('IntegrityRid', 8192) <= 4096 for t in network):
            failures.append('Missing Low AppContainer network sandbox')
    except (OSError, ValueError, TypeError, KeyError) as error:
        failures.append('Incomplete/invalid evidence: ' + str(error))
    return {'passed': not failures, 'failures': failures, 'binary_absence_proven': False,
            'scope': 'Behavior, selected config and tokens only; final graph/link/binary identity audit also required',
            'expected_limitation': 'AAC WebAudio unsupported in this experiment'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    result = check(args.directory)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)
