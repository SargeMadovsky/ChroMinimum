"""Apply only the pinned AAC ADTS fix, after platform-AAC patch 0004."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
NAME = 'media/filters/win/media_foundation_audio_decoder.cc'


def digest(text):
    return hashlib.sha256(text.replace('\r\n', '\n').encode()).hexdigest()


def transform(before, patch):
    lines = before.splitlines(keepends=True)
    result, cursor, pending = [], 0, None
    for line in patch.splitlines(keepends=True):
        if line.startswith(('--- ', '+++ ')):
            continue
        if line.startswith('@@ '):
            match = re.match(r'@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@', line)
            if not match:
                raise ValueError('Invalid hunk')
            start = int(match[1]) - 1
            if start < cursor:
                raise ValueError('Overlapping hunks')
            result.extend(lines[cursor:start])
            cursor, pending = start, True
        elif pending and line[:1] in (' ', '-', '+'):
            kind, value = line[0], line[1:]
            if kind in (' ', '-'):
                if cursor >= len(lines) or lines[cursor] != value:
                    raise ValueError('Patch context mismatch')
                cursor += 1
            if kind in (' ', '+'):
                result.append(value)
        else:
            raise ValueError('Unsupported patch record')
    if pending is None:
        raise ValueError('No patch hunks')
    result.extend(lines[cursor:])
    return ''.join(result)


def apply(source_root, write=False):
    policy = json.loads((ROOT / 'patches/chromium/0005-windows-aac-adts-input.json').read_text())
    identity = policy['files'][NAME]
    target = source_root.resolve(strict=True) / NAME
    before = target.read_text(encoding='utf-8')
    current = digest(before)
    if current == identity['after_sha256']:
        return 'already_applied'
    if current != identity['before_sha256']:
        raise ValueError('Source hash mismatch: require exact platform-AAC 0004 source')
    patch = (ROOT / 'patches/chromium/0005-windows-aac-adts-input.patch').read_text()
    if not patch.startswith('--- a/' + NAME + '\n+++ b/' + NAME + '\n'):
        raise ValueError('Unexpected patch target')
    after = transform(before, patch)
    if digest(after) != identity['after_sha256']:
        raise ValueError('Patched source hash mismatch')
    if write:
        target.write_text(after, encoding='utf-8', newline='\n')
    return 'applied' if write else 'checked_not_written'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Write the one validated source; default is check only')
    args = parser.parse_args()
    print(json.dumps({'status': apply(args.chromium_src, args.apply), 'runtime_validated': False}))
