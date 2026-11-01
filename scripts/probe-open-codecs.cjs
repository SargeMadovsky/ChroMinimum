// Visible local decode proof for the existing stock runtime; no browser rebuild.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{createHash}=require('node:crypto');
const {observeChild,waitForExit}=require('./diagnose-media.cjs');
const page=`<!doctype html><meta charset="utf-8"><title>ChroMinimum — AV1 / VP9 test</title>
<style>body{background:#17202b;color:white;font:18px Arial;margin:20px}video{width:640px;max-width:100%;display:block}pre{white-space:pre-wrap}</style>
<h1>Stock CEF: AV1 / VP9</h1><p>Visible local decoding test. Keep this window visible.</p><video muted playsinline controls></video><pre id="status">Starting…</pre><script>
(async()=>{const video=document.querySelector('video'),rows=[],types={av1:'video/webm; codecs="av01.0.04M.08"',vp9:'video/webm; codecs="vp9, opus"',h264:'video/mp4; codecs="avc1.42E01E"',aac:'audio/mp4; codecs="mp4a.40.2"'};
const capabilities=Object.fromEntries(Object.entries(types).map(([k,v])=>[k,{canPlay:video.canPlayType(v),mse:MediaSource.isTypeSupported(v)}]));
for(const [codec,file] of [['av1','bear-av1.webm'],['vp9','bear-vp9-opus.webm']]){
 const row={codec,file,initialVisibility:document.visibilityState};rows.push(row);const started=performance.now();
 await new Promise(resolve=>{let done=false;const finish=reason=>{if(done)return;done=true;clearTimeout(timer);video.onended=null;video.onerror=null;Object.assign(row,{reason,seconds:(performance.now()-started)/1000,currentTime:video.currentTime,ended:video.ended,frames:video.getVideoPlaybackQuality().totalVideoFrames,error:video.error?{code:video.error.code,message:video.error.message}:null,visibility:document.visibilityState});resolve();};const timer=setTimeout(()=>finish('timeout'),15000);video.onended=()=>finish('ended');video.onerror=()=>finish('media-error');video.src='/'+file;video.play().catch(e=>{row.playError=e.name;finish('play-rejected')});});
 document.querySelector('#status').textContent=JSON.stringify({capabilities,rows},null,2);
}
await fetch('/report',{method:'POST',body:JSON.stringify({capabilities,rows,userAgent:navigator.userAgent})});})().catch(e=>fetch('/report',{method:'POST',body:JSON.stringify({error:String(e)})}));
</script>`;
async function main(){
 if(process.argv.length!==5)throw Error('Usage: probe-open-codecs.cjs <stock-browser.exe> <fixture-directory> <new-report>');
 const [exe,fixtures,out]=process.argv.slice(2).map(x=>path.resolve(x));fs.mkdirSync(out);const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-open-codecs-'));
 const files=new Map(['bear-av1.webm','bear-vp9-opus.webm'].map(n=>['/'+n,fs.readFileSync(path.join(fixtures,n))]));
 fs.writeFileSync(path.join(out,'launch.json'),JSON.stringify({exe,data,fixtures:Object.fromEntries([...files].map(([name,b])=>[name,{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}]))},null,2));
 let resolveReport,received=false;const report=new Promise(r=>resolveReport=r);
 const server=http.createServer((req,res)=>{
  if(req.url==='/report'&&req.method==='POST'){const chunks=[];let size=0;req.on('data',b=>{size+=b.length;if(size>128*1024)req.destroy();else chunks.push(b)});req.on('end',()=>{try{if(received){res.writeHead(409);res.end();return;}const raw=JSON.parse(Buffer.concat(chunks));fs.writeFileSync(path.join(out,'observation.json'),JSON.stringify(raw,null,2));received=true;res.end('saved');resolveReport(raw);}catch(e){res.writeHead(400);res.end();}});return;}
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page);return;}
  const file=files.get(req.url);if(file){res.writeHead(200,{'Content-Type':'video/webm','Content-Length':file.length});res.end(file);}else{res.writeHead(404);res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
 const child=spawn(exe,['--url=http://127.0.0.1:'+server.address().port+'/'],{env,windowsHide:false,stdio:'ignore'}),state=observeChild(child);let timer;
 try{const raw=await Promise.race([report,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('Open-codecs report timeout')),45000)}),state.done.then(()=>{throw Error('Browser exited before report')})]);clearTimeout(timer);
  const valid=!raw.error&&raw.rows?.length===2&&raw.rows.every(r=>r.reason==='ended'&&r.ended&&r.frames>0&&!r.error&&!r.playError&&r.initialVisibility==='visible'&&r.visibility==='visible')&&raw.capabilities.h264.canPlay===''&&raw.capabilities.aac.canPlay==='';
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({valid,scope:'AV1/VP9 real file decoding; no H.264/AAC playback capability; not site compatibility',rows:raw.rows,capabilities:raw.capabilities},null,2));console.log(JSON.stringify({valid,rows:raw.rows,capabilities:raw.capabilities},null,2));if(!valid)process.exitCode=1;
 }finally{clearTimeout(timer);try{if(!state.finished){await promisify(execFile)(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid)],{windowsHide:true,timeout:10000});}const exit=await waitForExit(state,60000);fs.writeFileSync(path.join(out,'lifecycle.json'),JSON.stringify({exit},null,2));if(exit!==0)throw Error('Unclean browser exit '+exit);}finally{server.closeAllConnections();server.close();child.unref();}}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
