// Pin official example and its static imports for offline loopback tests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
 const output=path.resolve(process.argv[2]||'.local/product-validation-20261024/game-fixture');
 if(fs.existsSync(output))throw Error('Output already exists');
 const response=await fetch('https://api.github.com/repos/mrdoob/three.js/commits/dev',{headers:{'User-Agent':'ChroMinimum-local-fixture'},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('Commit lookup '+response.status);
 const commit=(await response.json()).sha;if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid commit');
 fs.mkdirSync(output,{recursive:false});
 const queue=['LICENSE','examples/games_fps.html','examples/main.css','examples/models/gltf/collision-world.glb'];
 const imports=['examples/jsm/libs/stats.module.js','examples/jsm/loaders/GLTFLoader.js','examples/jsm/math/Octree.js','examples/jsm/helpers/OctreeHelper.js','examples/jsm/math/Capsule.js','examples/jsm/libs/lil-gui.module.min.js','build/three.module.js'];queue.push(...imports);
 const files={};
 for(let i=0;i<queue.length;i++){
  const name=queue[i];if(files[name])continue;
  if(name.startsWith('../')||path.posix.isAbsolute(name))throw Error('Path escaped repository');
  const url='https://raw.githubusercontent.com/mrdoob/three.js/'+commit+'/'+name;
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(name+': '+r.status);
  const data=Buffer.from(await r.arrayBuffer());const target=path.join(output,...name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);
  files[name]={bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),url};
  if(name.endsWith('.js'))for(const match of data.toString().matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]\s*;/g)){
   const spec=match[1];let dependency;
   if(spec==='three')dependency='build/three.module.js';
   else if(spec.startsWith('three/addons/'))dependency='examples/jsm/'+spec.slice(13);
   else if(spec.startsWith('.'))dependency=path.posix.normalize(path.posix.join(path.posix.dirname(name),spec));
   else throw Error('Unresolved bare import '+spec+' in '+name);
   if(!queue.includes(dependency))queue.push(dependency);
  }
 }
 const glb=fs.readFileSync(path.join(output,'examples/models/gltf/collision-world.glb'));
 const json=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString());
 if([...(json.images||[]),...(json.buffers||[])].some(x=>x.uri&&!x.uri.startsWith('data:')))throw Error('External model resources need explicit pinning');
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({repository:'mrdoob/three.js',commit,files,license:'Upstream LICENSE included; model redistribution needs separate review before portable export'},null,2));
 console.log(JSON.stringify({commit,files:Object.keys(files).length,bytes:Object.values(files).reduce((n,x)=>n+x.bytes,0)},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
