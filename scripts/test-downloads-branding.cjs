// Pinned downloads branding acceptance. Only a fresh profile and loopback CDP.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const {observeChild,requireRunning,waitForExit}=require('./diagnose-media.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const [exe,output]=process.argv.slice(2).map(p=>path.resolve(p));
 assert(exe&&output);fs.mkdirSync(output);
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-branding-'));
 fs.writeFileSync(path.join(output,'profile-location.json'),JSON.stringify({data,disposable:true}));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
 const child=spawn(exe,['--smoke-test','--test-cdp','--test-chrome-downloads','--url=chrome://downloads/'],{env,stdio:'ignore'});
 const state=observeChild(child);let socket,call;
 try{
  const portFile=path.join(data,'profile-smoke','DevToolsActivePort');
  for(let i=0;!fs.existsSync(portFile)&&i<600;i++){requireRunning(state);await delay(100);}
  const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
  const targets=async()=>await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page;
  for(let i=0;i<600&&!page;i++){
   requireRunning(state);
   try{page=(await targets()).find(p=>p.type==='page')}catch{}
   if(!page)await delay(100);
  }
  assert(page,'Branding page unavailable');
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  let serial=0;const pending=new Map();const errors=[];
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry.text);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}};
  call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,t=setTimeout(()=>{pending.delete(id);reject(Error(`timeout ${method}`))},12000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v)},reject:e=>{clearTimeout(t);reject(e)}});socket.send(JSON.stringify({id,method,params}));});
  await call('Log.enable');
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
  const inspect=`(()=>{const toolbar=document.querySelector('downloads-manager')?.shadowRoot?.querySelector('downloads-toolbar')?.shadowRoot?.querySelector('cr-toolbar');const logo=toolbar?.querySelector('#chrominimum-downloads-logo');const slot=toolbar?.shadowRoot?.querySelector('slot[name="product-logo"]');if(!logo||!slot)return null;const r=logo.getBoundingClientRect();return{url:location.href,assigned:slot.assignedElements().includes(logo),complete:logo.complete,naturalWidth:logo.naturalWidth,naturalHeight:logo.naturalHeight,width:r.width,height:r.height,alt:logo.alt,src:logo.currentSrc,scheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}})()`;
  const expected=createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../assets/chrominimum.svg'))).digest('hex');
  const results=[];
  for(const theme of ['light','dark']){
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
   // WebUI can leave the light page transparent over its native Views host.
   // Supply the matching capture background instead of a misleading black PNG.
   const channel=theme==='light'?255:32;
   await call('Emulation.setDefaultBackgroundColorOverride',{color:{r:channel,g:channel,b:channel,a:1}});
   let observed;for(let i=0;i<600;i++){requireRunning(state);observed=await evaluate(inspect);if(observed?.complete&&observed.naturalWidth&&observed.scheme===theme)break;await delay(100);}
   assert(observed?.assigned,'Product logo slot is not assigned');assert(observed.complete&&observed.naturalWidth>0,'Logo did not decode');
   assert.equal(observed.width,32);assert.equal(observed.height,32);assert.equal(observed.alt,'ChroMinimum');assert.equal(observed.url,'chrome://downloads/');
   const prefix='data:image/svg+xml;base64,';assert(observed.src.startsWith(prefix));
   assert.equal(createHash('sha256').update(Buffer.from(observed.src.slice(prefix.length),'base64')).digest('hex'),expected);
   delete observed.src;results.push(observed);
   const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,theme+'.png'),Buffer.from(shot.data,'base64'));
  }
  const pages=(await targets()).filter(p=>p.type==='page');assert.equal(pages.length,1);assert.equal(errors.length,0,errors.join('\n'));
  await call('Page.close');socket.close();const code=await waitForExit(state,45000);assert.equal(code,0);
  const log=fs.readFileSync(path.join(data,'smoke.log'),'utf8');assert(log.split(/\r?\n/).includes('shutdown_complete'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({results,one_page:true,errors,exit_code:code,shutdown_complete:true},null,2));
  console.log('PASS downloads product-logo in light/dark, exact SVG, one page, clean shutdown');
 }finally{if(!state.finished&&call)await call('Page.close').catch(()=>{});socket?.close();state.detach();for(const n of ['smoke.log','cef.log'])if(fs.existsSync(path.join(data,n)))fs.copyFileSync(path.join(data,n),path.join(output,n));}
}
const timer=setTimeout(()=>{console.error('Branding runner timed out');process.exit(1)},150000);
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>clearTimeout(timer));
