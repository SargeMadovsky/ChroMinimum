"""Prepare a pinned Windows system-codec experiment. Never runs GN or a compiler."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OVERRIDES = {'chrominimum_platform_codecs_only': 'true', 'proprietary_codecs': 'true', 'ffmpeg_branding': '"Chromium"',
             'enable_ffmpeg_video_decoders': 'false', 'media_use_openh264': 'false'}
BANNED_CODEC = re.compile(r'(?:aac|h264|openh264|x264)', re.I)


def parse_args(text):
    values = {}
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r'(\w+)\s*=\s*(.+)', line)
        if not match or match[1] in values:
            raise ValueError('Unsupported/duplicate GN argument: ' + line)
        values[match[1]] = match[2].strip()
    return values


def validate_args(values):
    for name, value in OVERRIDES.items():
        if values.get(name) != value:
            raise ValueError('Required argument mismatch: ' + name)
    if values.get('is_debug') != 'false' or values.get('target_cpu') != '"x64"':
        raise ValueError('Expected Windows Release x64 baseline')


def inspect_ffmpeg(config, registry):
    macros = dict(re.findall(r'^#define (CONFIG_\w+) ([01])$', config, re.M))
    relevant = {k: v for k, v in macros.items()
                if BANNED_CODEC.search(k) and k.endswith(('_DECODER', '_ENCODER'))}
    for required in ['CONFIG_AAC_DECODER', 'CONFIG_AAC_FIXED_DECODER', 'CONFIG_H264_DECODER', 'CONFIG_LIBOPENH264_DECODER']:
        if required not in relevant:
            raise ValueError('Missing config macro: ' + required)
    if any(value != '0' for value in relevant.values()):
        raise ValueError('Bundled AAC/H.264 implementation enabled')
    codecs = re.findall(r'&ff_(\w+)', registry)
    if not codecs or any(BANNED_CODEC.search(codec) for codec in codecs):
        raise ValueError('Unexpected FFmpeg codec registry')
    return {'disabled_macros': relevant, 'registered_codecs': codecs}


def prepare(src, output, baseline_args=None):
    pins = json.loads((ROOT / 'patches/chromium/source-build.json').read_text())
    for checkout, expected in [(src, pins['chromium_commit']), (src / 'cef', pins['cef_commit'])]:
        revision = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True, timeout=20).strip()
        if revision != expected:
            raise ValueError('Pinned checkout mismatch: ' + str(checkout))
    output.mkdir(parents=True, exist_ok=False)
    baseline = baseline_args or src / 'out/Release_Media_Official_x64/args.gn'
    values = parse_args(baseline.read_text())
    original = dict(values)
    values.update(OVERRIDES)
    validate_args(values)
    config_dir = src / 'third_party/ffmpeg/chromium/config/Chromium/win/x64'
    files = [config_dir / 'config_components.h', config_dir / 'libavcodec/codec_list.c',
             src / 'third_party/ffmpeg/ffmpeg_options.gni', src / 'third_party/ffmpeg/ffmpeg_generated.gni',
             src / 'third_party/rust/symphonia/v0_6/BUILD.gn', src / 'third_party/webrtc/webrtc.gni']
    audit = inspect_ffmpeg(files[0].read_text(), files[1].read_text())
    symphonia = files[4].read_text()
    if 'symphonia_codec_aac' in symphonia or re.search(r'^\s*"aac",?$', symphonia, re.M):
        raise ValueError('Review Symphonia AAC implementation')
    audit['source_sha256'] = {p.relative_to(src).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    audit['scope'] = 'Pinned source configuration only; not generated build graph or binary proof'
    audit['symphonia_AAC_feature_absent'] = True
    args_text = '\n'.join(f'{k}={v}' for k, v in sorted(values.items())) + '\n'
    (output / 'args.gn').write_text(args_text)
    (output / 'source-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    states = {}
    for number in ['0004-windows-platform-aac', '0005-windows-aac-adts-input', '0006-platform-codecs-only-gn']:
        policy = json.loads((ROOT / ('patches/chromium/' + number + '.json')).read_text())
        for name, identity in policy['files'].items():
            digest = hashlib.sha256((src / name).read_text().encode()).hexdigest()
            states[name] = {'required_after_sha256': identity['after_sha256'], 'current_sha256': digest, 'matches_required': digest == identity['after_sha256']}
    recipe = {'status': 'prepared_not_generated_or_built', 'chromium_commit': pins['chromium_commit'],
              'cef_commit': pins['cef_commit'], 'candidate_output': 'out/Release_Platform_Codecs_Only_x64',
              'patches': ['0001', '0002', '0003', '0004-windows-platform-aac', '0005-windows-aac-adts-input', '0006-platform-codecs-only-gn'],
              'overrides': OVERRIDES, 'baseline_sha256': hashlib.sha256(baseline.read_bytes()).hexdigest(),
              'args_sha256': hashlib.sha256(args_text.encode()).hexdigest(),
              'changed_args': {k: {'before': original.get(k, '<upstream default>'), 'candidate': v} for k, v in OVERRIDES.items()},
              'build_started': False, 'source_modified': False, 'patch_states': states, 'ready_for_full_gn': all(v['matches_required'] for v in states.values()), 'binary_absence_verified': False,
              'expected_limitations': ['WebAudio AAC requires separate work', 'No bundled software H.264 fallback',
                                       'WebRTC bundled H.264 disabled; verify VP8/VP9', 'System codec availability depends on Windows installation'],
              'cost': 'Unknown until GN generation and Ninja dry run; a new output may require extensive compilation, not a 5-minute relink'}
    (output / 'recipe.json').write_text(json.dumps(recipe, indent=2) + '\n')
    return recipe


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--baseline-args', type=Path, help='Accepted official args.gn when preparing another isolated checkout')
    parser.add_argument('--output', type=Path, required=True, help='New preparation directory, outside source output')
    args = parser.parse_args()
    print(json.dumps(prepare(args.chromium_src.resolve(strict=True), args.output.resolve(), args.baseline_args), indent=2))
