// Isolated graphics compatibility pilot, not a browser performance benchmark.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {observeChild, waitForExit} = require('./diagnose-media.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
<defs><linearGradient id="g"><stop stop-color="#187a96"/><stop offset="1" stop-color="#794bba"/></linearGradient></defs>
<rect width="800" height="480" fill="#f3f5fa"/><rect x="40" y="40" width="720" height="250" rx="25" fill="url(#g)"/>
<circle cx="310" cy="165" r="82" fill="#fff" opacity=".65"/><path d="M440 220 L510 90 L580 220Z" fill="#f9d55b"/>
<rect id="marker" x="40" y="300" width="30" height="12" fill="#dc3760"><animate attributeName="x" values="40;600;40" dur="2s" repeatCount="indefinite"/></rect>
<text id="label" x="40" y="350" font-family="Segoe UI, sans-serif" font-size="32">SVG: ChroMinimum — векторная графика</text>
<text x="40" y="405" font-family="Segoe UI, sans-serif" font-size="22">Текст · градиент · прозрачность · геометрия</text></svg>`;
const fixture = `<!doctype html><meta charset="utf-8"><title>Graphics compatibility fixture</title>
<h1>WebGL 2 graphics pilot</h1><canvas id="graphics" width="320" height="240"></canvas>
<script>
const canvas=document.querySelector('canvas'), gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});
const state=window.graphicsProbe={webgl2:!!gl,frames:0,lost:0,error:null,pixel:null};
canvas.addEventListener('webglcontextlost',()=>state.lost++);
if(gl) {try {
 function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
 const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 a[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));gl_Position=vec4(a[gl_VertexID],0.,1.);}'));
 gl.attachShader(p,shader(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;out vec4 c;void main(){c=vec4(.1,.65,.9,1.);}'));
 gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));gl.useProgram(p);
 const info=gl.getExtension('WEBGL_debug_renderer_info');state.renderer=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
 state.vendor=info?gl.getParameter(info.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR);
 function draw(){gl.drawArrays(gl.TRIANGLES,0,3);state.frames++;if(state.frames===1){const a=new Uint8Array(4);gl.readPixels(160,120,1,1,gl.RGBA,gl.UNSIGNED_BYTE,a);state.pixel=[...a];state.glError=gl.getError();}requestAnimationFrame(draw);}draw();
}catch(e){state.error=e.message;}}
</script>`;

async function main() {
  const pdf = process.argv.includes('--pdf');
  const pdfExtended = process.argv.includes('--pdf-extended');
  const args = process.argv.slice(2).filter(arg=>!['--pdf','--pdf-extended'].includes(arg));
  if(pdfExtended&&!pdf)throw Error('--pdf-extended requires --pdf');
  if (args.length < 2 || args.length > 3) throw Error('Usage: node probe-browser-graphics.cjs <runtime-exe> <new-report> [game-url | --pdf [--pdf-extended]]');
  const exe = path.resolve(args[0]), report = path.resolve(args[1]), game = args[2];
  if(pdf&&game)throw Error('--pdf cannot be combined with game-url');
  fs.mkdirSync(report, {recursive:false});
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-graphics-'));
  fs.writeFileSync(path.join(report, 'launch.json'), JSON.stringify({exe, disposableData:data, game:game || null}, null, 2));
  fs.writeFileSync(path.join(report, 'fixture.svg'), svg);
  fs.writeFileSync(path.join(report, 'fixture.html'), fixture);
  const pdfBytes = pdf ? fs.readFileSync(path.join(__dirname,pdfExtended?'../tests/fixtures/validation-three-pages.pdf':'../tests/fixtures/smoke.pdf')) : null;
  if(pdf)fs.writeFileSync(path.join(report,'fixture.pdf'),pdfBytes);
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push(name);
    if(pdf&&name==='/fixture.pdf'){res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':pdfBytes.length});res.end(pdfBytes);return;}
    res.writeHead(name === '/' || name === '/fixture.svg' ? 200 : 404,
      {'Content-Type':name === '/fixture.svg' ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8'});
    res.end(name === '/fixture.svg' ? svg : name === '/' ? fixture : '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = game || `http://127.0.0.1:${server.address().port}/`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CHROMINIMUM_')));
  env.CHROMINIMUM_DATA_DIR = data;
  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--url=' + url], {env, windowsHide:true, stdio:'ignore'});
  const state = observeChild(child);
  let ws;
  const watchdog = setTimeout(() => {child.unref(); server.closeAllConnections(); server.close(); ws?.close(); process.exit(1);}, 95000);
  try {
    const portFile = path.join(data, 'profile-smoke', 'DevToolsActivePort');
    for (let i=0; !fs.existsSync(portFile) && i<150; i++) {if(state.finished)throw Error('Browser exited before CDP');await delay(100);}
    if (!fs.existsSync(portFile)) throw Error('No CDP port');
    const log = path.join(data, 'smoke.log');
    for (let i=0; i<120; i++) {
      if (fs.existsSync(log) && fs.readFileSync(log,'utf8').includes('main_frame_loaded; status=200')) break;
      await delay(100);
    }
    const port = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const tab = tabs.find(t=>t.type==='page' && t.url===url) || tabs.find(t=>t.type==='page');
    if (!tab) throw Error('No page target');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let serial=0;const pending=new Map(), exceptions=[], scripts=[], paused=[];
    ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params);
      if(m.method==='Debugger.scriptParsed')scripts.push(m.params);
      if(m.method==='Debugger.paused')paused.push(m.params);
      const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},8000);
      pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params,sessionId}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await call('Runtime.enable');await call('Page.enable');
    if (pdf) {
      const observations=[];
      for(const [mode,target] of [['http',`http://127.0.0.1:${server.address().port}/fixture.pdf`],['file',pathToFileURL(path.join(report,'fixture.pdf')).href]]) {
        await call('Page.navigate',{url:target});
        let documentState;
        for(let i=0;i<50;i++) {
          documentState=await evaluate(`({href:location.href,ready:document.readyState,contentType:document.contentType,
            embed:[...document.querySelectorAll('embed')].map(e=>({type:e.type,src:e.src})),
            iframe:[...document.querySelectorAll('iframe')].map(e=>({src:e.src}))})`);
          if(documentState.href===target&&documentState.ready==='complete')break;
          await delay(100);
        }
        await delay(1500);
        if(pdfExtended) {
          const targets=await call('Target.getTargets');
          fs.writeFileSync(path.join(report,'pdf-targets-'+mode+'.json'),JSON.stringify(targets,null,2));
          for(const targetInfo of targets.targetInfos.filter(t=>t.type==='iframe'&&t.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))) {
            const attached=await call('Target.attachToTarget',{targetId:targetInfo.targetId,flatten:true});
            try {
              const innerEval=async expression=>{
                const r=await call('Runtime.evaluate',{expression,returnByValue:true},attached.sessionId);
                if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
              };
              const snapshot=()=>innerEval(`(()=>{const v=document.querySelector('pdf-viewer'),t=v.shadowRoot.querySelector('viewer-toolbar'),p=t.shadowRoot.querySelector('viewer-page-selector');return {page:p.pageNo,pages:p.docLength,zoom:t.shadowRoot.querySelector('#zoom-controls input').value,viewportZoom:v.viewport.getZoom()};})()`);
              const controls={before:await snapshot(),input:'DOM change events on actual toolbar inputs; physical keyboard untested'};
              await innerEval(`(()=>{const t=document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar'),p=t.shadowRoot.querySelector('viewer-page-selector').shadowRoot.querySelector('input');p.value='3';p.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
              await delay(400);controls.page3=await snapshot();
              await innerEval(`(()=>{const t=document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar'),z=t.shadowRoot.querySelector('#zoom-controls input');z.value='150%';z.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
              await delay(400);controls.zoom150=await snapshot();
              const shot=await call('Page.captureScreenshot',{format:'png'});
              fs.writeFileSync(path.join(report,'pdf-page3-150-'+mode+'.png'),Buffer.from(shot.data,'base64'));
              await innerEval(`(()=>{const t=document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar'),p=t.shadowRoot.querySelector('viewer-page-selector').shadowRoot.querySelector('input');p.value='1';p.dispatchEvent(new Event('change',{bubbles:true}));const z=t.shadowRoot.querySelector('#zoom-controls input');z.value='100%';z.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
              await delay(300);controls.restored=await snapshot();
              fs.writeFileSync(path.join(report,'pdf-controls-'+mode+'.json'),JSON.stringify(controls,null,2));
              if(controls.before.pages!==3||controls.page3.page!==3||Math.abs(controls.zoom150.viewportZoom-1.5)>.01||controls.restored.page!==1||Math.abs(controls.restored.viewportZoom-1)>.01)throw Error('PDF toolbar navigation/zoom failed');
              if(mode==='http') {
                await call('Page.bringToFront');
                await call('Input.dispatchKeyEvent',{type:'keyDown',key:'f',code:'KeyF',windowsVirtualKeyCode:70,modifiers:2});
                await call('Input.dispatchKeyEvent',{type:'keyUp',key:'f',code:'KeyF',windowsVirtualKeyCode:70,modifiers:2});
                await call('Input.insertText',{text:'NEBULA'});
                await delay(600);
                const searchShot=await call('Page.captureScreenshot',{format:'png'});
                fs.writeFileSync(path.join(report,'pdf-search-cdp.png'),Buffer.from(searchShot.data,'base64'));
                fs.writeFileSync(path.join(report,'pdf-search-cdp.json'),JSON.stringify({after:await snapshot(),scope:'CDP Ctrl+F and insertText; screenshot requires review; not an asserted search pass'},null,2));
                await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
                await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
              }
            } finally {await call('Target.detachFromTarget',{sessionId:attached.sessionId});}
          }
          if(!targets.targetInfos.some(t=>t.type==='iframe'&&t.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')))throw Error('PDF viewer target missing');
          const tree=await call('DOM.getDocument',{depth:-1,pierce:true});
          fs.writeFileSync(path.join(report,'pdf-dom-'+mode+'.json'),JSON.stringify(tree,null,2));
          const contexts=await evaluate(`({html:document.documentElement.outerHTML.slice(0,16000), globals:Object.keys(window).filter(k=>/pdf|viewer/i.test(k))})`);
          fs.writeFileSync(path.join(report,'pdf-context-'+mode+'.json'),JSON.stringify(contexts,null,2));
        }
        const screenshot=await call('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(report,'pdf-'+mode+'.png'),Buffer.from(screenshot.data,'base64'));
        observations.push({mode,target,documentState});
        fs.writeFileSync(path.join(report,'pdf.json'),JSON.stringify(observations,null,2));
        if(documentState.href!==target||documentState.ready!=='complete')throw Error('PDF navigation incomplete');
      }
    } else if (!game) {
      await delay(1000);
      const first=await evaluate('({...window.graphicsProbe,href:location.href,visible:document.visibilityState})');
      await delay(1000);const second=await evaluate('({...window.graphicsProbe})');
      fs.writeFileSync(path.join(report,'webgl.json'),JSON.stringify({first,second},null,2));
      if(!second.webgl2 || second.error || second.glError!==0 || second.lost || !(second.frames>first.frames) ||
         !second.pixel || Math.abs(second.pixel[1]-166)>2)throw Error('WebGL drawing check failed');
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/fixture.svg`});
      let svgState;
      for(let i=0;i<50;i++){svgState=await evaluate(`(()=>{const t=document.querySelector('#label');return {svg:document.documentElement.localName==='svg',text:t?.textContent,bounds:t?{width:t.getBBox().width,height:t.getBBox().height}:null,viewBox:document.documentElement.getAttribute('viewBox')};})()`);if(svgState.svg&&svgState.bounds?.width>0)break;await delay(100);}
      fs.writeFileSync(path.join(report,'svg.json'),JSON.stringify(svgState,null,2));
      if(!svgState.svg||!svgState.bounds?.width)throw Error('SVG document check failed');
      const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(report,'svg.png'),Buffer.from(shot.data,'base64'));
      const fileUrl=pathToFileURL(path.join(report,'fixture.svg')).href;
      await call('Page.navigate',{url:fileUrl});
      let local;
      for(let i=0;i<50;i++){local=await evaluate(`({href:location.href,svg:document.documentElement.localName==='svg'})`);if(local.href===fileUrl&&local.svg)break;await delay(100);}
      if(local.href!==fileUrl||!local.svg)throw Error('Local SVG did not open');
      const scaling=await evaluate(`(()=>{const s=document.documentElement,t=document.querySelector('#label');
        const before={scale:s.getScreenCTM().a,textWidth:t.getBoundingClientRect().width};
        s.style.width='1200px';s.style.height='720px';
        const after={scale:s.getScreenCTM().a,textWidth:t.getBoundingClientRect().width};return {before,after};})()`);
      const animation=await evaluate(`(()=>{const s=document.documentElement,m=document.querySelector('#marker');
        s.pauseAnimations();s.setCurrentTime(.25);const first=m.x.animVal.value;
        s.setCurrentTime(1);const second=m.x.animVal.value;const time=s.getCurrentTime();s.unpauseAnimations();return {first,second,time};})()`);
      await delay(300);
      animation.after=await evaluate(`({time:document.documentElement.getCurrentTime(),x:document.querySelector('#marker').x.animVal.value})`);
      await call('Emulation.setPageScaleFactor',{pageScaleFactor:2});
      const pageScale=await evaluate('visualViewport.scale');
      const extended={local,scaling,animation,pageScale};
      fs.writeFileSync(path.join(report,'svg-extended.json'),JSON.stringify(extended,null,2));
      const zoomShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(report,'svg-scaled.png'),Buffer.from(zoomShot.data,'base64'));
      if(Math.abs(scaling.after.scale/scaling.before.scale-1.5)>.01||Math.abs(scaling.after.textWidth/scaling.before.textWidth-1.5)>.01||
         Math.abs(animation.second-animation.first)<100||!(animation.after.time>animation.time)||pageScale<1.9)throw Error('SVG scale/animation check failed');
    } else {
      let page;
      for(let i=0;i<60;i++){page=await evaluate(`({href:location.href,title:document.title,ready:document.readyState,canvas:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),visible:document.visibilityState})`);if(page.canvas.some(c=>c.width>0))break;await delay(100);}
      await delay(1000);
      const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(report,'game.png'),Buffer.from(shot.data,'base64'));
      fs.writeFileSync(path.join(report,'game.json'),JSON.stringify({page,exceptions,resources:await evaluate('performance.getEntriesByType("resource").map(r=>({name:r.name,duration:r.duration,bytes:r.transferSize}))')},null,2));
      if(!page.canvas.length)throw Error('No game canvas');
      // Expose read-only observations of the real module-local camera. The
      // breakpoint is removed before input; no game update/control is replaced.
      await call('Debugger.enable');
      const moduleScript=scripts.find(s=>s.url===game && s.isModule);
      if(!moduleScript)throw Error('Game module script not found');
      const source=await call('Debugger.getScriptSource',{scriptId:moduleScript.scriptId});
      const lines=source.scriptSource.split('\n');
      const line=lines.findIndex(line=>/renderer\.render\(\s*scene,\s*camera\s*\)/.test(line));
      if(line<0)throw Error('Expected render call not found; example changed');
      const bp=await call('Debugger.setBreakpoint',{location:{scriptId:moduleScript.scriptId,lineNumber:line+moduleScript.startLine}});
      for(let i=0;!paused.length&&i<30;i++)await delay(100);
      if(!paused.length)throw Error('Camera observation breakpoint not reached');
      try {
        const observed=await call('Debugger.evaluateOnCallFrame',{callFrameId:paused[0].callFrames[0].callFrameId,
          expression:'window.__graphicsGameObservation={camera,renderer,get floor(){return playerOnFloor;}};true',returnByValue:true});
        if(observed.exceptionDetails)throw Error('Cannot observe game camera');
      } finally {await call('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await call('Debugger.resume');await call('Debugger.disable');}
      const snapshot=()=>evaluate(`(()=>{const p=window.__graphicsGameObservation;return {position:p.camera.position.toArray(),rotation:p.camera.rotation.toArray().slice(0,3),floor:p.floor,lock:document.pointerLockElement===document.body,focused:document.hasFocus()};})()`);
      const controls={};
      try {
        await call('Page.bringToFront');
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:400,y:300});
        await call('Input.dispatchMouseEvent',{type:'mousePressed',x:400,y:300,button:'left',clickCount:1});
        await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:400,y:300,button:'left',clickCount:1});
        await delay(150);controls.initial=await snapshot();
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
        await delay(400);
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
        controls.afterMove=await snapshot();
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:450,y:320});
        await delay(100);controls.afterLook=await snapshot();
        await delay(500);controls.beforeJump=await snapshot();
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
        await delay(120);
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
        controls.afterJump=await snapshot();
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await delay(100);controls.afterEscape=await snapshot();
        controls.escapeViaCdpReleased=!controls.afterEscape.lock;
        controls.physicalEscapeTested=false;
      } finally {
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
        await evaluate('document.exitPointerLock();true');
        controls.released=await evaluate('document.pointerLockElement===null');
        fs.writeFileSync(path.join(report,'game-controls.json'),JSON.stringify(controls,null,2));
      }
      const moved=Math.hypot(controls.afterMove.position[0]-controls.initial.position[0],controls.afterMove.position[2]-controls.initial.position[2]);
      const turned=Math.abs(controls.afterLook.rotation[1]-controls.afterMove.rotation[1]);
      if(!controls.initial.lock||moved<.05||turned<.01||!controls.beforeJump.floor||
         controls.afterJump.position[1]<=controls.beforeJump.position[1]+.05||!controls.released)throw Error('Game input check failed; inspect camera observations');
      const movedShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(report,'game-after-input.png'),Buffer.from(movedShot.data,'base64'));
    }
    ws.close();ws=null;
    const exit=await waitForExit(state,45000);
    if(exit!==0)throw Error('Unclean exit '+exit);
    const smoke=fs.readFileSync(log,'utf8');if(!smoke.split(/\r?\n/).includes('shutdown_complete'))throw Error('Missing shutdown');
    fs.writeFileSync(path.join(report,'result.json'),JSON.stringify({passed:true,scope:pdf?(pdfExtended?'HTTP/file three-page PDF, toolbar DOM page/zoom events; search and physical input untested':'HTTP/file PDF navigation and screenshots; visual review required'):game?'camera movement/look/jump, pointer lock and API release; physical Escape untested':'WebGL2 draw, HTTP/file SVG, vector/page scaling and SMIL animation',exit,profileOnSystemTemp:true},null,2));
    console.log('graphics pilot passed; clean shutdown');
  } finally {
    clearTimeout(watchdog);ws?.close();server.closeAllConnections();server.close();child.unref();
    for(const name of ['smoke.log','cef.log'])if(fs.existsSync(path.join(data,name)))fs.copyFileSync(path.join(data,name),path.join(report,name));
    fs.writeFileSync(path.join(report,'requests.json'),JSON.stringify(requests,null,2));
  }
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
