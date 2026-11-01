const fs=require('node:fs'),path=require('node:path');
const {hashFile}=require('./benchmark-file-hash.cjs');
const files=['run-resource-comparison.cjs','resource-samples.cjs','sample-browser-resources.ps1','diagnose-media.cjs','comparison-kit-launcher.cjs','benchmark-file-hash.cjs','run-browser-comparison.cjs','probe-video-sustained.cjs','probe-game-sustained.cjs','summarize-game-frames.cjs','summarize-video-frames.cjs','webrtc-pilot-page.cjs','game-frame-collector.js','comparison-preflight.ps1'];
function build(output){
 const root=path.resolve(__dirname,'..'),dest=path.resolve(output);
 if(!dest.startsWith(path.join(root,'.local')+path.sep))throw Error('Output must be inside workspace .local');
 if(fs.existsSync(dest))throw Error('Output already exists; preserve old reports and choose new directory');
 const kit=path.resolve(dest,'../comparison-kit-20261024');
 if(!fs.existsSync(path.join(kit,'kit-manifest.json'))||!fs.existsSync(path.join(kit,'tools/node.exe')))throw Error('Sibling sealed browser kit required');
 fs.mkdirSync(path.join(dest,'scripts'),{recursive:true});
 for(const name of files)fs.copyFileSync(path.join(__dirname,name),path.join(dest,'scripts',name));
 fs.copyFileSync(path.join(root,'docs/RESOURCE_COMPARISON.md'),path.join(dest,'README-RU.md'));
 fs.writeFileSync(path.join(dest,'START-RESOURCES.cmd'),'@echo off\r\ncd /d "%~dp0"\r\n"..\\comparison-kit-20261024\\tools\\node.exe" "scripts\\run-resource-comparison.cjs" %*\r\nset "result=%errorlevel%"\r\necho.\r\necho Result code: %result%\r\npause\r\nexit /b %result%\r\n');
 const manifest={createdUtc:new Date().toISOString(),browserKitManifestSha256:hashFile(path.join(kit,'kit-manifest.json')),files:{}};
 for(const name of [...files.map(n=>'scripts/'+n),'START-RESOURCES.cmd','README-RU.md'])manifest.files[name]=hashFile(path.join(dest,name));
 fs.writeFileSync(path.join(dest,'resource-kit-manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(require.main===module){try{const out=process.argv[2]||path.resolve(__dirname,'../.local/resource-comparison-ready-20261024');const manifest=build(out);console.log('Packaged '+Object.keys(manifest.files).length+' files: '+out);}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build,files};
