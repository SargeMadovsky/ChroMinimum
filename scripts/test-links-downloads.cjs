// Chromium download WebUI integration on disposable loopback fixtures and TEMP profiles.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function main() {
  const [exe, output] = process.argv.slice(2).map(p=>path.resolve(p));
  const mode=process.argv[4] || 'complete';
  const nativeBubble=process.argv.includes('--native-bubble');
  const progressRing=process.argv.includes('--progress-ring');
  const glyphSwap=process.argv.includes('--glyph-swap');
  assert(!progressRing || nativeBubble, 'Ring checks require --native-bubble');
  assert(['complete','cancel','interrupt','links'].includes(mode));
  assert(exe && output, 'Usage: node test-links-downloads.cjs <exe> <new-output>');
  fs.mkdirSync(output);
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-links-downloads-'));
  fs.writeFileSync(path.join(output,'profile-location.json'),JSON.stringify({data,disposable:true},null,2));
  const server = http.createServer((req,res)=>{
    if(req.url.startsWith('/file')) {
      const total=1024*1024*8;
      res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.bin"','Content-Length':total});
      let sent=0;
      const timer=setInterval(()=>{const chunk=Buffer.alloc(Math.min(65536,total-sent),0x5a);res.write(chunk);sent+=chunk.length;if(req.url.includes('abort')&&sent>=512*1024){clearInterval(timer);res.destroy();}else if(sent>=total){clearInterval(timer);res.end();}},100);
      res.on('close',()=>clearInterval(timer));return;
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><title>Link download fixture</title><style>body{font:22px sans-serif;padding:30px}a,button{display:block;margin:20px}</style>
      <h1>Link / download fixture</h1><a id="blank" href="/destination" target="_blank">GitHub-style target blank</a>
      <a id="normal" href="/destination">Ordinary link</a><button id="popup" onclick="window.open('/destination')">Gesture popup</button>
      <a id="download" href="/file">Download 8 MiB fixture</a><a href="/">Home</a>`);
  });
  let socket, state, closeOwnPage;
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));
    env.CHROMINIMUM_DATA_DIR=data;
    const child=spawn(exe,['--smoke-test','--test-cdp','--test-chrome-downloads',`--url=${base}/`],{env,stdio:'ignore'});
    state=observeChild(child);
    const portFile=path.join(data,'profile-smoke','DevToolsActivePort');
    for(let i=0;!fs.existsSync(portFile)&&i<600;i++){requireRunning(state);await delay(100);}
    const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
    await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
    let serial=0;const pending=new Map();
    socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const t=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout ${method}`));},60000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});socket.send(JSON.stringify({id,method,params}));});
    closeOwnPage=()=>call('Page.close');
    const evaluate=async(expression,userGesture=false)=>{
      const result=await call('Runtime.evaluate',{expression,returnByValue:true,userGesture});
      if(result.exceptionDetails)throw Error(`Fixture evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      return result.result.value;
    };
    async function waitUrl(url){for(let i=0;i<600;i++){
      if(await evaluate(`location.href===${JSON.stringify(url)} && document.readyState==='complete' && ${url===base+'/'?"!!document.getElementById('normal')":'true'}`))return;
      await delay(100);
    }throw Error(`Navigation did not reach ready document ${url}`);}
    await waitUrl(base+'/'); await delay(500); const checks=[];
    for(const id of ['normal','blank','popup']) {
      await call('Page.navigate',{url:base+'/'});await waitUrl(base+'/');await delay(200);
      await evaluate(`document.getElementById('${id}').click()`,true);
      await waitUrl(base+'/destination');checks.push(id);
    }
    await call('Page.navigate',{url:base+'/'});await waitUrl(base+'/');await delay(200);
    await evaluate('window.open("/destination")',false);await delay(300);
    assert.equal(await evaluate('location.href'),base+'/');checks.push('unsolicited_popup_blocked');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    assert.equal(targets.filter(p=>p.type==='page').length,1);
    fs.writeFileSync(path.join(output,'links.json'),JSON.stringify({checks,base,pid:child.pid},null,2));
    console.log(`PASS links ${JSON.stringify(checks)}`);
    const downloads=path.join(data,'downloads');fs.mkdirSync(downloads);
    await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
    async function waitValue(expression,predicate,label) {
      for(let i=0;i<600;i++){requireRunning(state);const value=await evaluate(expression);if(predicate(value))return value;await delay(100);}
      throw Error(`Timed out: ${label}`);
    }
    if(mode!=='links') {
      if(mode==='interrupt') await evaluate('document.getElementById("download").href="/file/abort"');
      await evaluate('document.getElementById("download").click()',true);
    }
    const log=()=>fs.readFileSync(path.join(data,'smoke.log'),'utf8');
    const cefLog=()=>fs.readFileSync(path.join(data,'cef.log'),'utf8');
    let bubbleGeometry=null, resizeGeometry=null;
    const readBubbles=()=>[...cefLog().matchAll(/CM_DOWNLOAD_BUBBLE mode=(\w+) anchor=(-?\d+),(-?\d+),(\d+),(\d+) bubble=(-?\d+),(-?\d+),(\d+),(\d+)/g)].map(m=>({mode:m[1],anchor:m.slice(2,6).map(Number),bubble:m.slice(6,10).map(Number)}));
    const readRings=()=>[...cefLog().matchAll(/CM_DOWNLOAD_RING state=(\d+) count=(\d+) percent=(-?\d+) drawn=(\d+)/g)].map(m=>({state:+m[1],count:+m[2],percent:+m[3],drawn:+m[4]}));
    async function pressDownloads(){
      await evaluate('document.title="ChroMinimum test downloads reset"');await delay(100);
      await evaluate('document.title="ChroMinimum test downloads button"');await delay(400);
    }
    function checkGeometry(g){
      const [ax,ay,aw,ah]=g.anchor,[bx,by,bw,bh]=g.bubble;
      assert(aw>=24 && ah>=24 && bw>100 && bh>40,'Invalid native bubble size');
      assert(bw<640,'Native download panel is not compact');
      assert(bx<=ax+aw && bx+bw>=ax,'Bubble is detached horizontally');
      assert(Math.abs((bx+bw)-(ax+aw))<=80,'Bubble is not aligned to the download button');
      assert(Math.abs(by-(ay+ah))<=45,'Bubble is detached vertically');
    }
    if(nativeBubble && mode!=='links') {
      for(let i=0;i<300 && !fs.readdirSync(downloads).length;i++){requireRunning(state);await delay(100);}
      assert(fs.readdirSync(downloads).length,'Download never started');
      let before=readBubbles().filter(b=>b.mode==='complete').length;
      await pressDownloads();
      if(readBubbles().filter(b=>b.mode==='complete').length===before) await pressDownloads();
      for(let i=0;i<100 && readBubbles().filter(b=>b.mode==='complete').length===before;i++) await delay(100);
      bubbleGeometry=readBubbles().filter(b=>b.mode==='complete').at(-1);assert(bubbleGeometry,'Native mini-panel was not shown');checkGeometry(bubbleGeometry);
      assert.equal(await evaluate('location.href'),base+'/','Button replaced the site instead of showing a bubble');
      assert(cefLog().includes('CM_DOWNLOAD_FLIGHT_SUPPRESSED'),'No proof of flight animation suppression');
      if(mode==='complete') {
        await evaluate('document.title="ChroMinimum test downloads resize"');await delay(400);
        assert(log().includes('downloads_window_resized'));
        before=readBubbles().filter(b=>b.mode==='complete').length;
        await pressDownloads();if(readBubbles().filter(b=>b.mode==='complete').length===before)await pressDownloads();
        resizeGeometry=readBubbles().filter(b=>b.mode==='complete').at(-1);assert(resizeGeometry);checkGeometry(resizeGeometry);
        assert.notEqual(resizeGeometry.anchor[0],bubbleGeometry.anchor[0],'Anchor did not move after native resize');
      }
      // The native panel and full history are separate UI. Ctrl+J opens WebUI.
      await evaluate('document.title="ChroMinimum test downloads shortcut"');
      await waitUrl('chrome://downloads/');
    } else {
      await evaluate('document.title="ChroMinimum test downloads button"');
      await delay(1000);
      const emptyTargets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      fs.writeFileSync(path.join(output,'empty-history-targets.json'),JSON.stringify(emptyTargets,null,2));
      assert.equal(emptyTargets.filter(p=>p.type==='page').length,1,'Empty download history opened an extra page');
      await waitUrl('chrome://downloads/');
    }
    assert(log().includes('downloads_button_drawn'));assert(log().includes('downloads_button_pressed'));
    const itemExpression=`(()=>{const i=document.querySelector('downloads-manager')?.shadowRoot?.querySelector('downloads-item');const d=i?.data;return d?{id:d.id,state:d.state,percent:d.percent,fileName:d.fileName,filePath:d.filePath}:null})()`;
    let item=null, downloadBytes=null;
    if(mode!=='links') {
      item=await waitValue(itemExpression,v=>!!v,'Chrome download item');
      if(mode==='cancel') {
        await evaluate(`document.querySelector('downloads-manager').shadowRoot.querySelector('downloads-item').shadowRoot.querySelector('#cancel').click()`,true);
      }
      const expected={complete:2,cancel:1,interrupt:5}[mode];
      item=await waitValue(itemExpression,v=>v?.state===expected,`download state ${expected}`);
      if(mode==='complete') {
        const bytes=fs.readFileSync(path.join(downloads,'fixture.bin'));
        assert.equal(bytes.length,8*1024*1024);assert(bytes.every(b=>b===0x5a));downloadBytes=bytes.length;
      }
      const shot=await call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(output,'downloads.png'),Buffer.from(shot.data,'base64'));
    }
    if(progressRing && mode!=='links') {
      // The native controller must show and actually paint progress, then idle
      // after completion, cancellation, or interruption (no shell polling).
      for(let i=0;i<50 && readRings().at(-1)?.state!==0;i++)await delay(100);
      const rings=readRings();
      fs.writeFileSync(path.join(output,'progress-ring.json'),JSON.stringify({updates:rings},null,2));
      assert(rings.some(r=>r.count>0 && r.state===3 && r.percent>0 && r.percent<100),'Missing incremental download ring');
      assert(/CM_DOWNLOAD_RING_PAINT state=3 percent=\d+ width=[1-9]\d* height=[1-9]\d*/.test(cefLog()),'Native ring did not paint');
      assert.equal(rings.at(-1)?.state,0,'Ring remained active after download ended');
    }
    if(glyphSwap && mode!=='links') {
      const events=log().split(/\r?\n/).filter(line=>line==='download_glyph_hidden'||line==='download_glyph_restored');
      fs.writeFileSync(path.join(output,'glyph-events.json'),JSON.stringify(events,null,2));
      assert(events.includes('download_glyph_hidden'),'Glyph did not hide during download');
      assert.equal(events.at(-1),'download_glyph_restored','Glyph did not return after download ended');
    }
    fs.writeFileSync(path.join(output,'download-state.json'),JSON.stringify({mode,item,downloadBytes,bubbleGeometry,resizeGeometry},null,2));
    await call('Page.navigate',{url:base+'/'});await waitUrl(base+'/');await delay(200);
    await evaluate('document.title="ChroMinimum test downloads shortcut"');
    await waitUrl('chrome://downloads/');assert(log().includes('downloads_shortcut_handled'));
    const targetsAfter=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    fs.writeFileSync(path.join(output,'targets-after.json'),JSON.stringify(targetsAfter,null,2));
    assert.equal(targetsAfter.filter(p=>p.type==='page').length,1,'Downloads created a second page');
    const history=await call('Page.getNavigationHistory');
    const back=history.entries[history.currentIndex-1];assert(back);
    await call('Page.navigateToHistoryEntry',{entryId:back.id});await waitUrl(base+'/');
    await call('Page.close');socket.close();
    const code=await waitForExit(state,45000);assert.equal(code,0);assert(log().includes('shutdown_complete'));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({links:checks,mode,item,download_bytes:downloadBytes,button:true,shortcut:true,back:true,native_bubble:nativeBubble,bubbleGeometry,resizeGeometry,flight_suppressed:nativeBubble?cefLog().includes('CM_DOWNLOAD_FLIGHT_SUPPRESSED'):null,exit_code:code,shutdown_complete:true},null,2));
    console.log(`PASS Chrome downloads ${mode}, native button/shortcut delegates, back, graceful shutdown`);
  } finally {
    if(state && !state.finished && closeOwnPage) await closeOwnPage().catch(()=>{});
    socket?.close();state?.detach();server.closeAllConnections();server.close();
    for(const file of ['smoke.log','cef.log']) if(fs.existsSync(path.join(data,file))) fs.copyFileSync(path.join(data,file),path.join(output,file));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
