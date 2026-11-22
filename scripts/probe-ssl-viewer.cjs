// Interactive diagnostic controller. Uses only a fresh profile and loopback CDP.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {observeChild,requireRunning,waitForExit}=require('./diagnose-media.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const [exe,out]=process.argv.slice(2).map(p=>path.resolve(p));fs.mkdirSync(out);
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-viewer-'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
 const start=Date.now(),child=spawn(exe,['--smoke-test','--test-cdp','--test-native-security-panel','--test-cef-locale=ru','--url=https://example.com/'],{env,stdio:'ignore'});
 const state=observeChild(child),events=[],sockets=[];
 function rpc(url){return new Promise((resolve,reject)=>{const ws=new WebSocket(url);let id=0;const pending=new Map();sockets.push(ws);
 ws.onopen=()=>resolve((method,params={})=>new Promise((r,j)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);j(Error('timeout '+method))},10000);pending.set(n,{r:v=>{clearTimeout(t);r(v)},j:e=>{clearTimeout(t);j(e)}});ws.send(JSON.stringify({id:n,method,params}));}));ws.onerror=reject;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method?.startsWith('Target.')){events.push({at:Date.now(),method:m.method,params:m.params});fs.writeFileSync(path.join(out,'target-events.json'),JSON.stringify(events,null,2));}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result)}};});}
 let call,browser;
 try{
  const portFile=path.join(data,'profile-smoke','DevToolsActivePort');for(let i=0;!fs.existsSync(portFile)&&i<1200;i++){requireRunning(state);await delay(50);}
  const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
  const targets=async()=>await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();browser=await rpc(version.webSocketDebuggerUrl);await browser('Target.setDiscoverTargets',{discover:true});
  const page=(await targets()).find(p=>p.type==='page');call=await rpc(page.webSocketDebuggerUrl);
  let loaded=false;for(let i=0;i<1200;i++){requireRunning(state);const r=await call('Runtime.evaluate',{expression:'({ready:document.readyState,url:location.href})',returnByValue:true});if(r.result?.value?.ready==='complete'&&r.result.value.url==='https://example.com/'){loaded=true;break;}await delay(50);}if(!loaded)throw Error('Fixture URL did not finish loading');
  const ready={pid:child.pid,exe,data,start,port,mainTarget:page.id};fs.writeFileSync(path.join(out,'ready.json'),JSON.stringify(ready,null,2));
  const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');emit({ready});
  const lines=readline.createInterface({input:process.stdin});
  for await(const line of lines){if(!line.trim())continue;try{const command=JSON.parse(line);requireRunning(state);let result;
   if(command.action==='open')result=await call('Runtime.evaluate',{expression:"document.title='ChroMinimum test security panel open'"});
   else if(command.action==='inspect')result=await call('Runtime.evaluate',{expression:"document.title='ChroMinimum test security panel inspect'"});
   else if(command.action==='targets')result=await targets();
   else if(command.action==='viewer'){
    const list=await targets();const viewer=list.find(p=>p.url.includes('view-cert'));if(!viewer){result={found:false,targets:list};}
    else {const viewerCall=await rpc(viewer.webSocketDebuggerUrl);const r=await viewerCall('Runtime.evaluate',{expression:"JSON.stringify({url:location.href,ready:document.readyState,tabHidden:document.querySelector('#tabbox')?.hidden,general:document.querySelector('#general-fields')?.innerText,body:document.body.innerText,timing:performance.getEntriesByType('navigation').map(x=>x.toJSON())})",returnByValue:true});result={at:Date.now(),target:viewer.id,content:JSON.parse(r.result.value)};fs.writeFileSync(path.join(out,'viewer-'+Date.now()+'.json'),JSON.stringify(result,null,2));}
   }else if(command.action==='eval')result=await call('Runtime.evaluate',{expression:command.expression,returnByValue:true,awaitPromise:true});
   else if(command.action==='close'){await call('Page.close');await waitForExit(state,20000);emit({closed:true,code:state.code});break;}
   else throw Error('Unknown action');emit({action:command.action,result});
  }catch(e){emit({error:String(e)});}}
 }finally{for(const ws of sockets)ws.close();if(!state.finished&&call)await call('Page.close').catch(()=>{});if(!state.finished){try{await waitForExit(state,5000)}catch{child.kill()}}for(const name of ['cef.log','smoke.log'])if(fs.existsSync(path.join(data,name)))fs.copyFileSync(path.join(data,name),path.join(out,name));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
