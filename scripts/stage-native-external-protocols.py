"""Stage a disposable native-protocol preview from a hashed runtime and CEF candidate."""
import argparse,hashlib,json,shutil
from pathlib import Path

def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--core',required=True,type=Path)
    p.add_argument('--baseline',required=True,type=Path)
    p.add_argument('--adapter',required=True,type=Path)
    p.add_argument('--output',required=True,type=Path)
    a=p.parse_args()
    state=json.loads((a.core/'result.json').read_text(encoding='utf-8'))
    assert state['status']=='completed' and state['base_dll_unchanged'] and state['base_object_unchanged']
    manifest=json.loads((a.baseline/'runtime-manifest.json').read_text(encoding='utf-8-sig'))
    assert manifest['libcef.dll']['sha256']==state['base_dll_sha256']
    assert sha(a.core/'libcef.dll')==state['dll_sha256']
    files={}
    for name,row in manifest.items():
        rel=Path(name);assert not rel.is_absolute() and '..' not in rel.parts
        if name in ('libcef.dll','chrominimum.dll'):continue
        src=a.baseline/'runtime'/rel
        assert sha(src)==row['sha256'],name
        files[name]={'source':str(src.resolve()),'sha256':row['sha256'],'bytes':src.stat().st_size}
    for name,src in [('libcef.dll',a.core/'libcef.dll'),('chrominimum.dll',a.adapter)]:
        files[name]={'source':str(src.resolve()),'sha256':sha(src),'bytes':src.stat().st_size}
    a.output.mkdir(parents=True,exist_ok=False)
    for name,row in files.items():
        dst=a.output/'runtime'/name;dst.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(row['source'],dst);assert sha(dst)==row['sha256']
    (a.output/'runtime-manifest.json').write_text(json.dumps(files,indent=2)+'\n',encoding='utf-8')
    (a.output/'Launch.cmd').write_text('@echo off\nsetlocal\nset "CHROMINIMUM_DATA_DIR=%TEMP%\\ChroMinimum-native-protocol-preview-%RANDOM%-%RANDOM%"\nstart "" "%~dp0runtime\\chrominimum.exe" "--url=file:///%~dp0fixture.html"\n',encoding='ascii')
    print(json.dumps({'preview':str(a.output.resolve()),'files':len(files),'core_sha256':state['dll_sha256'],'runtime_validated':False}),flush=True)
if __name__=='__main__':main()
