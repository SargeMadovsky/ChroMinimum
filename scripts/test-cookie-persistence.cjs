// Synthetic cookies only, loopback server and disposable profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {observeChild,requireRunning,waitForExit}=require('./diagnose-media.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const [exeArg,outArg]=process.argv.slice(2);assert(exeArg&&outArg);
 const exe=path.resolve(exeArg),out=path.resolve(outArg);fs.mkdirSync(out);
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-cookies-'));
 const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/seed')res.setHeader('Set-Cookie',[
   'cm_http=persistent; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/',
   'cm_session=session; HttpOnly; SameSite=Lax; Path=/',
   'cm_path=restricted; Max-Age=3600; SameSite=Lax; Path=/scoped',
   'cm_expired=gone; Max-Age=0; SameSite=Lax; Path=/',
   'cm_strict=strict; Max-Age=3600; SameSite=Strict; Path=/'
  ]);
  if(req.url==='/cross'){
   const destination=`http://127.0.0.1:${server.address().port}/echo`;
   res.setHeader('Content-Type','text/html');
   res.end(`<a href="${destination}?get">GET</a><form method="post" action="${destination}?post"><button>POST</button></form>`);
  }else if(req.url.startsWith('/echo')||req.url.startsWith('/scoped')){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie||'',method:req.method,site:req.headers['sec-fetch-site']||''}));
  }else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Cookie fixture</title><p>Synthetic cookie fixture</p>');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`,results=[];
 try{
 for(let phase=0;phase<2;phase++){
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR=data;
  const portFile=path.join(data,'profile-smoke','DevToolsActivePort');
  if(fs.existsSync(portFile))fs.unlinkSync(portFile);
  const child=spawn(exe,['--smoke-test','--test-cdp',`--url=${origin}/${phase===0?'seed':'check'}`],{env,stdio:'ignore'});
  const state=observeChild(child);let ws,call;
  try{
   for(let i=0;!fs.existsSync(portFile)&&i<600;i++){requireRunning(state);await delay(50);}
   const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
   const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
   const target=list.find(t=>t.type==='page');assert(target);
   ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
   let serial=0;const pending=new Map();
   ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result)}};
   call=(method,params={})=>new Promise((r,j)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);j(Error('CDP timeout '+method))},10000);pending.set(id,{r:x=>{clearTimeout(timer);r(x)},j:x=>{clearTimeout(timer);j(x)}});ws.send(JSON.stringify({id,method,params}));});
   let loaded=false;for(let i=0;i<200;i++){const r=await call('Runtime.evaluate',{expression:'({ready:document.readyState,url:location.href})',returnByValue:true});if(r.result?.value?.ready==='complete'&&r.result.value.url===`${origin}/${phase===0?'seed':'check'}`){loaded=true;break;}await delay(50);}assert(loaded,'Fixture did not load');
   const snap=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{${phase===0?"document.cookie='cm_js=persistent; Max-Age=3600; SameSite=Lax; Path=/';":''}return {js:document.cookie,root:await(await fetch('/echo')).json(),scoped:await(await fetch('/scoped/echo')).json()}})()`});
   assert(!snap.exceptionDetails,JSON.stringify(snap.exceptionDetails));const value=snap.result.value;
   assert(value.js.includes('cm_js=persistent'));assert(!value.js.includes('cm_http='));
   for(const name of ['cm_js=persistent','cm_http=persistent'])assert(value.root.cookie.includes(name));
   assert(!value.root.cookie.includes('cm_path='));assert(value.scoped.cookie.includes('cm_path=restricted'));
   assert(!value.root.cookie.includes('cm_expired='));assert(value.root.cookie.includes('cm_strict=strict'));
   if(phase===0)assert(value.root.cookie.includes('cm_session=session'));
   const result={phase, ...value};results.push(result);
   if(phase===0){
    result.crossSite=[];
    async function waitUrl(expected){
     for(let i=0;i<200;i++){
      const r=await call('Runtime.evaluate',{returnByValue:true,expression:'({url:location.href,ready:document.readyState,body:document.body?.innerText})'});
      const v=r.result?.value;if(v?.url===expected&&v.ready==='complete')return v;
      await delay(50);
     }throw Error('Navigation did not complete: '+expected);
    }
    for(const method of ['GET','POST']){
     const cross=`http://localhost:${server.address().port}/cross`;
     await call('Page.navigate',{url:cross});await waitUrl(cross);
     await call('Runtime.evaluate',{expression:method==='GET'?"document.querySelector('a').click()":"document.querySelector('form').requestSubmit()"});
     const landing=await waitUrl(`${origin}/echo?${method.toLowerCase()}`);
     const observed=JSON.parse(landing.body);
     assert.equal(observed.method,method);assert.equal(observed.site,'cross-site');
     assert(!observed.cookie.includes('cm_strict='));
     assert.equal(observed.cookie.includes('cm_http=persistent'),method==='GET');
     assert.equal(observed.cookie.includes('cm_js=persistent'),method==='GET');
     result.crossSite.push(observed);
    }
   }
   await call('Page.close');assert.equal(await waitForExit(state,20000),0);
   const log=fs.readFileSync(path.join(data,'smoke.log'),'utf8');assert(log.includes('shutdown_complete'));
   fs.copyFileSync(path.join(data,'smoke.log'),path.join(out,`smoke-${phase}.log`));
  }finally{ws?.close();if(!state.finished){try{await call?.('Page.close');await waitForExit(state,20000)}catch{state.detach()}}}
 }
 const summary={passed:true,scope:'first-party loopback HTTP persistence and cross-site localhost to 127.0.0.1 GET/POST SameSite; two clean process launches',data,results,sessionAfterRestart:results[1].root.cookie.includes('cm_session='),limits:['HTTPS Secure cookie and third-party iframe policy not tested','Session restore policy observed, not asserted']};
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
 }finally{server.closeAllConnections();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
