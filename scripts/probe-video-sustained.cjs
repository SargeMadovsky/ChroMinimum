// Self-reporting visible pilot: no CDP, no changes to the frozen browser.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const {observeChild,waitForExit}=require('./diagnose-media.cjs');
const {summarizeVideoFrames}=require('./summarize-video-frames.cjs');
const {page:rtcPage,summarizeWebRTC}=require('./webrtc-pilot-page.cjs');
function summarizeSustained(raw){
 const summary=summarizeVideoFrames(raw);
 if(raw.reason!=='measurement-window-complete'){summary.valid=false;summary.reasons.push(raw.reason);}
 if(!raw.environment?.measurementViewport){summary.valid=false;summary.reasons.push('fixed measurement viewport missing');}
 else {
  const env=raw.environment;
  if(env.innerWidth!==1000||env.innerHeight!==600||env.dpr!==1||env.visualScale!==1||!env.fullyVisible){summary.valid=false;summary.reasons.push('measurement viewport mismatch or clipped');}
  if(!raw.startEnvironment||raw.startEnvironment.innerWidth!==1000||raw.startEnvironment.innerHeight!==600||raw.startEnvironment.dpr!==1||raw.startEnvironment.visualScale!==1||!raw.startEnvironment.fullyVisible){summary.valid=false;summary.reasons.push('initial measurement viewport mismatch or clipped');}
 }
 summary.warmupMediaSeconds=10;
 summary.limitation='Callback timing is not physical presentation timing; first 10 media seconds excluded; muted synthetic-video pilot, not hdrezka';
 return summary;
}
const page=`<!doctype html><meta charset="utf-8"><title>Video measurement — warming up</title>
<style>body{margin:0;background:#17202b;color:white;font:16px sans-serif}header{padding:6px;height:18px;white-space:nowrap;overflow:hidden}video{display:block;width:1000px;height:562.5px;max-width:100%}</style>
<header id="status">Video measurement: 10 s warmup, then 60 s observation. Keep this window visible.</header>
<video id="v" muted autoplay playsinline controls src="/fixture.mp4"></video><script>
const video=document.querySelector('video'),status=document.querySelector('#status');
const result={events:[],frameMetrics:{supported:typeof video.requestVideoFrameCallback==='function',samples:[],truncated:false,firstQuality:null,lastQuality:null}};
let started=null,sent=false,callback;
const quality=()=>{const q=video.getVideoPlaybackQuality();return {totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames};};
function environment(){const rect=video.getBoundingClientRect(),frame=window.frameElement,box=frame?.getBoundingClientRect();return {innerWidth,innerHeight,dpr:devicePixelRatio,visualScale:visualViewport?.scale,
 measurementViewport:!!frame,fullyVisible:!!box&&box.left>=0&&box.top>=0&&box.right<=parent.innerWidth&&box.bottom<=parent.innerHeight,
 outerViewport:frame?{width:parent.innerWidth,height:parent.innerHeight}:null,
 userAgent:navigator.userAgent,muted:video.muted,videoWidth:video.videoWidth,videoHeight:video.videoHeight,renderedWidth:rect.width,renderedHeight:rect.height};}
function event(type){if(started===null)return; if(result.events.length<1000)result.events.push({type,at:performance.now(),currentTime:video.currentTime,ended:video.ended,paused:video.paused,visibility:document.visibilityState,focused:document.hasFocus()});else result.frameMetrics.truncated=true;}
async function finish(reason){if(sent)return;sent=true;clearTimeout(watchdog);if(callback)video.cancelVideoFrameCallback(callback);
 result.reason=reason;result.error=video.error?{code:video.error.code,message:video.error.message}:null;
 result.frameMetrics.lastQuality=quality();result.ended=video.ended;result.paused=video.paused;
 result.mediaTime=video.currentTime;result.duration=video.duration;
 result.environment=environment();
 status.textContent='Measurement finished: '+reason+'. Saving report…';document.title='Video measurement — finished';
 try{const response=await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});status.textContent=response.ok?'Report saved. Window will close.':'Report save failed';}catch(e){status.textContent='Report save failed: '+e.message;}
 video.pause();}
for(const type of ['playing','pause','waiting','stalled','ended','error','seeking','seeked'])video.addEventListener(type,()=>{event(type);if(type==='ended'||type==='error')finish(type);});
document.addEventListener('visibilitychange',()=>event('visibilitychange'));
for(const type of ['focus','blur'])window.addEventListener(type,()=>event(type));
window.addEventListener('resize',()=>event('resize'));
if(window.frameElement){parent.addEventListener('resize',()=>event('resize'));parent.addEventListener('scroll',()=>event('outer-scroll'));}
function tick(now,metadata){if(sent)return;
 if(started===null&&metadata.mediaTime>=10){started=now;result.startEnvironment=environment();result.frameMetrics.firstQuality=quality();status.textContent='Measuring 60 seconds — keep this window visible';document.title='Video measurement — recording';}
 if(started!==null){const m=result.frameMetrics;if(m.samples.length<10000)m.samples.push({now,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,visibility:document.visibilityState,focused:document.hasFocus()});else m.truncated=true;
 if(now-started>=60000){finish('measurement-window-complete');return;}}
 callback=video.requestVideoFrameCallback(tick);}
const watchdog=setTimeout(()=>finish('timeout'),110000);
if(result.frameMetrics.supported)callback=video.requestVideoFrameCallback(tick);else finish('API-unavailable');
video.play().catch(e=>{result.playError=e.name;finish('play-rejected');});
</script>`;
const shell=`<!doctype html><meta charset="utf-8"><title>Video measurement — fixed 1000x600 viewport</title>
<style>html,body{margin:0;background:#17202b}iframe{display:block;width:1000px;height:600px;border:0}</style>
<iframe title="1000x600 measurement viewport" src="/measurement" onload="this.contentWindow.focus()"></iframe>`;
const launchPage=`<!doctype html><meta charset="utf-8"><title>Portable runtime check</title><body style="background:#17202b;color:white">Portable browser / WebGL startup check<canvas width="16" height="16"></canvas><script>
(async()=>{const canvas=document.querySelector('canvas'),gl=canvas.getContext('webgl2');const raw={webgl2:!!gl,userAgent:navigator.userAgent};
if(gl){gl.clearColor(.25,.5,.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);raw.pixel=[...pixel];raw.glError=gl.getError();const info=gl.getExtension('WEBGL_debug_renderer_info');raw.gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)});})();
</script>`;
async function main(){
 const chromium=process.argv.includes('--chromium');
 const rtc=process.argv.includes('--webrtc');
 const launchCheck=process.argv.includes('--launch-check');if(rtc&&launchCheck)throw Error('Select one scenario');
 const args=process.argv.slice(2).filter(a=>!['--chromium','--webrtc','--launch-check'].includes(a));if(args.length!==3)throw Error('Usage: node probe-video-sustained.cjs <browser.exe> <fixture.mp4> <new-report> [--chromium] [--webrtc | --launch-check]');
 const [exe,fixture,report]=args.map(p=>path.resolve(p));
 const bytes=fs.readFileSync(fixture);fs.mkdirSync(report,{recursive:false});
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-video-long-'));
 const activePage=launchCheck?launchPage:rtc?rtcPage:page;
 fs.writeFileSync(path.join(report,'fixture.html'),activePage);
 const activeShell=launchCheck?shell.replaceAll('Video measurement','Portable runtime check'):rtc?shell.replaceAll('Video measurement','WebRTC loopback'):shell;
 fs.writeFileSync(path.join(report,'shell.html'),activeShell);
 fs.writeFileSync(path.join(report,'launch.json'),JSON.stringify({exe,fixture,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,data,chromium,scenario:launchCheck?'relocated-runtime-check':rtc?'WebRTC-loopback':'video',mode:'normal browser; disposable profile; muted autoplay; no CDP'},null,2));
 let resolveReport;const received=new Promise(resolve=>resolveReport=resolve);
 let reportSaved=false;
 const server=http.createServer((req,res)=>{
  if(req.url==='/report'&&req.method==='POST'){
   if(reportSaved){res.writeHead(409);res.end();return;}
   let chunks=[],length=0;req.on('data',chunk=>{length+=chunk.length;if(length>4*1024*1024){req.destroy();return;}chunks.push(chunk);});
   req.on('end',()=>{try{const raw=JSON.parse(Buffer.concat(chunks).toString());fs.writeFileSync(path.join(report,'observation.json'),JSON.stringify(raw,null,2));
     if(raw.remotePng){if(!raw.remotePng.startsWith('data:image/png;base64,'))throw Error('Invalid remote PNG');fs.writeFileSync(path.join(report,'remote.png'),Buffer.from(raw.remotePng.slice(22),'base64'));delete raw.remotePng;fs.writeFileSync(path.join(report,'observation.json'),JSON.stringify(raw,null,2));}
     const summary=launchCheck?{valid:raw.webgl2===true&&raw.glError===0&&raw.pixel?.[0]===64&&raw.pixel?.[1]===128&&raw.pixel?.[2]===191&&raw.pixel?.[3]===255&&!/swiftshader|llvmpipe|software/i.test(raw.gpu||''),scope:'Relocated runtime startup and WebGL readback, not benchmark',gpu:raw.gpu}:rtc?summarizeWebRTC(raw):summarizeSustained(raw);
     fs.writeFileSync(path.join(report,'summary.json'),JSON.stringify(summary,null,2));reportSaved=true;res.end('saved');resolveReport(summary);
    }catch(e){res.writeHead(400);res.end('invalid report');}});return;
  }
  if(req.url==='/fixture.mp4'){
   const range=req.headers.range;
   if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);const start=match?Number(match[1]):NaN,end=match&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
    if(!Number.isInteger(start)||start<0||start>end||start>=bytes.length){res.writeHead(416,{'Content-Range':'bytes */'+bytes.length});res.end();return;}
    res.writeHead(206,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));
   }else{res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length,'Accept-Ranges':'bytes'});res.end(bytes);}return;
  }
  if(req.url!=='/'&&req.url!=='/measurement'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.url==='/'?activeShell:activePage);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
 const url='http://127.0.0.1:'+server.address().port+'/';
 const browserArgs=chromium?['--user-data-dir='+data,'--no-first-run','--no-default-browser-check','--new-window',url]:['--url='+url];
 const child=spawn(exe,browserArgs,{env,windowsHide:true,stdio:'ignore'}),state=observeChild(child);
 let timer;
 try{
  const summary=await Promise.race([received,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Report timeout; PID='+child.pid)),120000);}),state.done.then(()=>{throw Error('Browser exited before report');})]);
  clearTimeout(timer);
  // Graceful WM_CLOSE via taskkill, only our freshly spawned process; no /F.
  await promisify(execFile)('taskkill.exe',['/PID',String(child.pid)],{windowsHide:true,timeout:10000});
  const exit=await waitForExit(state,15000);
  fs.writeFileSync(path.join(report,'lifecycle.json'),JSON.stringify({exit,reportSaved,gracefulCloseRequested:true},null,2));
  console.log(JSON.stringify(summary,null,2));if(exit!==0)throw Error('Unclean browser exit '+exit);if((rtc||launchCheck)&&!summary.valid)process.exitCode=1;
 }finally{
  clearTimeout(timer);
  if(!state.finished){
   try{await promisify(execFile)('taskkill.exe',['/PID',String(child.pid)],{windowsHide:true,timeout:10000});await waitForExit(state,15000);}
   catch(e){fs.writeFileSync(path.join(report,'cleanup-error.json'),JSON.stringify({pid:child.pid,error:e.message},null,2));}
  }
  server.closeAllConnections();server.close();child.unref();
 }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={summarizeSustained,page,shell};
