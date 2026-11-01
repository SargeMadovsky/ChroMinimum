"""Read-only identity audit of the preserved alpha.8 candidate and source snapshot."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        raise ValueError('Preserve prior audits; output must be new')
    materials_dir = ROOT/'dist/alpha8-source-materials'
    materials = json.loads((materials_dir/'source-materials.json').read_text())
    source = materials_dir/materials['archives']['chrominimum']['path']
    assert digest(source) == materials['archives']['chrominimum']['sha256']
    report = {'scope':'Read-only preserved candidate identity; not a build, runtime test or distribution clearance',
              'snapshot':{'path':str(source.relative_to(ROOT)), 'sha256':digest(source)},
              'identical':[], 'changed':[], 'archive_evidence':[], 'new_application_sources':[],
              'payload_mismatches':[], 'runtime_mismatches':[]}
    archived = set()
    with zipfile.ZipFile(source) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = str(PurePosixPath(entry.filename).relative_to('chrominimum'))
            file = (ROOT/name).resolve()
            if not file.is_relative_to(ROOT):
                raise ValueError('Archive escaped workspace')
            archived.add(name)
            if name.startswith('build-evidence/') or name == 'SOURCE-SNAPSHOT.json':
                report['archive_evidence'].append(name)
                continue
            old = archive.read(entry)
            if not file.is_file():
                report['changed'].append({'file':name,'kind':'missing'})
                continue
            current = file.read_bytes()
            if old == current:
                report['identical'].append(name)
            else:
                report['changed'].append({'file':name,'kind':'line-endings-only' if old.replace(b'\r\n',b'\n') == current.replace(b'\r\n',b'\n') else 'content',
                                          'snapshot_sha256':hashlib.sha256(old).hexdigest(),'current_sha256':hashlib.sha256(current).hexdigest()})
    for directory in ['src','updater/src']:
        for file in (ROOT/directory).rglob('*'):
            if file.is_file() and file.suffix in ('.rs','.cc','.h','.cpp') and file.relative_to(ROOT).as_posix() not in archived:
                report['new_application_sources'].append(file.relative_to(ROOT).as_posix())
    payload = json.loads((ROOT/'docs/reports/alpha8-installer-20261023/payload-inspection.json').read_text())
    for name, identity in payload.items():
        file = ROOT/'.local/alpha8-installer-20261023/payload-final'/name
        if not file.is_file() or file.stat().st_size != identity['bytes'] or digest(file) != identity['sha256']:
            report['payload_mismatches'].append(name)
    runtime = json.loads((ROOT/'.local/product-validation-20261024/runtime-manifest.json').read_text())['files']
    for name, identity in runtime.items():
        file = ROOT/'.local/product-validation-20261024/runtime'/name
        if not file.is_file() or digest(file) != identity['sha256'] or payload.get('core/seed/'+name) != identity:
            report['runtime_mismatches'].append(name)
    installer = ROOT/'dist/ChroMinimum-0.0.1-alpha.8-setup-x64.exe'
    report['installer'] = {'path':str(installer.relative_to(ROOT)),'bytes':installer.stat().st_size,'sha256':digest(installer)}
    assert report['installer']['sha256'] == 'ac427e0903fc71d03d3172436272b06981acd6211815d3f1861f1be203e1ec71'
    report['payload_files_checked'] = len(payload)
    report['runtime_files_checked'] = len(runtime)
    report['candidate_identity_valid'] = not report['payload_mismatches'] and not report['runtime_mismatches']
    report['current_sources_identical_to_snapshot'] = not report['changed'] and not report['new_application_sources']
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:report[key] for key in ['candidate_identity_valid','current_sources_identical_to_snapshot','changed','new_application_sources','payload_mismatches','runtime_mismatches']},ensure_ascii=False,indent=2))
    if not report['candidate_identity_valid']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
