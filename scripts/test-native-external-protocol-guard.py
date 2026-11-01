"""Compile/run the actual patched guard block with mock Chromium value types.

Run in the MSVC developer shell. This tests the guard, not the native UI.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    policy = json.loads((root/'patches/chromium/0012-cef-native-external-protocols.json').read_text())
    relative, identity = next(iter(policy['files'].items()))
    text = (args.chromium_src/relative).read_text()
    if hashlib.sha256(text.encode()).hexdigest() != identity['after_sha256']:
        raise ValueError('Actual patched CEF source required')
    start = text.index('  if (!initiator_rfh) {', text.index('void HandleExternalProtocolHelper('))
    end = text.index('  // Match the logic', start)
    body = text[start:end]
    if body.count('      return;') != 1:
        raise ValueError('Review guard fixture for changed control flow')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output/'native_external_protocol_guard.inc').write_text(body.replace('      return;', '      return false;'))
    exe = output/'guard.exe'
    subprocess.run(['cl','/nologo','/EHsc','/std:c++17','/I'+str(output),'/Fo'+str(output/'guard.obj'),'/Fe'+str(exe),str(root/'tests/native/external_protocol_guard.cc')],check=True)
    subprocess.run([str(exe)],check=True)
    print(json.dumps({'guard_cases':9,'passed':True,'chromium_runtime_test':False}))


if __name__ == '__main__':
    main()
