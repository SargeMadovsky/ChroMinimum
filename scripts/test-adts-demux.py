"""Compile a small probe against existing pinned FFmpeg archives; never builds CEF."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--cases', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise RuntimeError('Windows pinned toolchain required')
    src = args.chromium_src.resolve(strict=True)
    build = src / 'out/Release_Platform_Codecs_Only_x64'
    cases = args.cases.resolve(strict=True)
    target = args.output.resolve()
    target.mkdir(parents=True, exist_ok=False)
    config = src / 'third_party/ffmpeg/chromium/config/Chromium/win/x64'
    text = (config / 'config_components.h').read_text()
    for macro in ['CONFIG_AAC_DECODER', 'CONFIG_AAC_FIXED_DECODER',
                  'CONFIG_H264_DECODER', 'CONFIG_LIBOPENH264_DECODER']:
        if f'#define {macro} 0\n' not in text:
            raise RuntimeError('Decoder policy mismatch: ' + macro)
    environment = {k.upper(): v for k, v in os.environ.items()}
    for pair in (build / 'environment.x64').read_text().rstrip('\0').split('\0'):
        key, value = pair.split('=', 1)
        if key:
            environment[key.upper()] = value
    environment['TEMP'] = environment['TMP'] = str(src.parents[1] / 'tmp')
    root = Path(__file__).resolve().parents[1]
    compiler = src / 'third_party/llvm-build/Release+Asserts/bin/clang-cl.exe'
    libraries = [build / 'obj/third_party/ffmpeg/ffmpeg_internal.lib',
                 build / 'obj/third_party/ffmpeg/ffmpeg_nasm.lib',
                 build / 'obj/third_party/opus/opus.lib']
    # GN propagates source_set objects to the final executable separately from
    # opus.lib. Reuse the already built objects, preserving its CPU dispatch.
    for name in ['opus_avx2', 'opus_sse41']:
        ninja = build / f'obj/third_party/opus/{name}.ninja'
        if ninja.exists():
            libraries.extend(build / match for match in re.findall(
                r'^build (obj/\S+\.obj): ', ninja.read_text(), re.M))
    probe = target / 'probe.exe'
    command = [str(compiler), '/nologo', '/W3', '/WX', '/O1', '/MT',
               '-fuse-ld=lld', '/D_CRT_SECURE_NO_WARNINGS',
               '/I' + str(config), '/I' + str(src / 'third_party/ffmpeg'),
               str(root / 'tests/native/adts_demux_probe.c'),
               '/Fo' + str(target / 'probe.obj'), '/Fe' + str(probe), '/link',
               *map(str, libraries), 'bcrypt.lib', 'advapi32.lib', 'ole32.lib',
               'user32.lib', 'ws2_32.lib', '/opt:ref', '/opt:icf',
               '/opt:lldltojobs=2', '/incremental:no']
    (target / 'compile-command.json').write_text(json.dumps(command, indent=2))
    with (target / 'compile.log').open('w', encoding='utf-8') as log:
        compiled = subprocess.run(command, cwd=build, env=environment, stdout=log,
                                  stderr=subprocess.STDOUT, timeout=600)
    if compiled.returncode:
        raise RuntimeError('Probe compilation failed; see compile.log')
    results = []
    for case in json.loads((cases / 'cases.json').read_text()):
        fixture = cases / 'fixtures' / case['file']
        executed = subprocess.run([str(probe), str(fixture)], env=environment,
                                  capture_output=True, text=True, timeout=30)
        (target / (case['file'] + '.stderr.txt')).write_text(executed.stderr)
        try:
            row = json.loads(executed.stdout)
        except (ValueError, TypeError):
            results.append({'file': case['file'], 'exit_code': executed.returncode,
                            'passed': False, 'error': 'No valid probe JSON',
                            'stdout': executed.stdout[:1000]})
            continue
        row.update(file=case['file'], exit_code=executed.returncode)
        row['passed'] = (executed.returncode == (0 if case['accepted'] else 2)
                         and row['accepted'] == case['accepted']
                         and not row['aac_decoder_present']
                         and not row['h264_decoder_present'])
        if case['accepted']:
            row['passed'] &= (row['rate'] == case['rate']
                              and row['channels'] == case['channels']
                              and row['asc'] == case['asc']
                              and row['packets'] == case['packets']
                              and abs(row['packet_duration_seconds'] -
                                      case['duration_seconds']) < 0.00001)
        results.append(row)
    report = {'passed': all(r['passed'] for r in results), 'cases': results,
              'probe_sha256': hashlib.sha256(probe.read_bytes()).hexdigest(),
              'source_sha256': hashlib.sha256(
                  (root / 'tests/native/adts_demux_probe.c').read_bytes()).hexdigest(),
              'archives': {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in libraries},
              'scope': 'Demux/parse metadata and packets; no PCM or browser proof'}
    (target / 'result.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'cases': len(results)}))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
