"""Audit selected generated link inputs; this is not a binary-absence proof."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def thin_members(path):
    data = path.read_bytes()
    if data[:8] != b'!<thin>\n':
        raise ValueError('Expected GNU thin archive')
    cursor, names, members = 8, b'', []
    while cursor < len(data):
        header = data[cursor:cursor + 60]
        if len(header) != 60 or header[58:60] != b'`\n':
            raise ValueError('Malformed archive header')
        cursor += 60
        name, size = header[:16].decode().strip(), int(header[48:58])
        if name in ('/', '//', '/SYM64/'):
            if cursor + size > len(data):
                raise ValueError('Truncated archive index')
            if name == '//':
                names = data[cursor:cursor + size]
            cursor += size + size % 2
        else:
            if not name.startswith('/') or not name[1:].isdigit():
                raise ValueError('Unsupported thin member name')
            offset = int(name[1:])
            members.append(names[offset:names.index(b'\n', offset)].decode().removesuffix('/'))
    if not members or len(set(members)) != len(members):
        raise ValueError('Empty or duplicate archive members')
    return members


def audit(source, output, candidate):
    spec = importlib.util.spec_from_file_location('policy', Path(__file__).with_name('prepare-platform-codecs-check.py'))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    args_path = output / 'args.gn'
    policy.validate_args(policy.parse_args(args_path.read_text()))
    config = source / 'third_party/ffmpeg/chromium/config/Chromium/win/x64'
    components, registry = config / 'config_components.h', config / 'libavcodec/codec_list.c'
    codec_policy = policy.inspect_ffmpeg(components.read_text(), registry.read_text())
    graph = output / 'obj/third_party/ffmpeg/ffmpeg_internal.ninja'
    text = graph.read_text()
    if '-I../../third_party/ffmpeg/chromium/config/Chromium/win/x64' not in text:
        raise ValueError('Generated compiler flags do not select Chromium config')
    edges = [line for line in text.splitlines() if line.startswith('build ')]
    compile_edges = {}
    for edge in edges:
        match = re.match(r'build (\S+): (?:cc|cxx) (\S+)', edge)
        if match:
            compile_edges[match[1]] = match[2]
    forbidden = re.compile(r'/libavcodec/(?:aac/|aacdec|h264dec)|/third_party/openh264/src/codec/', re.I)
    if any(forbidden.search(value) for value in compile_edges.values()):
        raise ValueError('Forbidden decoder implementation source in FFmpeg compile edges')
    archive = output / 'obj/third_party/ffmpeg/ffmpeg_internal.lib'
    members = thin_members(archive)
    records = []
    for name in members:
        path = (archive.parent / name).resolve()
        relative = path.relative_to(output.resolve()).as_posix()
        if relative not in compile_edges:
            raise ValueError('Thin member missing compile edge: ' + relative)
        records.append({'object': relative, 'source': compile_edges[relative],
                        'sha256': digest(path), 'bytes': path.stat().st_size})
    if len(records) != len(compile_edges):
        raise ValueError('Compile/archive member counts differ')
    link_graph = output / 'obj/cef/libcef.ninja'
    links = [line for line in link_graph.read_text().splitlines()
             if line.startswith('build ') and ': solink' in line]
    if len(links) != 1:
        raise ValueError('Expected one libcef solink edge')
    inputs = links[0].split()
    archive_relative = archive.relative_to(output).as_posix()
    if archive_relative not in inputs or any('openh264' in value.lower() for value in inputs):
        raise ValueError('Unexpected FFmpeg/OpenH264 final link inputs')
    dll = output / 'libcef.dll'
    if digest(dll) != digest(candidate):
        raise ValueError('Candidate DLL differs from audited output DLL')
    return {'selected_inputs_passed': True, 'binary_absence_proven': False,
            'scope': 'Current generated flags/FFmpeg registry, thin archive members and explicit libcef link edge',
            'dll_sha256': digest(candidate), 'dll_bytes': candidate.stat().st_size,
            'codec_policy': codec_policy, 'ffmpeg_objects': records,
            'input_hashes': {str(p): digest(p) for p in
                             (args_path, components, registry, graph, archive, link_graph)},
            'explicit_link_token_count': len(inputs),
            'limitations': ['No complete transitive input or final PE/PDB symbol audit',
                            'Current files and matching DLL hash do not alone prove build-time provenance',
                            'Not legal clearance or release approval']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('candidate_dll', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    if args.report.exists():
        parser.error('Refusing to overwrite an audit report')
    result = audit(args.source, args.output, args.candidate_dll)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('selected_inputs_passed', 'binary_absence_proven', 'dll_sha256')}))


if __name__ == '__main__':
    main()
