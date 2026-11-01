// Native Chrome ExternalProtocolHandler integration; no desktop input or real applications.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {observeChild,requireRunning,waitForExit}=require('./diagnose-media.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const [exe,output,scheme,capture]=process.argv.slice(2);
 assert(exe&&output&&scheme&&capture,'Usage: <exe> <new-output> <registered-test-scheme> <capture-file> [case]');
 fs.mkdirSync(output,{recursive:true});
 const server=http.createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{Location:`${scheme}://fixture/redirect?value=one%20two`});return res.end();}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  if(req.url.startsWith('/frame?')){return res.end(`<a id=blank target=_blank href="${scheme}://fixture/sandbox">sandbox external link</a>`);}
  res.end(`<!doctype html><iframe id=restricted sandbox="allow-scripts" src="/frame?restricted"></iframe><iframe id=permitted sandbox="allow-scripts allow-popups" src="/frame?permitted"></iframe><title>External protocol fixture</title><a id="normal" href="${scheme}://fixture/normal?value=one%20two">normal</a><a id="blank" target="_blank" href="${scheme}://fixture/blank">blank</a><button id="popup" onclick="window.open('${scheme}://fixture/popup')">popup</button><a id="redirect" href="/redirect">redirect</a><a id="web-normal" href="/destination">web</a><a id="web-blank" target="_blank" href="/destination">web blank</a><button id="web-popup" onclick="window.open('/destination')">web popup</button><a id="missing" href="${scheme}-missing://fixture/missing">missing</a>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const cases=process.argv[6]?[process.argv[6]]:['normal','blank','popup','redirect','hash-after-click','prompt-normal','prompt-blank','prompt-popup','address','address-redirect','address-numeric','missing','script-popup','flood','sandbox-denied','sandbox-allowed','web-normal','web-blank','web-popup'];
 const results=[];
 try{for(const name of cases){
  const dir=path.join(output,name);fs.mkdirSync(dir);
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-native-protocol-'));
  const pref=path.join(data,'profile-smoke','Default');fs.mkdirSync(pref,{recursive:true});
  const prompt=!['normal','blank','popup','redirect','hash-after-click'].includes(name);
  // This models a previously granted origin/protocol permission ONLY in a synthetic profile.
  fs.writeFileSync(path.join(pref,'Preferences'),JSON.stringify(prompt?{}:{protocol_handler:{allowed_origin_protocol_pairs:{[base]:{[scheme]:true}}}}));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
  const child=spawn(exe,['--smoke-test','--test-cdp','--test-external-protocols',`--url=${base}/`],{env,stdio:'ignore'});
  const state=observeChild(child);fs.writeFileSync(path.join(dir,'location.json'),JSON.stringify({data,pid:child.pid,base,scheme},null,2));
  let socket,call,evaluate;
  try{
   const portFile=path.join(data,'profile-smoke','DevToolsActivePort');
   for(let i=0;!fs.existsSync(portFile)&&i<1200;i++){requireRunning(state);await delay(100);}
   const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
   const targets=async()=>await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
   const pages=await targets();const page=pages.find(p=>p.type==='page');assert(page);
   socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
   let serial=0;const pending=new Map();const trace=[];const logEntries=[];const childSessions=[];let traceDone;
   socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Target.attachedToTarget')childSessions.push(m.params);if(m.method==='Log.entryAdded')logEntries.push(m.params.entry.text);if(m.method==='Tracing.dataCollected')trace.push(...m.params.value);if(m.method==='Tracing.tracingComplete')traceDone?.();const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}};
   call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial,t=setTimeout(()=>{pending.delete(id);reject(Error(`timeout ${method}`))},12000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v)},reject:e=>{clearTimeout(t);reject(e)}});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
   evaluate=async(expression,userGesture=false)=>(await call('Runtime.evaluate',{expression,returnByValue:true,userGesture})).result.value;
   await call('Page.enable');await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
   let fixtureReady=false;
   for(let i=0;i<600;i++){if(await evaluate("location.href==="+JSON.stringify(base+'/')+"&&document.readyState==='complete'&&!!document.getElementById('normal')")){fixtureReady=true;break;}await delay(100);}
   assert(fixtureReady,'protocol fixture did not finish loading before the action');
   if(name==='normal'){
    const tokens=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'inspect-test-process-tokens.ps1'),'-RootProcessId',String(child.pid)],{encoding:'utf8',windowsHide:true,timeout:30000}));
    fs.writeFileSync(path.join(dir,'tokens.json'),JSON.stringify(tokens,null,2));
    const network=tokens.filter(t=>t.Subtype==='network.mojom.NetworkService'),renderers=tokens.filter(t=>t.Role==='renderer');
    assert(network.length&&network.every(t=>t.AppContainer===1&&t.IntegrityRid<=4096&&t.SandboxType==='network'&&t.Error===0),'NetworkService token isolation failed');
    assert(renderers.length&&renderers.every(t=>t.Restricted&&t.IntegrityRid<=4096&&t.Error===0),'renderer token isolation failed');
   }
   const histogram=async name=>{try{return(await call('Browser.getHistogram',{name})).histogram}catch{return null}};
   await call('Log.enable');await call('Tracing.start',{categories:'ui,views',transferMode:'ReportEvents'});
   const before=fs.existsSync(capture)?fs.readFileSync(capture,'utf8'):'';
   if(name.startsWith('sandbox-')){
    const suffix=name==='sandbox-denied'?'restricted':'permitted';
    for(const child of childSessions){try{const r=await call('Runtime.evaluate',{expression:'location.href',returnByValue:true},child.sessionId);child.targetInfo.url=r.result.value;}catch{}}
    const child=childSessions.find(s=>s.targetInfo.url.endsWith('/frame?'+suffix));
    if(child)await call('Runtime.evaluate',{expression:"document.getElementById('blank').click()",userGesture:true},child.sessionId);
    else{const tree=await call('Page.getFrameTree');const frame=tree.frameTree.childFrames?.find(f=>f.frame.url.endsWith('/frame?'+suffix));
     if(!frame)fs.writeFileSync(path.join(dir,'frames-debug.json'),JSON.stringify({tree,childSessions,dom:await evaluate('document.documentElement.outerHTML')},null,2));
     assert(frame,'expected sandbox frame');const world=await call('Page.createIsolatedWorld',{frameId:frame.frame.id,worldName:'protocol-sandbox-test'});
     await call('Runtime.evaluate',{expression:"document.getElementById('blank').click()",contextId:world.executionContextId,userGesture:true});
    }
   }
   else if(name.startsWith('web-')){try{await evaluate(`document.getElementById(${JSON.stringify(name)}).click()`,true);}catch(error){if(!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(error.message))throw error;}let reached=false;for(let i=0;i<150;i++){try{if(await evaluate("location.href==="+JSON.stringify(base+'/destination')+"&&document.readyState==='complete'")){reached=true;break;}}catch(error){if(!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(error.message))throw error;}await delay(100);}assert(reached,'HTTP link did not reach destination');}
   else if(name==='hash-after-click')await evaluate("document.getElementById('blank').click();location.hash='after-protocol'",true);
   else if(name==='script-popup')await evaluate(`window.open('${scheme}://fixture/script-popup')`,false);
   else if(name==='flood')await evaluate(`for(let i=0;i<8;i++)document.getElementById('blank').click()`,true);
   else if(name==='address'||name==='address-redirect'||name==='address-numeric')await evaluate(`document.title=${JSON.stringify('ChroMinimum test external address '+(name==='address-redirect'?base+'/redirect':name==='address-numeric'?scheme+':42':scheme+'://fixture/address'))}`);
   else await evaluate(`document.getElementById(${JSON.stringify(name.replace('prompt-',''))}).click()`,true);
   await delay(6000);
   assert.equal(await evaluate('6*7'),42,'browser UI/CDP stopped responding');
   const after=fs.existsSync(capture)?fs.readFileSync(capture,'utf8'):'';
   const launched=after.slice(before.length);
   const traceFinished=new Promise(r=>{traceDone=r});await call('Tracing.end');await Promise.race([traceFinished,delay(5000)]);
   const widgets=trace.filter(e=>e.name==='Widget::LayoutRootViewIfNecessary').map(e=>e.args?.['widget name']).filter(Boolean);
   const block=await histogram('BrowserDialogs.ExternalProtocol.BlockState');
   const handlesBefore=await histogram('BrowserDialogs.ExternalProtocol.HandleState');
   const pageTargets=(await targets()).filter(p=>p.type==='page').map(p=>({id:p.id,url:p.url}));
   await call('Page.navigate',{url:base+'/after'});await delay(600);
   const handlesAfter=await histogram('BrowserDialogs.ExternalProtocol.HandleState');
   const record={name,prompt,launched,logEntries,viewTrace:trace.filter(e=>e.name?.startsWith('Widget::')).map(e=>({name:e.name,args:e.args})),widgets:[...new Set(widgets)],native_dialog_shows:trace.filter(e=>e.name==='Widget::Show'&&e.args?.layer==='ExternalProtocolDialog').length,block,handlesBefore,handlesAfter,pages:pageTargets,cdp_responsive:true};
   fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(record,null,2));
   console.log(JSON.stringify(record));
   await call('Page.close');socket.close();
   // Close any temporary native-created popup through its own CDP session.
   for(const p of (await targets()).filter(p=>p.type==='page')){
    const ws=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});ws.send(JSON.stringify({id:1,method:'Page.close'}));await delay(100);ws.close();
   }
   record.exit_code=await waitForExit(state,15000);
   record.shutdown_complete=fs.readFileSync(path.join(data,'smoke.log'),'utf8').includes('shutdown_complete');
   assert.equal(record.exit_code,0);assert(record.shutdown_complete);
   if(name.startsWith('web-')){assert.equal(launched,'');assert.equal(record.native_dialog_shows,0);assert.equal(pageTargets[0].url,base+'/destination');}
   else if(prompt){assert.equal(launched,'','unapproved launch');if(['missing','script-popup','sandbox-denied'].includes(name))assert.equal(record.native_dialog_shows,0);else assert(record.native_dialog_shows>=1,'expected native Chrome dialog');}else {const suffix={normal:'normal?value=one%20two',blank:'blank',popup:'popup',redirect:'redirect?value=one%20two','hash-after-click':'blank'}[name];assert.equal(launched,`${scheme}://fixture/${suffix}\n`,'handler must receive the exact URI');}
   assert.equal(pageTargets.length,1,'external link created an extra page');
   if(name==='flood'){assert.equal(block?.buckets?.find(b=>b.low===6)?.count,1,'expected one native prompt policy decision');assert.equal(logEntries.filter(s=>s.includes('because a user gesture is required')).length,7,'expected seven native anti-flood rejections');}
   fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(record,null,2));results.push(record);
  }finally{if(!state.finished&&call){try{await call('Page.close')}catch{}}socket?.close();if(!state.finished){try{await waitForExit(state,3000)}catch{child.kill()}}state.detach();for(const file of ['smoke.log','cef.log'])if(fs.existsSync(path.join(data,file)))fs.copyFileSync(path.join(data,file),path.join(dir,file));}
 }}finally{server.closeAllConnections();server.close();fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({results},null,2));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
