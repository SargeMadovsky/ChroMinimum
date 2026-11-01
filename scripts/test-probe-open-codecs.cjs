const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('open-codecs CLI reports spawn failure and closes its local HTTP server',()=>{
 const root=fs.mkdtempSync(path.resolve('.local/open-codecs-cli-refusal-'));
 const fixtures=path.join(root,'fixtures');fs.mkdirSync(fixtures);
 for(const file of ['bear-av1.webm','bear-vp9-opus.webm'])fs.writeFileSync(path.join(fixtures,file),'Not read by any browser in this refusal case');
 const child=spawnSync(process.execPath,[path.resolve('scripts/probe-open-codecs.cjs'),path.join(root,'missing-browser.exe'),fixtures,path.join(root,'report')],{encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(child.error,undefined,'Runner must not remain alive on its HTTP server after spawn failure');
 assert.equal(child.status,1);assert.match(child.stderr,/ENOENT|Browser exited/);
 assert.ok(fs.existsSync(path.join(root,'report/launch.json')));
});
