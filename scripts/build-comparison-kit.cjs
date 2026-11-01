const fs=require('node:fs'),path=require('node:path');
const {loadInputs}=require('./run-browser-comparison.cjs'),{hashFile}=require('./benchmark-file-hash.cjs');
const FORBIDDEN=new Set(['default','user data','profile','profile-smoke','local state','cookies','login data','history','crashpad','crash reports','gpucache']);
function copyTree(source,destination){
 fs.mkdirSync(destination,{recursive:true});
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw Error('Refuse linked source '+entry.name);
  if(FORBIDDEN.has(entry.name.toLowerCase()))throw Error('Refuse profile/cache entry '+entry.name);
  if(entry.name==='First Run'||entry.name.endsWith('.log'))continue;
  const from=path.join(source,entry.name),to=path.join(destination,entry.name);
  if(entry.isDirectory())copyTree(from,to);else if(entry.isFile())fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
 }
}
async function main(){
 const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'.local/comparison-kit-20261024'));
 if(fs.existsSync(output))throw Error('Output exists; do not overwrite a kit');
 if(!output.startsWith(root+path.sep))throw Error('Build inside this workspace');
 const inputs=loadInputs(path.join(__dirname,'browser-comparison.config.json'));
 const cmManifest=JSON.parse(fs.readFileSync(path.join(root,'.local/product-validation-20261024/runtime-manifest.json'),'utf8'));
 for(const [name,entry] of Object.entries(cmManifest.files))if(hashFile(path.join(path.dirname(inputs.browsers.CM.exe.path),name))!==entry.sha256)throw Error('Frozen CM changed '+name);
 const licenseUrl='https://raw.githubusercontent.com/nodejs/node/'+process.version+'/LICENSE';
 const response=await fetch(licenseUrl,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Node LICENSE download: '+response.status);const license=await response.text();if(!license.includes('Node.js'))throw Error('Unexpected Node license');
 fs.mkdirSync(output,{recursive:false});
 const config={schema:1,root:'..',readiness:'private portable comparison; documented scenario limitations',fixture:null,browsers:{},game:null};
 const entry=name=>({path:name.replaceAll(path.sep,'/'),sha256:hashFile(path.join(output,name))});
 for(const name of ['CM','UC','Chrome']){
  console.log('Copying '+name+'…');const browser=inputs.browsers[name],source=path.dirname(browser.exe.path),dest=path.join(output,'browsers',name);copyTree(source,dest);
  config.browsers[name]={exe:entry(path.join('browsers',name,path.basename(browser.exe.path))),engine:entry(path.join('browsers',name,path.relative(source,browser.engine.path))),fileVersion:browser.fileVersion};
 }
 fs.mkdirSync(path.join(output,'fixtures'),{recursive:true});fs.copyFileSync(inputs.fixture.path,path.join(output,'fixtures/video.mp4'));config.fixture=entry('fixtures/video.mp4');
 copyTree(path.dirname(inputs.game.path),path.join(output,'fixtures/game'));config.game=entry('fixtures/game/manifest.json');
 fs.mkdirSync(path.join(output,'tools'));fs.copyFileSync(process.execPath,path.join(output,'tools/node.exe'));fs.writeFileSync(path.join(output,'tools/NODE-LICENSE.txt'),license);
 const scripts=['comparison-kit-launcher.cjs','benchmark-file-hash.cjs','run-browser-comparison.cjs','comparison-preflight.ps1','probe-video-sustained.cjs','webrtc-pilot-page.cjs','summarize-video-frames.cjs','probe-game-sustained.cjs','game-frame-collector.js','summarize-game-frames.cjs','diagnose-media.cjs'];
 fs.mkdirSync(path.join(output,'scripts'));for(const name of scripts)fs.copyFileSync(path.join(__dirname,name),path.join(output,'scripts',name));
 fs.writeFileSync(path.join(output,'scripts/browser-comparison.config.json'),JSON.stringify(config,null,2));
 fs.writeFileSync(path.join(output,'START.cmd'),'@echo off\r\nsetlocal\r\n"%~dp0tools\\node.exe" "%~dp0scripts\\comparison-kit-launcher.cjs" %*\r\nset "comparison_exit=%errorlevel%"\r\necho Exit code: %comparison_exit%\r\nif "%~1"=="" pause\r\nexit /b %comparison_exit%\r\n');
 fs.writeFileSync(path.join(output,'README-RU.txt'),fs.readFileSync(path.join(root,'docs/COMPARISON_KIT_INSTRUCTIONS.txt')));
 const files={};function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else{const rel=path.relative(output,p).replaceAll(path.sep,'/');files[rel]={bytes:fs.statSync(p).size,sha256:hashFile(p)};}}}console.log('Hashing packaged files…');scan(output);
 fs.writeFileSync(path.join(output,'kit-manifest.json'),JSON.stringify({schema:1,createdUtc:new Date().toISOString(),node:process.version,nodeLicenseSource:licenseUrl,privateLocalUse:true,files},null,2));
 console.log(JSON.stringify({output,files:Object.keys(files).length,bytes:Object.values(files).reduce((n,x)=>n+x.bytes,0)},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});module.exports={copyTree};
