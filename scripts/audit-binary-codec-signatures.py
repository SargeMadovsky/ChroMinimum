"""Scan DLLs for FFmpeg/H.264/AAC decoder signatures. Evidence, not a legal clearance.

Each pattern must be found in the positive control (a build that bundles the codec)
for its absence in the candidate to mean anything; patterns the control lacks are
reported as 'uninformative'. Absence of strings is not a proof of absence of code.
"""
import argparse
import hashlib
import json
import mmap
import struct
from pathlib import Path

# FFmpeg AVCodec long_name strings are stored verbatim in the decoder tables.
PATTERNS = {
    'ffmpeg_h264_long_name': b'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    'ffmpeg_aac_long_name': b'AAC (Advanced Audio Coding)',
    'ffmpeg_aac_latm_long_name': b'AAC LATM (Advanced Audio Coding LATM syntax)',
    'ffmpeg_aac_fixed_long_name': b'AAC (Advanced Audio Coding) (fixed-point)',
    'ffmpeg_h264_cuvid': b'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (CUVID',
    'openh264': b'OpenH264',
    'libopenh264_name': b'libopenh264',
    'ffmpeg_h264_parser_name': b'h264_mp4toannexb',
    'ffmpeg_aac_adtstoasc': b'aac_adtstoasc',
    'platform_mf_audio_decoder': b'MediaFoundationAudioDecoder',
    'platform_mf_video_decoder': b'MediaFoundationVideoDecoder',
    'platform_d3d11_video_decoder': b'D3D11VideoDecoder',
}


def sections(data):
    """Return (image_base, [(raw_offset, raw_size, rva, name)]) of a PE32+ image."""
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    assert data[pe:pe + 4] == b'PE\0\0'
    count = struct.unpack_from('<H', data, pe + 6)[0]
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    assert struct.unpack_from('<H', data, optional)[0] == 0x20B, 'PE32+ expected'
    base = struct.unpack_from('<Q', data, optional + 24)[0]
    table, rows = optional + optional_size, []
    for index in range(count):
        row = table + index * 40
        name = data[row:row + 8].rstrip(b'\0').decode()
        virtual_size, rva, raw_size, raw_offset = struct.unpack_from('<IIII', data, row + 8)
        rows.append((raw_offset, raw_size, rva, name, virtual_size))
    return base, rows


def pointer_refs(data, needle):
    """Count 8-byte absolute pointers to each occurrence of needle (relocated images)."""
    base, rows = sections(data)
    refs = []
    cursor = data.find(needle)
    while cursor != -1:
        for raw, size, rva, name, _ in rows:
            if raw <= cursor < raw + size:
                target = struct.pack('<Q', base + rva + (cursor - raw))
                found, at = [], data.find(target)
                while at != -1:
                    if at % 8 == 0:
                        for r2, s2, v2, n2, _ in rows:
                            if r2 <= at < r2 + s2:
                                found.append(n2)
                    at = data.find(target, at + 1)
                refs.append(dict(string_section=name, pointer_sections=found))
                break
        cursor = data.find(needle, cursor + 1)
    return refs


def scan(path):
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        digest = hashlib.sha256(data).hexdigest()
        counts = {}
        for name, needle in PATTERNS.items():
            ascii_hits = utf16_hits = 0
            for text, bucket in ((needle, 'a'), (needle.decode().encode('utf-16-le'), 'w')):
                cursor = data.find(text)
                while cursor != -1:
                    if bucket == 'a':
                        ascii_hits += 1
                    else:
                        utf16_hits += 1
                    cursor = data.find(text, cursor + 1)
            counts[name] = ascii_hits + utf16_hits
        refs = {name: pointer_refs(data, PATTERNS[name]) for name in
                ('ffmpeg_h264_long_name', 'ffmpeg_aac_long_name', 'ffmpeg_aac_latm_long_name')}
        return dict(path=str(path), bytes=path.stat().st_size, sha256=digest, counts=counts, pointer_refs=refs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    candidate, control = scan(args.candidate), scan(args.control)
    verdict = {}
    for name in PATTERNS:
        c, k = candidate['counts'][name], control['counts'][name]
        verdict[name] = 'uninformative' if k == 0 else ('absent_in_candidate' if c == 0 else 'present_in_candidate')
    result = dict(candidate=candidate, positive_control=control, verdict=verdict,
                  note='String signatures only; absence of a signature is not proof of absent code.')
    args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(dict(candidate=candidate['counts'], control=control['counts'], verdict=verdict), indent=2))


if __name__ == '__main__':
    main()
