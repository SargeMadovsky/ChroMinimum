// Explicit video/game pilot orchestration. Final multi-scenario suite is not ready.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {hashFile}=require('./benchmark-file-hash.cjs');
function schedule(repeats){
 if(!Number.isInteger(repeats)||repeats<1||repeats>5)throw Error('Repeats must be 1..5');
 const names=['CM','UC','Chrome'];
 return Array.from({length:repeats},(_,round)=>names.map((_,index)=>({round:round+1,browser:names[(round+index)%3]}))).flat();
}
function isAcceptedAttempt(child,summary,lifecycle){return child.status===0&&!child.error&&summary?.valid===true&&lifecycle?.exit===0;}
function loadInputs(configPath){
 const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
 if(config.schema!==1)throw Error('Unsupported config schema');
 const root=path.resolve(path.dirname(configPath),config.root);
 const resolveFile=entry=>{
  const file=path.resolve(root,entry.path);
  if(!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Missing pinned hash: '+file);
  const hash=hashFile(file);
  if(hash!==entry.sha256)throw Error('Input hash mismatch: '+file);
  return {...entry,path:file};
 };
 const fixture=resolveFile(config.fixture);
 const browsers={};
 for(const name of ['CM','UC','Chrome']){
  const browser=config.browsers?.[name];if(!browser)throw Error('Missing browser '+name);
  browsers[name]={...browser,exe:resolveFile(browser.exe),engine:resolveFile(browser.engine)};
 }
 const game=config.game?resolveFile(config.game):null;
 if(game){const manifest=JSON.parse(fs.readFileSync(game.path,'utf8'));for(const [name,entry] of Object.entries(manifest.files))resolveFile({path:path.join(path.dirname(config.game.path),name),sha256:entry.sha256});}
 return {root,fixture,browsers,game};
}
function main(){
 const args=process.argv.slice(2);
 if(args.some(a=>!['--video-pilot','--game-pilot','--webrtc-pilot','--continue-on-failure','--preflight-only','--repeats=1','--repeats=2','--repeats=3','--repeats=4','--repeats=5'].includes(a)))throw Error('Usage: run-browser-comparison.cjs [--preflight-only | --video-pilot | --game-pilot | --webrtc-pilot] [--repeats=1..5] [--continue-on-failure]');
 if(['--video-pilot','--game-pilot','--webrtc-pilot','--preflight-only'].filter(a=>args.includes(a)).length>1)throw Error('Select one mode');
 const gamePilot=args.includes('--game-pilot'),rtcPilot=args.includes('--webrtc-pilot'),pilot=args.includes('--video-pilot')||gamePilot||rtcPilot;
 const continueOnFailure=args.includes('--continue-on-failure');
 const repeats=Number((args.find(a=>a.startsWith('--repeats='))||'--repeats=1').split('=')[1]);
 const inputs=loadInputs(path.join(__dirname,'browser-comparison.config.json'));
 const out=path.join(inputs.root,'.local','comparison-runs',new Date().toISOString().replace(/[:.]/g,'-'));
 fs.mkdirSync(out,{recursive:true});
 if(gamePilot&&!inputs.game)throw Error('Pinned game manifest missing');
 const metadata={mode:rtcPilot?'webrtc-pilot':gamePilot?'game-pilot':pilot?'video-pilot':'preflight-only',readyForFinalSuite:false,continueOnFailure,node:process.version,inputs,schedule:schedule(repeats),results:[],limitations:['No real devices, Internet or NAT/TURN WebRTC verification','1000x600 same-origin measurement iframe; outer window dimensions differ','No resource/decoder-backend measurement',rtcPilot?'Local WebRTC file capture + decoded PCM; muted output':gamePilot?'Instrumented fixed-yaw render-loop pilot; 165 Hz reference':'Fresh-profile muted synthetic-video pilot only']};
 const save=()=>fs.writeFileSync(path.join(out,'run.json'),JSON.stringify(metadata,null,2));save();
 console.log('Reports: '+out);
 const snapshot=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'comparison-preflight.ps1'),'-OutputPath',path.join(out,'environment.json')],{encoding:'utf8',windowsHide:true,timeout:30000});
 if(snapshot.error||snapshot.status!==0)throw Error('Environment snapshot failed: '+(snapshot.error?.message||snapshot.stderr));
 // Refuse test executables already running; never terminate existing browsers.
 const running=spawnSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:30000});
 if(running.error||running.status!==0)throw Error('Cannot inspect running test executables');
 const paths=JSON.parse(running.stdout.trim()||'[]');
 const active=new Set((Array.isArray(paths)?paths:[paths]).map(p=>p.toLowerCase()));
 for(const [name,browser] of Object.entries(inputs.browsers))if(active.has(browser.exe.path.toLowerCase()))throw Error(name+' test executable is already running; close it first');
 if(!pilot){console.log('Pinned inputs and environment checked. Scenario modes run the documented local tests; this is not universal product acceptance.');return;}
 for(const [index,item] of metadata.schedule.entries()){
  const name=String(index+1).padStart(2,'0')+'-'+item.browser;
  const browser=inputs.browsers[item.browser];
  console.log('Starting '+name+' (about '+(rtcPilot?'40':'75')+' seconds). Keep its window visible.');
  const log=fs.openSync(path.join(out,name+'.log'),'wx');
  let child;
  try{child=spawnSync(process.execPath,[path.join(__dirname,gamePilot?'probe-game-sustained.cjs':'probe-video-sustained.cjs'),browser.exe.path,gamePilot?path.dirname(inputs.game.path):inputs.fixture.path,path.join(out,name),...(item.browser==='CM'?[]:['--chromium']),...(rtcPilot?['--webrtc']:[])],{stdio:['ignore',log,log],windowsHide:true,timeout:200000});}
  finally{fs.closeSync(log);}
  let summary=null,lifecycle=null;
  for(const [file,set] of [['summary.json',v=>summary=v],['lifecycle.json',v=>lifecycle=v]]){
   const p=path.join(out,name,file);if(fs.existsSync(p))set(JSON.parse(fs.readFileSync(p,'utf8')));
  }
  const accepted=isAcceptedAttempt(child,summary,lifecycle);
  metadata.results.push({...item,name,accepted,exit:child.status,error:child.error?.message,summary,lifecycle});save();
  if(fs.existsSync(path.join(out,name,'cleanup-error.json'))){metadata.cleanupFailed=true;save();console.error('Browser cleanup failed; stop even with continue-on-failure.');process.exitCode=1;return;}
  if(!accepted){console.error('Attempt rejected; raw files retained. '+(continueOnFailure?'Continuing explicitly requested.':'Series stopped.'));process.exitCode=1;if(!continueOnFailure)return;}
 }
 metadata[rtcPilot?'webrtcPilotComplete':gamePilot?'gamePilotComplete':'videoPilotComplete']=true;metadata.allAttemptsAccepted=metadata.results.every(r=>r.accepted);save();console.log('Pilot completed; all attempts accepted: '+metadata.allAttemptsAccepted+'. This is not final-suite acceptance.');
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={schedule,loadInputs,isAcceptedAttempt};
