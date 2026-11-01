"""Exercise the exact 0006 GN guards in an isolated minimal GN project; no compiler."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    meta = json.loads((ROOT / 'patches/chromium/0006-platform-codecs-only-gn.json').read_text())
    original = (args.chromium_src / 'media/BUILD.gn').read_text()
    spec = importlib.util.spec_from_file_location('patcher', ROOT / 'scripts/apply-platform-aac-adts.py')
    patcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(patcher)
    assert patcher.digest(original) == meta['files']['media/BUILD.gn']['before_sha256']
    patched = patcher.transform(original, (ROOT / 'patches/chromium/0006-platform-codecs-only-gn.patch').read_text())
    assert patcher.digest(patched) == meta['files']['media/BUILD.gn']['after_sha256']
    policy = patched[patched.index('# Explicit, default-off'):patched.index('# Common configuration')]
    (output / 'policy.gni').write_text(policy)
    (output / '.gn').write_text('buildconfig = "//BUILDCONFIG.gn"\n')
    (output / 'BUILDCONFIG.gn').write_text('''declare_args() {
  is_win = true
  proprietary_codecs = true
  media_use_ffmpeg = true
  ffmpeg_branding = "Chrome"
  enable_ffmpeg_video_decoders = false
  media_use_openh264 = false
}
set_default_toolchain("//:default")
''')
    (output / 'BUILD.gn').write_text('''import("//policy.gni")
toolchain("default") {
  tool("stamp") {
    command = "cmd /c exit 0"
    description = "Policy-only graph, never executed"
  }
}
group("proof") {}
''')
    cases = [
        ('unchanged_chrome', '', True),
        ('unchanged_guard', 'ffmpeg_branding="Chromium"', False),
        ('candidate', 'ffmpeg_branding="Chromium" chrominimum_platform_codecs_only=true', True),
        ('wrong_os', 'ffmpeg_branding="Chromium" chrominimum_platform_codecs_only=true is_win=false', False),
        ('chrome_with_optin', 'chrominimum_platform_codecs_only=true', False),
        ('openh264', 'ffmpeg_branding="Chromium" chrominimum_platform_codecs_only=true media_use_openh264=true', False),
        ('ffmpeg_video', 'ffmpeg_branding="Chromium" chrominimum_platform_codecs_only=true enable_ffmpeg_video_decoders=true', False),
        ('no_registration', 'ffmpeg_branding="Chromium" chrominimum_platform_codecs_only=true proprietary_codecs=false', False),
    ]
    results = []
    gn = args.chromium_src.resolve() / 'buildtools/win/gn.exe'
    for name, flags, expected in cases:
        done = subprocess.run([str(gn), '--root=' + str(output), 'gen', str(output / ('out-' + name)), '--args=' + flags], capture_output=True, text=True, timeout=20)
        (output / (name + '.log')).write_text(done.stdout + done.stderr)
        results.append({'name': name, 'exit': done.returncode, 'expected_success': expected})
        assert (done.returncode == 0) == expected, name + ': ' + done.stdout + done.stderr
    (output / 'result.json').write_text(json.dumps({'passed': True, 'scope': 'exact GN policy in minimal project, not full Chromium graph', 'cases': results}, indent=2))
    print('8 GN policy cases passed; no native build executed')


if __name__ == '__main__':
    main()
