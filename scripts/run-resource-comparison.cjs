// Private Windows test tooling. Uses the sealed comparison kit; no app changes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,execFile,spawnSync}=require('node:child_process'),{promisify}=require('node:util');
const readline=require('node:readline');
const {summarizeResources,median}=require('./resource-samples.cjs');
const {observeChild,waitForExit}=require('./diagnose-media.cjs');
const {verifyKit}=require('./comparison-kit-launcher.cjs');
const {loadInputs}=require('./run-browser-comparison.cjs');
const {hashFile}=require('./benchmark-file-hash.cjs');
const {page:videoPage,shell,summarizeSustained}=require('./probe-video-sustained.cjs');
const {patchExample}=require('./probe-game-sustained.cjs');
const {summarizeGameFrames}=require('./summarize-game-frames.cjs');
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const taskkill=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
const idlePage=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#17202b;color:white;font:16px Arial}main{display:grid;grid-template-columns:repeat(4,1fr)}article{padding:8px}</style><main></main><script>
const result={samples:[],events:[]};let active=false;
document.querySelector('main').innerHTML=Array.from({length:200},(_,i)=>'<article>ITEM '+i+' — Local browser comparison</article>').join('');
function state(){const b=frameElement.getBoundingClientRect();return {focused:document.hasFocus(),visibility:document.visibilityState,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale,fullyVisible:b.left>=0&&b.top>=0&&b.right<=parent.innerWidth&&b.bottom<=parent.innerHeight};}
for(const type of ['focus','blur','resize'])addEventListener(type,()=>{if(active)result.events.push({type,...state()});});
document.addEventListener('visibilitychange',()=>{if(active)result.events.push({type:'visibility',...state()});});
for(const type of ['resize','scroll'])parent.addEventListener(type,()=>{if(active)result.events.push({type,...state()});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await fetch('/ready',{method:'POST',body:JSON.stringify(state())});
await sleep(5000);active=true;await fetch('/window-start',{method:'POST'});const start=performance.now();
do{result.samples.push(state());await sleep(1000);}while(performance.now()-start<30000);
await fetch('/window-end',{method:'POST'});await fetch('/report',{method:'POST',body:JSON.stringify(result)});})();
</script>`;
function validState(s){return s&&s.focused&&s.visibility==='visible'&&s.width===1000&&s.height===600&&s.dpr===1&&s.scale===1&&s.fullyVisible;}
function order(round){const n=['CM','UC','Chrome'];return n.map((_,i)=>n[(round+i)%3]);}
async function attempt({inputs,name,scenario,base,dir}){
 fs.mkdirSync(dir);const exe=inputs.browsers[name].exe.path;
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-resources-'));
 if(base)fs.cpSync(base,data,{recursive:true,errorOnExist:true,force:false});
 const files=new Map(),requests=[];
 let active=idlePage;
 const replace=(text,a,b)=>{if(text.split(a).length!==2)throw Error('Instrumentation anchor changed: '+a);return text.replace(a,b);};
 if(['startup','prepare'].includes(scenario))active=replace(active,'await sleep(5000);','return;await sleep(5000);');
 if(scenario==='video'){
  active=replace(videoPage,'started=now;result.startEnvironment','started=now;fetch("/window-start",{method:"POST"});result.startEnvironment');
  active=replace(active,'sent=true;clearTimeout(watchdog);','sent=true;await fetch("/window-end",{method:"POST"});clearTimeout(watchdog);');
 }
 if(scenario==='game'){
  const root=path.dirname(inputs.game.path),manifest=JSON.parse(fs.readFileSync(inputs.game.path));
  for(const file of Object.keys(manifest.files))files.set('/'+file,fs.readFileSync(path.join(root,file)));
  files.set('/examples/games_fps.html',Buffer.from(patchExample(files.get('/examples/games_fps.html').toString())));
  let collector=fs.readFileSync(path.join(__dirname,'game-frame-collector.js'),'utf8');
  collector=replace(collector,'start=now;initialYaw','start=now;fetch("/window-start",{method:"POST"});initialYaw');
  collector=replace(collector,'sent=true;clearTimeout(watchdog);','sent=true;await fetch("/window-end",{method:"POST"});clearTimeout(watchdog);');
  files.set('/cm-game-measure.js',Buffer.from(collector));
 }
 files.set('/measurement',Buffer.from(active));files.set('/',Buffer.from(scenario==='game'?shell.replace('src="/measurement"','src="/examples/games_fps.html"'):shell));
 // Read before timing; no file hashing or profile copying overlaps the measured launch.
 const video=scenario==='video'?fs.readFileSync(inputs.fixture.path):null;
 let ready,resolveReady,resolveReport,start,end,reported=false;
 const readyPromise=new Promise(r=>resolveReady=r),reportPromise=new Promise(r=>resolveReport=r);
 const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if(['/ready','/window-start','/window-end','/report'].includes(req.url)&&req.method==='POST'){
   const at=performance.now();let size=0,chunks=[];
   req.on('data',b=>{size+=b.length;if(size>8*1024*1024)req.destroy();else chunks.push(b);});
   req.on('end',()=>{try{
    if(req.url==='/window-start'){start=at;res.end('ok');return;}
    if(req.url==='/window-end'){end=at;res.end('ok');return;}
    const raw=JSON.parse(Buffer.concat(chunks).toString());
    if(req.url==='/ready'){ready={at,state:raw};resolveReady(ready);res.end('ok');return;}
    if(reported){res.writeHead(409);res.end();return;}reported=true;
    if(raw.canvasPng){fs.writeFileSync(path.join(dir,'canvas.png'),Buffer.from(raw.canvasPng.split(',')[1],'base64'));delete raw.canvasPng;}
    write(path.join(dir,'observation.json'),raw);res.end('ok');resolveReport(raw);
   }catch(e){res.writeHead(400);res.end('invalid report');}});return;
  }
  if(req.url==='/fixture.mp4'&&video){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
   if(req.headers.range&&!match){res.writeHead(416);res.end();return;}
   const a=match?Number(match[1]):0,b=match&&match[2]?Math.min(Number(match[2]),video.length-1):video.length-1;
   if(a>b||a>=video.length){res.writeHead(416);res.end();return;}
   res.writeHead(match?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':b-a+1,...(match?{'Content-Range':`bytes ${a}-${b}/${video.length}`}:{})});res.end(video.subarray(a,b+1));return;
  }
  const bytes=files.get(new URL(req.url,'http://localhost').pathname);if(!bytes){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':req.url.endsWith('.glb')?'model/gltf-binary':'text/html','Content-Length':bytes.length});res.end(bytes);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let child,state,sampler,samplerState,timer;const samples=[],samplerErrors=[];
 const stopPath=path.join(dir,'sampler.stop');let startedAt;
 try{
  if(!['startup','prepare'].includes(scenario)){
   sampler=spawn(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'sample-browser-resources.ps1'),'-RuntimeDirectory',path.dirname(exe),'-StopPath',stopPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   samplerState=observeChild(sampler);let resolveSampler;const samplerReady=new Promise(r=>resolveSampler=r);
   readline.createInterface({input:sampler.stdout}).on('line',line=>{try{const row=JSON.parse(line);if(row.ready)resolveSampler();else if(row.error)samplerErrors.push(row.error);else samples.push({...row,at:performance.now()});}catch(e){samplerErrors.push(e.message);}});
   sampler.stderr.on('data',b=>samplerErrors.push(b.toString()));
   await Promise.race([samplerReady,delay(15000).then(()=>{throw Error('Resource observer startup timeout');}),samplerState.done.then(()=>{throw Error('Resource observer exited early');})]);
  }
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
  const url='http://127.0.0.1:'+server.address().port+'/',args=name==='CM'?['--url='+url]:['--user-data-dir='+data,'--no-first-run','--no-default-browser-check','--new-window',url];
  write(path.join(dir,'launch.json'),{exe,data,scenario,name,base:base||null,profile:'Disposable clone of synthetic prepared state; no personal data'});
  // This is an interactive visible workload. SW_HIDE can alter Chromium's
  // initial show state; only the observer and utility commands stay hidden.
  startedAt=performance.now();child=spawn(exe,args,{env,windowsHide:false,stdio:'ignore'});state=observeChild(child);
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser report timeout')),125000);});
  const value=await Promise.race([['startup','prepare'].includes(scenario)?readyPromise:reportPromise,timeout,state.done.then(()=>{throw Error('Browser exited early');})]);
  write(path.join(dir,'timing.json'),{spawnAt:startedAt,receivedAt:performance.now(),ready,start,end});
  if(scenario==='prepare')await delay(5000);
  clearTimeout(timer);
  await promisify(execFile)(taskkill,['/PID',String(child.pid)],{windowsHide:true,timeout:10000});const exit=await waitForExit(state,60000);
  write(path.join(dir,'lifecycle.json'),{exit,gracefulCloseRequested:true});
  if(sampler){fs.writeFileSync(stopPath,'stop');if(await waitForExit(samplerState,5000)!==0)samplerErrors.push('Observer exited with error');}
  const remaining=spawnSync(ps,['-NoProfile','-Command',"@(Get-Process | ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ }) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(remaining.error||remaining.status!==0)throw Error('Cannot verify browser cleanup');
  const paths=JSON.parse(remaining.stdout.trim()||'[]');
  if((Array.isArray(paths)?paths:[paths]).some(p=>p.toLowerCase().startsWith(path.dirname(exe).toLowerCase()+path.sep))){write(path.join(dir,'cleanup-error.json'),{error:'Browser helper still running after root exit'});throw Error('Browser helper still running; stop suite');}
  let behavior;
  if(['startup','prepare'].includes(scenario)){behavior={valid:validState(value.state),reasons:validState(value.state)?[]:['Focus, visibility or fixed viewport invalid at ready signal'],readyMs:value.at-startedAt,state:value.state};write(path.join(dir,'ready.json'),behavior);}
  else if(scenario==='video')behavior=summarizeSustained(value);
  else if(scenario==='game')behavior=summarizeGameFrames(value);
  else {const reasons=[];if(value.samples.length<29)reasons.push('Incomplete idle observation');if(!value.samples.every(validState)||!value.events.every(e=>!['resize','scroll'].includes(e.type)&&validState(e)))reasons.push('Focus, visibility or geometry interrupted');behavior={valid:reasons.length===0,reasons,samples:value.samples.length};}
  const resources=sampler?summarizeResources(samples,start,end):null;
  if(resources&&samplerErrors.length){resources.valid=false;resources.reasons.push('Resource observer error');}
  const summary={valid:exit===0&&behavior.valid&&(!resources||resources.valid),name,scenario,behavior,resources};
  write(path.join(dir,'resources.json'),{start,end,samples,errors:samplerErrors});write(path.join(dir,'summary.json'),summary);
  return {summary,data};
 }catch(e){const summary={valid:false,name,scenario,error:e.message};write(path.join(dir,'summary.json'),summary);return {summary,data};
 }finally{
  clearTimeout(timer);
  if(state&&!state.finished){try{await promisify(execFile)(taskkill,['/PID',String(child.pid)],{windowsHide:true,timeout:10000});const exit=await waitForExit(state,60000);write(path.join(dir,'lifecycle.json'),{exit,gracefulCloseRequested:true,afterError:true});}catch(e){write(path.join(dir,'cleanup-error.json'),{error:e.message,pid:child.pid});}}
  if(samplerState&&!samplerState.finished){fs.writeFileSync(stopPath,'stop');try{await waitForExit(samplerState,5000);}catch(e){write(path.join(dir,'sampler-cleanup-error.json'),{error:e.message});}}
  if(child){
   const check=spawnSync(ps,['-NoProfile','-Command',"@(Get-Process | ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ }) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:15000});
   try{if(check.error||check.status!==0)throw Error('Cannot verify final cleanup');const paths=JSON.parse(check.stdout.trim()||'[]');if((Array.isArray(paths)?paths:[paths]).some(p=>p.toLowerCase().startsWith(path.dirname(exe).toLowerCase()+path.sep)))throw Error('Runtime process remains after attempt');}
   catch(e){write(path.join(dir,'cleanup-error.json'),{error:e.message});}
  }
  write(path.join(dir,'resources.json'),{start,end,samples,errors:samplerErrors,browserPid:child?.pid});
  write(path.join(dir,'requests.json'),requests);server.closeAllConnections();server.close();
 }
}
function aggregate(results){
 const output={};for(const scenario of ['startup','idle','video','game']){output[scenario]={};for(const name of ['CM','UC','Chrome']){
  const all=results.filter(r=>r.scenario===scenario&&r.name===name),accepted=all.filter(r=>r.valid);
  const keys=scenario==='startup'?['readyMs']:['privateBytesMedian','workingSetBytesMedian','cpuPercentOneCore','cpuPercentMachine'];
  const metrics={};for(const key of keys){const values=accepted.map(r=>scenario==='startup'?r.behavior[key]:r.resources[key]);metrics[key]={values,median:median(values),min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};}
  output[scenario][name]={attempts:all.length,accepted:accepted.length,metrics};
 }}
 for(const scenario of Object.keys(output)){
  output[scenario].cmVersus={};
  for(const other of ['UC','Chrome']){
   const metrics={};for(const key of Object.keys(output[scenario].CM.metrics)){
    const cm=output[scenario].CM.metrics[key].median,baseline=output[scenario][other].metrics[key].median;
    metrics[key]={cm,baseline,absoluteSaving:cm!==null&&baseline!==null?baseline-cm:null,percentSaving:cm!==null&&baseline>0?100*(baseline-cm)/baseline:null};
   }output[scenario].cmVersus[other]=metrics;
  }
 }
 return output;
}
async function main(){
 if(process.platform!=='win32')throw Error('Windows only');
 const mode=process.argv[2]||'--preflight-only';if(!['--preflight-only','--pilot','--suite'].includes(mode))throw Error('Select --preflight-only, --pilot or --suite');
 const addon=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(addon,'resource-kit-manifest.json')));
 for(const [name,hash] of Object.entries(manifest.files)){const file=path.resolve(addon,name);if(!file.startsWith(addon+path.sep)||hashFile(file)!==hash)throw Error('Resource kit hash mismatch: '+name);}
 const kit=path.resolve(__dirname,'../../comparison-kit-20261024');
 if(hashFile(path.join(kit,'kit-manifest.json'))!==manifest.browserKitManifestSha256)throw Error('Browser kit manifest changed');
 console.log('Checking sealed browser kit…');verifyKit(kit);const inputs=loadInputs(path.join(kit,'scripts/browser-comparison.config.json'));
 const root=path.resolve(__dirname,'..'),out=path.join(root,'reports',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
 const preflight=spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'comparison-preflight.ps1'),'-OutputPath',path.join(out,'environment.json')],{windowsHide:true,encoding:'utf8',timeout:30000});
 if(preflight.error||preflight.status!==0)throw Error('Environment check failed: '+preflight.stderr);
 const live=spawnSync(ps,['-NoProfile','-Command','@(Get-Process | ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ }) | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8',timeout:15000});
 if(live.error||live.status!==0)throw Error('Cannot inspect active browsers');const paths=JSON.parse(live.stdout.trim()||'[]');
 for(const b of Object.values(inputs.browsers))if((Array.isArray(paths)?paths:[paths]).some(p=>p.toLowerCase().startsWith(path.dirname(b.exe.path).toLowerCase()+path.sep)))throw Error('Close already running test runtime first');
 const run={mode,startedUtc:new Date().toISOString(),inputs,results:[],complete:false,protocol:'Prepared synthetic profile clones on TEMP; warm OS cache; 1000x600 iframe; startup two rAF + HTTP receipt; resource CPU is sampled, not full lifetime accounting'};
 const save=()=>{write(path.join(out,'run.json'),run);write(path.join(out,'aggregates.json'),aggregate(run.results));};save();console.log('Reports: '+out);
 if(mode==='--preflight-only'){console.log('Preflight passed; no browsers launched.');return;}
 const bases={};
 try{
  for(const name of ['CM','UC','Chrome']){console.log('Prepare synthetic profile: '+name);const r=await attempt({inputs,name,scenario:'prepare',dir:path.join(out,'prepare-'+name)});if(!r.summary.valid)throw Error('Profile preparation rejected: '+name);bases[name]=r.data;}
  for(const scenario of ['startup','idle','video','game']){
   const rounds=mode==='--pilot'?1:scenario==='startup'?10:5;
   for(let round=0;round<rounds;round++)for(const name of order(round)){
    console.log(`${scenario} ${round+1}/${rounds}: ${name}. Keep window visible and focused.`);
    const dir=path.join(out,scenario+'-'+String(round+1).padStart(2,'0')+'-'+name);
    const r=await attempt({inputs,name,scenario,base:bases[name],dir});
    const cleanupFailed=fs.existsSync(path.join(dir,'cleanup-error.json'))||fs.existsSync(path.join(dir,'sampler-cleanup-error.json'));
    if(cleanupFailed){r.summary.valid=false;r.summary.error='Cleanup failed';write(path.join(dir,'summary.json'),r.summary);}
    run.results.push({...r.summary,directory:path.basename(dir)});save();
    if(cleanupFailed)throw Error('Cleanup failed; stop before next browser');
   }
  }
  run.complete=true;run.allAccepted=run.results.every(r=>r.valid);run.finishedUtc=new Date().toISOString();save();console.log('Complete; all accepted: '+run.allAccepted);if(!run.allAccepted)process.exitCode=1;
 }catch(e){run.error=e.message;save();throw e;}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={aggregate,validState,order,attempt};
