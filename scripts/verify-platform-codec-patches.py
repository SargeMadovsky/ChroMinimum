from pathlib import Path
import argparse,hashlib,json,subprocess,os
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='Replay the pinned platform-codec patch series in a new sparse directory; does not build CEF')
parser.add_argument('source',type=Path);parser.add_argument('stage',type=Path)
options=parser.parse_args();SRC=options.source.resolve();STAGE=options.stage.resolve()
if STAGE.is_relative_to(SRC) or STAGE.exists():
 parser.error('Stage must be new and outside the source checkout')
RECIPE=json.loads((ROOT/'patches/chromium/platform-codecs-154-win64.json').read_text(encoding='utf-8'))
series=[];first={};final={}
for record in RECIPE['patches']:
 patch=ROOT/record['patch'];meta=patch.with_suffix('.json');d=json.loads(meta.read_text(encoding='utf-8'))
 if hashlib.sha256(patch.read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=record['sha256']:
  parser.error('Pinned patch hash changed: '+str(patch))
 prefix=patch.name[:5];series.append((meta,patch))
 for name,entry in (d.get('files') or {d.get('path',d.get('source')):d}).items():
  if prefix=='0009-':name='third_party/ffmpeg/'+name
  first.setdefault(name,entry['before_sha256']);final[name]=entry['after_sha256']
def sha(data):return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def git(*args,cwd):return subprocess.check_output(['git',*args],cwd=cwd,stderr=subprocess.PIPE)
for relative,expected in {**RECIPE['dependency_commits'],'cef':RECIPE['cef_commit']}.items():
 if git('rev-parse','HEAD',cwd=SRC/relative).decode().strip()!=expected:
  parser.error('Pinned checkout commit mismatch: '+relative)
preimages={};repos={}
for name,expected in first.items():
 if expected==hashlib.sha256(b'').hexdigest():continue
 target=SRC/name;repo=Path(git('rev-parse','--show-toplevel',cwd=target.parent).decode().strip())
 commit=git('rev-parse','HEAD',cwd=repo).decode().strip();repos[str(repo.relative_to(SRC)) if repo!=SRC else '.']=commit
 content=git('show',commit+':'+target.relative_to(repo).as_posix(),cwd=repo)
 if name!='third_party/angle/src/commit_id.py':
  assert sha(content)==expected,('Upstream preimage mismatch',name)
 preimages[name]=content.replace(b'\r\n',b'\n')
if final!=RECIPE['expected_postimages']:
 parser.error('Metadata postimages differ from pinned recipe')
official=SRC/RECIPE['cef_preparation']['patch']
if sha(official.read_bytes())!=RECIPE['cef_preparation']['sha256_lf']:
 parser.error('Official CEF prerequisite patch changed')
STAGE.mkdir()
for name,content in preimages.items():
 target=STAGE/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
env=dict(os.environ,GIT_CEILING_DIRECTORIES=str(STAGE.parent))
official=SRC/'cef/patch/patches/angle_commit_config.patch'
for args in [['apply','-p0','--check','--include=src/commit_id.py','-'],['apply','-p0','--include=src/commit_id.py','-']]:
 result=subprocess.run(['git',*args],cwd=STAGE/'third_party/angle',input=official.read_bytes().replace(b"\r\n",b"\n"),capture_output=True,env=env)
 assert result.returncode==0,result.stderr.decode(errors='replace')
for name,expected in first.items():
 target=STAGE/name
 assert sha(target.read_bytes() if target.exists() else b'')==expected,('CEF-prepared preimage mismatch',name)
steps=[]
for meta,patch in series:
 data=patch.read_bytes().replace(b'\r\n',b'\n')
 for args in [['apply','--check','-'],['apply','-']]:
  result=subprocess.run(['git',*args],cwd=STAGE,input=data,capture_output=True,env=env)
  assert result.returncode==0,(patch.name,result.stderr.decode(errors='replace'))
 steps.append({'patch':patch.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(data).hexdigest()})
for name,expected in final.items():
 assert sha((STAGE/name).read_bytes())==expected,('Replay postimage mismatch',name)
 assert sha((SRC/name).read_bytes())==expected,('Current checkout mismatch',name)
result={'status':'clean_sparse_patch_replay_passed','scope':'27 source files from Git HEAD preimages,11 ordered patches; no GN or fresh rebuild executed','checkouts':repos,'cef_preparation':{'patch':'cef/patch/patches/angle_commit_config.patch','sha256':hashlib.sha256(official.read_bytes()).hexdigest(),'sparse_include':'src/commit_id.py'},'patches':steps,'postimages':final,'bit_reproducible_build_proven':False,'candidate_dll_sha256':None}
(STAGE/'summary.json').write_bytes((json.dumps(result,indent=2)+'\n').encode('utf-8'))
print(json.dumps({'status':result['status'],'files':len(final),'patches':len(steps),'checkouts':repos}))
