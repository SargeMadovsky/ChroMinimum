const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const {observeChild,waitForExit}=require('./diagnose-media.cjs');
const {summarizeGameFrames}=require('./summarize-game-frames.cjs');
function patchExample(source){
 const replace=(a,b)=>{if(source.split(a).length!==2)throw Error('Upstream patch anchor changed: '+a);source=source.replace(a,b);};
 replace('</head>','<script src="/cm-game-measure.js"></script></head>');
 replace('container.appendChild( renderer.domElement );','container.appendChild( renderer.domElement );\nwindow.cmGameMeasurement.attach(renderer,camera);');
 replace('worldOctree.fromGraphNode( gltf.scene );','worldOctree.fromGraphNode( gltf.scene );\nwindow.cmGameMeasurement.ready();');
 replace('renderer.render( scene, camera );','const cmNow=performance.now();\nwindow.cmGameMeasurement.before(cmNow);\nrenderer.render( scene, camera );\nwindow.cmGameMeasurement.after(cmNow,performance.now());');
 return source;
}
async function main(){
 const chromium=process.argv.includes('--chromium');const args=process.argv.slice(2).filter(x=>x!=='--chromium');
 if(args.length!==3)throw Error('Usage: probe-game-sustained.cjs <browser.exe> <pinned-game-directory> <new-report> [--chromium]');
 const [exe,root,report]=args.map(x=>path.resolve(x));const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 const files=new Map();for(const [name,entry] of Object.entries(manifest.files)){
  const p=path.resolve(root,name);if(!p.startsWith(root+path.sep))throw Error('Escaped fixture path');
  const data=fs.readFileSync(p);if(crypto.createHash('sha256').update(data).digest('hex')!==entry.sha256)throw Error('Fixture hash mismatch '+name);files.set('/'+name,data);
 }
 const html=patchExample(files.get('/examples/games_fps.html').toString());files.set('/examples/games_fps.html',Buffer.from(html));
 files.set('/cm-game-measure.js',fs.readFileSync(path.join(__dirname,'game-frame-collector.js')));
 const shell='<!doctype html><meta charset="utf-8"><title>Game measurement — 10s warmup / 60s recording</title><style>html,body{margin:0;background:#17202b}iframe{display:block;width:1000px;height:600px;border:0}</style><iframe title="Game measurement" src="/examples/games_fps.html" onload="this.contentWindow.focus()"></iframe>';
 files.set('/',Buffer.from(shell));fs.mkdirSync(report,{recursive:false});
 fs.writeFileSync(path.join(report,'instrumented-example.html'),html);fs.writeFileSync(path.join(report,'manifest.json'),JSON.stringify(manifest,null,2));
 fs.writeFileSync(path.join(report,'collector.js'),files.get('/cm-game-measure.js'));
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'ChroMinimum-game-long-'));fs.writeFileSync(path.join(report,'launch.json'),JSON.stringify({exe,root,data,chromium,commit:manifest.commit},null,2));
 let resolveReport,reported=false;const received=new Promise(resolve=>resolveReport=resolve),requests=[];
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;requests.push({method:req.method,path:pathname});
  if(pathname==='/report'&&req.method==='POST'){
   if(reported){res.writeHead(409);res.end();return;}let size=0;const chunks=[];
   req.on('data',b=>{size+=b.length;if(size>8*1024*1024){req.destroy();return;}chunks.push(b);});
   req.on('end',()=>{try{const raw=JSON.parse(Buffer.concat(chunks));
    if(raw.canvasPng){const encoded=raw.canvasPng;if(!encoded.startsWith('data:image/png;base64,'))throw Error('Invalid canvas image');fs.writeFileSync(path.join(report,'canvas.png'),Buffer.from(encoded.slice(22),'base64'));delete raw.canvasPng;}
    fs.writeFileSync(path.join(report,'observation.json'),JSON.stringify(raw,null,2));const summary=summarizeGameFrames(raw);
    fs.writeFileSync(path.join(report,'summary.json'),JSON.stringify(summary,null,2));reported=true;res.end('saved');resolveReport(summary);
   }catch(e){res.writeHead(400);res.end('Invalid report');}});return;
  }
  const bytes=files.get(pathname);if(!bytes){res.writeHead(404);res.end();return;}
  const mime=pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.glb')?'model/gltf-binary':'text/html';res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length});res.end(bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('CHROMINIMUM_')));env.CHROMINIMUM_DATA_DIR=data;
 const url='http://127.0.0.1:'+server.address().port+'/';const browserArgs=chromium?['--user-data-dir='+data,'--no-first-run','--no-default-browser-check','--new-window',url]:['--url='+url];
 const child=spawn(exe,browserArgs,{env,stdio:'ignore',windowsHide:true}),state=observeChild(child);let timer;
 try{const summary=await Promise.race([received,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Report timeout')),120000);}),state.done.then(()=>{throw Error('Browser exited before report');})]);clearTimeout(timer);
  await promisify(execFile)('taskkill.exe',['/PID',String(child.pid)],{windowsHide:true,timeout:10000});const exit=await waitForExit(state,15000);
  fs.writeFileSync(path.join(report,'lifecycle.json'),JSON.stringify({exit,reported},null,2));console.log(JSON.stringify(summary,null,2));if(exit!==0||!summary.valid)process.exitCode=1;
 }finally{clearTimeout(timer);if(!state.finished){try{await promisify(execFile)('taskkill.exe',['/PID',String(child.pid)],{windowsHide:true,timeout:10000});await waitForExit(state,15000);}catch(e){fs.writeFileSync(path.join(report,'cleanup-error.json'),JSON.stringify({pid:child.pid,error:e.message}));}}server.closeAllConnections();server.close();child.unref();fs.writeFileSync(path.join(report,'requests.json'),JSON.stringify(requests,null,2));}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});module.exports={patchExample};
