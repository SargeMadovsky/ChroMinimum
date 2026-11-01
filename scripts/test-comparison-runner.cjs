const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {schedule,loadInputs,isAcceptedAttempt}=require('./run-browser-comparison.cjs');
test('rotated schedule includes all three browsers in every round',()=>{
 const rows=schedule(5);assert.equal(rows.length,15);
 for(let r=1;r<=5;r++)assert.deepEqual(rows.filter(x=>x.round===r).map(x=>x.browser).sort(),['CM','Chrome','UC']);
 assert.deepEqual(rows.slice(0,3).map(x=>x.browser),['CM','UC','Chrome']);assert.equal(rows[3].browser,'UC');
 assert.throws(()=>schedule(0));assert.throws(()=>schedule(1.5));
});
test('tampered input is rejected before browser launch',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-comparison-unit-'));
 try{fs.writeFileSync(path.join(dir,'fixture'),'expected');const entry={path:'fixture',sha256:crypto.createHash('sha256').update('expected').digest('hex')};
 const config={schema:1,root:'.',fixture:entry,browsers:Object.fromEntries(['CM','UC','Chrome'].map(name=>[name,{exe:entry,engine:entry}]))};
 const p=path.join(dir,'config.json');fs.writeFileSync(p,JSON.stringify(config));assert.equal(loadInputs(p).fixture.path,path.join(dir,'fixture'));
 fs.writeFileSync(path.join(dir,'fixture'),'changed');assert.throws(()=>loadInputs(p),/hash mismatch/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('successful runner exit cannot hide invalid measurement or missing clean shutdown',()=>{
 assert.equal(isAcceptedAttempt({status:0},{valid:true},{exit:0}),true);
 assert.equal(isAcceptedAttempt({status:0},{valid:false},{exit:0}),false);
 assert.equal(isAcceptedAttempt({status:0},null,{exit:0}),false);
 assert.equal(isAcceptedAttempt({status:0},{valid:true},null),false);
 assert.equal(isAcceptedAttempt({status:1},{valid:true},{exit:0}),false);
 assert.equal(isAcceptedAttempt({status:0,error:Error('timeout')},{valid:true},{exit:0}),false);
});
