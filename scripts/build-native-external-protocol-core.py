"""Compile the pinned CEF protocol fixes and link an isolated DLL with GN flags.

Uses the existing completed GN output, not a second dependency rebuild. All
object/DLL/PDB outputs are redirected; original runtime/object files stay intact.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--prepare-only',action='store_true')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--compile-only',action='store_true')
    mode.add_argument('--link-only',action='store_true')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parents[1]
    src=args.chromium_src.resolve(strict=True)
    build=src/'out/Release_Platform_Codecs_Only_x64'
    target=args.output.resolve()
    if not args.link_only:
        target.mkdir(parents=True,exist_ok=False)
        (target/'objects').mkdir()
    policies=[json.loads((repo/('patches/chromium/'+name+'.json')).read_text(encoding='utf-8')) for name in ('0012-cef-native-external-protocols','0013-cef-explicit-numeric-protocol')]
    identities={relative:identity for meta in policies for relative,identity in meta['files'].items()}
    for relative,identity in identities.items():
        assert hashlib.sha256((src/relative).read_bytes().replace(b'\r\n',b'\n')).hexdigest()==identity['after_sha256']
    # Reuse the reviewed GN edge/rule parser used by the earlier media experiment.
    spec=importlib.util.spec_from_file_location('cm_link',repo/'scripts/link-platform-aac-experiment.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    original=build/'libcef.dll'
    original_hash=sha(original)
    expected=json.loads((repo/'.local/webaudio-integration-narrow-20261029/cef-build-status.json').read_text(encoding='utf-8-sig'))
    assert original_hash==expected['dll_sha256'],'Base DLL changed; review its inputs first'
    object_hashes={}
    commands={}
    replacements={}
    toolchain=build/'toolchain.ninja'
    cxx_ninja=build/'obj/cef/libcef_static.ninja'
    template=re.search(r'^rule cxx\r?\n  command = (.*)$',toolchain.read_text(),re.M)[1]
    prefix_variables=dict(re.findall(r'^(\w+) = (.*)$',cxx_ninja.read_text().split('\nbuild ',1)[0],re.M))
    for relative in identities:
        label=Path(relative).stem
        object_relative='obj/cef/libcef_static/'+label+'.obj'
        object_hashes[object_relative]=sha(build/object_relative)
        variables=dict(prefix_variables)
        variables.update({'in':(src/relative).as_posix(),'target_out_dir':target.as_posix(),'label_name':'objects','source_name_part':label})
        cxx=template
        for _ in range(6):
            cxx=re.sub(r'\$\{(\w+)\}|\$(\w+)',lambda m:variables[m[1] or m[2]],cxx)
        cxx=cxx.replace('$:',':').replace('$ ',' ').replace('$$','$')
        object_path=target/('objects/'+label+'.obj')
        assert object_path.as_posix() in cxx
        commands['compile-'+label]=cxx
        replacements[object_relative]=object_path.as_posix()
    edge=helper.block(build/'obj/cef/libcef.ninja','build ./libcef.dll ')
    rule=helper.block(toolchain,'rule solink')
    inputs=edge[0].split(': solink ',1)[1].split(' |',1)[0]
    for original_object, replacement in replacements.items():
        assert inputs.split().count(original_object)==1
        inputs=inputs.replace(original_object,replacement)
    variables={line.split('=',1)[0].strip():line.split('=',1)[1].strip() for line in edge[1:]}
    variables.update(out=(target/'libcef.dll').as_posix(),output_dir=target.as_posix(),target_output_name='libcef',in_newline=inputs.replace(' ','\n'))
    for key in ('solibs','libs','rlibs'):variables.setdefault(key,'')
    response=next(line.split(' = ',1)[1] for line in rule if line.startswith('  rspfile_content = '))
    content=helper.expand(response,variables)
    # Bound LTO CPU/RAM as in the existing isolated link helper; no policy/codec flags change.
    content=content.replace('/opt:lldltojobs=all','/opt:lldltojobs=2')
    (target/'libcef.dll.rsp').write_text(content)
    link=helper.expand(next(line.split(' = ',1)[1] for line in rule if line.startswith('  command = ')),variables)
    for flag in ('/OUT:','/IMPLIB:','/PDB:'):
        assert flag+target.as_posix() in link
    commands['link']=link
    if args.link_only:
        assert json.loads((target/'commands.json').read_text())==commands, 'GN command plan changed'
    else:
        (target/'commands.json').write_text(json.dumps(commands,indent=2))
    if args.link_only:
        record=json.loads((target/'result.json').read_text())
        assert record['status']=='compiled_only'
        assert record['source_sha256']=={name:row['after_sha256'] for name,row in identities.items()}, 'Compiled source provenance changed'
        assert record['base_dll_sha256']==original_hash and record['base_object_sha256']==object_hashes
        for path,identity in record['object_sha256'].items():
            assert sha(Path(path))==identity
    else:
        record={'status':'prepared','runtime_validated':False,'source_sha256':{name:row['after_sha256'] for name,row in identities.items()},'base_dll_sha256':original_hash,'base_object_sha256':object_hashes,'lto_jobs':2}
    def save(): (target/'result.json').write_text(json.dumps(record,indent=2)+'\n')
    save()
    if args.prepare_only:return
    env=os.environ.copy();env.update(TEMP='E:/cm-platform154/tmp',TMP='E:/cm-platform154/tmp',DEPOT_TOOLS_UPDATE='0',DEPOT_TOOLS_WIN_TOOLCHAIN='0')
    try:
        for name,command in commands.items():
            if args.link_only and name!='link':continue
            if args.compile_only and name=='link':continue
            record['status']=name;save();started=time.monotonic()
            executable=(build/command.split(' ',1)[0]).resolve()
            with (target/(name+'.log')).open('w') as log:
                completed=subprocess.run(command,executable=str(executable),cwd=build,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=10800)
            record[name+'_seconds']=time.monotonic()-started;record[name+'_exit_code']=completed.returncode;save()
            print(json.dumps({name+'_exit_code':completed.returncode,'seconds':record[name+'_seconds']}),flush=True)
            if completed.returncode:raise RuntimeError(name+' failed; inspect its log')
        record['object_sha256']={path:sha(Path(path)) for path in replacements.values()}
        if args.compile_only:
            record['status']='compiled_only'
        else:
            record.update(status='completed',dll_sha256=sha(target/'libcef.dll'),dll_bytes=(target/'libcef.dll').stat().st_size)
    except Exception as error:
        record.update(status='failed',error=str(error));raise
    finally:
        record['base_dll_unchanged']=sha(original)==original_hash
        record['base_object_unchanged']=all(sha(build/path)==identity for path,identity in object_hashes.items())
        save()
        assert record['base_dll_unchanged'] and record['base_object_unchanged']


if __name__=='__main__':main()
