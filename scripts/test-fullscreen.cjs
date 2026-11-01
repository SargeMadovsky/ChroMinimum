// Native fullscreen integration through a disposable page and loopback CDP.
// Never uses a personal profile or sends native desktop input.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
let browserPid;
const watchdog = setTimeout(() => {
  console.error(`Fullscreen diagnostic timeout; browser PID=${browserPid ?? 'not started'}; browser not terminated`);
  process.exit(1);
}, 120000);

async function main() {
  if (process.argv.length !== 4) throw Error('Usage: node test-fullscreen.cjs <bootstrap.exe> <new-output>');
  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));
  fs.mkdirSync(output);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<!doctype html><title>Fullscreen fixture</title><video id="movie" controls style="width:320px;height:180px;background:#123456"></video>');
  });
  let socket, lifecycle, closeOwnPage;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CHROMINIMUM_')));
    env.CHROMINIMUM_DATA_DIR = output;
    const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-chrome-downloads', `--url=http://127.0.0.1:${server.address().port}/`], {env, stdio:'ignore'});
    browserPid = child.pid;
    const state = observeChild(child);
    lifecycle = state;
    const portFile = path.join(output, 'profile-smoke', 'DevToolsActivePort');
    for (let i=0; !fs.existsSync(portFile) && i<150; i++) {requireRunning(state); await delay(100);}
    requireRunning(state);
    const port = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    let page;
    for (let i=0; !page && i<30; i++) {
      requireRunning(state);
      try {page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(1000)})).json()).find(p=>p.type==='page');} catch {}
      if (!page) await delay(100);
    }
    assert(page, 'CDP page unavailable');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;
    const pending=new Map();
    socket.onmessage=e=>{
      const m=JSON.parse(e.data), pair=pending.get(m.id);
      if (pair) {pending.delete(m.id); m.error ? pair.reject(Error(JSON.stringify(m.error))) : pair.resolve(m.result);}
    };
    socket.onclose=()=>{for(const p of pending.values()) p.reject(Error('CDP closed'));pending.clear();};
    const call=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial, timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}: ${params.expression || ''}`));},10000);
      pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const r=await call('Runtime.evaluate',{expression,returnByValue:true,userGesture:true,awaitPromise:true});
      assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    closeOwnPage=()=>call('Page.close');
    let ready=false;
    for(let i=0;i<600;i++) {
      if(await evaluate('document.readyState === "complete" && !!document.getElementById("movie")')) {ready=true;break;}
      await delay(100);
    }
    assert(ready, 'Fullscreen fixture did not finish loading');
    await call('Page.bringToFront');
    const measure=()=>evaluate('({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,fullscreen:!!document.fullscreenElement,error:globalThis.fullscreenError||null})');
    const normal=await measure(), cycles=[];
    for(let cycle=0;cycle<2;cycle++) {
      await evaluate('document.getElementById("movie").requestFullscreen().catch(e=>{globalThis.fullscreenError=e.name}); true');
      let full;
      for(let i=0;i<40;i++) {full=await measure();if(full.fullscreen && Math.abs(full.height-full.screenHeight)<=2) break; await delay(50);}
      cycles.push({fullscreen:full});
      if(cycle===0) {
        await evaluate('document.exitFullscreen().catch(e=>{globalThis.fullscreenError=e.name}); true');
        cycles[cycle].exit_method='document.exitFullscreen';
      } else {
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
        cycles[cycle].exit_method='Escape';
      }
      let restored;
      for(let i=0;i<40;i++) {restored=await measure();if(!restored.fullscreen && restored.height===normal.height) break;await delay(50);}
      cycles[cycle].restored=restored;
    }
    await closeOwnPage();
    socket.close();
    const code=await waitForExit(state,45000);
    const log=fs.readFileSync(path.join(output,'smoke.log'),'utf8');
    const result={normal,cycles,exit_code:code,hidden_events:(log.match(/^fullscreen_toolbar_hidden$/gm)||[]).length,
      restored_events:(log.match(/^fullscreen_toolbar_restored$/gm)||[]).length,shutdown_complete:log.split(/\r?\n/).includes('shutdown_complete')};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    for(const c of cycles) {
      assert(c.fullscreen.fullscreen && Math.abs(c.fullscreen.height-c.fullscreen.screenHeight)<=2, 'Fullscreen leaves space for browser UI');
      assert(!c.restored.fullscreen && c.restored.height===normal.height, 'Normal viewport not restored');
    }
    assert.equal(code,0);assert(result.shutdown_complete);assert(result.hidden_events>=2 && result.restored_events>=2);
    console.log(JSON.stringify(result,null,2));
  } finally {if(!lifecycle?.finished && closeOwnPage)await closeOwnPage().catch(()=>{});lifecycle?.detach();socket?.close();server.closeAllConnections();server.close();}
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
