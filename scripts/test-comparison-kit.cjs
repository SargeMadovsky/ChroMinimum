const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {hashFile}=require('./benchmark-file-hash.cjs'),{verifyKit}=require('./comparison-kit-launcher.cjs'),{copyTree}=require('./build-comparison-kit.cjs');
test('streaming hash covers empty input and a chunk boundary',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-kit-hash-'));
 try{for(const data of [Buffer.alloc(0),Buffer.alloc(1024*1024+7,123)]){const p=path.join(dir,'file');fs.writeFileSync(p,data);assert.equal(hashFile(p),crypto.createHash('sha256').update(data).digest('hex'));}}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('kit verifier rejects changed files and paths outside the kit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-kit-verify-'));
 try{const p=path.join(dir,'file');fs.writeFileSync(p,'pinned');const manifest={files:{file:{sha256:hashFile(p)}}};fs.writeFileSync(path.join(dir,'kit-manifest.json'),JSON.stringify(manifest));verifyKit(dir);fs.writeFileSync(p,'tampered');assert.throws(()=>verifyKit(dir),/mismatch/);manifest.files={'../escape':{sha256:'0'.repeat(64)}};fs.writeFileSync(path.join(dir,'kit-manifest.json'),JSON.stringify(manifest));assert.throws(()=>verifyKit(dir),/escaped/);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('packaging refuses profile data rather than copying it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-kit-profile-'));
 try{const source=path.join(dir,'source'),target=path.join(dir,'target');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'Login Data'),'must not copy');assert.throws(()=>copyTree(source,target),/profile\/cache/);assert.equal(fs.existsSync(path.join(target,'Login Data')),false);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
