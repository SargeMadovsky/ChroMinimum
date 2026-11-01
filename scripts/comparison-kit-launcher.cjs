const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {hashFile}=require('./benchmark-file-hash.cjs');
function verifyKit(root){const manifest=JSON.parse(fs.readFileSync(path.join(root,'kit-manifest.json'),'utf8'));for(const [name,entry] of Object.entries(manifest.files)){const file=path.resolve(root,name);if(!file.startsWith(root+path.sep))throw Error('Manifest escaped kit');if(hashFile(file)!==entry.sha256)throw Error('Kit hash mismatch: '+name);}return manifest;}
function main(){
 const args=process.argv.slice(2);if(args.some(a=>!['--preflight-only','--suite','--pilot'].includes(a))||args.length>1)throw Error('Usage: START.cmd [--preflight-only | --pilot | --suite]');
 const root=path.resolve(__dirname,'..'),mode=args[0]||'--suite';console.log('Verifying packaged files…');
 const manifest=verifyKit(root);console.log('Verified '+Object.keys(manifest.files).length+' files.');
 const runner=path.join(__dirname,'run-browser-comparison.cjs');
 if(mode==='--preflight-only'){const r=spawnSync(process.execPath,[runner,'--preflight-only'],{stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exitCode=r.status??1;return;}
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),report=path.join(root,'suite-reports',stamp);fs.mkdirSync(report,{recursive:true});
 const summary={startedUtc:new Date().toISOString(),mode,scope:'Private local comparison, not universal performance verdict',stages:[],allStagesAccepted:false};
 const save=()=>fs.writeFileSync(path.join(report,'suite.json'),JSON.stringify(summary,null,2));save();
 console.log('Reports: '+report);console.log('Keep browser windows visible. Do not use the PC during recording.');
 const rounds=mode==='--pilot'?1:5;
 for(const [scenario,repeats] of [['video',rounds],['game',rounds],['webrtc',1]]){
  console.log('Scenario: '+scenario);const before=new Set(fs.existsSync(path.join(root,'.local/comparison-runs'))?fs.readdirSync(path.join(root,'.local/comparison-runs')):[]);
  const r=spawnSync(process.execPath,[runner,'--'+scenario+'-pilot','--repeats='+repeats,'--continue-on-failure'],{stdio:'inherit',windowsHide:true});
  const newReports=fs.existsSync(path.join(root,'.local/comparison-runs'))?fs.readdirSync(path.join(root,'.local/comparison-runs')).filter(n=>!before.has(n)):[];
  const records=newReports.map(n=>{const p=path.join(root,'.local/comparison-runs',n,'run.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;}).filter(Boolean);
  summary.stages.push({scenario,exit:r.status,error:r.error?.message,reports:newReports,completed:records.some(x=>x[scenario==='webrtc'?'webrtcPilotComplete':scenario==='game'?'gamePilotComplete':'videoPilotComplete']),allAccepted:records.length>0&&records.every(x=>x.allAttemptsAccepted===true)});save();
  if(r.error||records.some(x=>x.cleanupFailed)||!summary.stages.at(-1).completed){summary.stoppedForInfrastructureError=true;save();throw Error('Infrastructure error or incomplete scenario; reports retained');}
 }
 summary.finishedUtc=new Date().toISOString();summary.allStagesAccepted=summary.stages.every(x=>x.exit===0&&x.completed&&x.allAccepted);save();
 console.log('Suite finished. All attempts accepted: '+summary.allStagesAccepted+'. UC WebRTC may fail with zero ICE candidates.');if(!summary.allStagesAccepted)process.exitCode=1;
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={verifyKit};
