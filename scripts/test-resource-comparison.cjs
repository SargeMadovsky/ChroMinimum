const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeResources}=require('./resource-samples.cjs');
const {aggregate,validState,order}=require('./run-resource-comparison.cjs');
function fixture(){return Array.from({length:35},(_,i)=>({at:i*1000,elapsedMs:i*1000,logicalProcessors:16,samplerCpuSeconds:i*.01,samplerPrivateBytes:20,sampleCostMs:4,rows:[{pid:1,created:'A',cpuSeconds:i*.5,privateBytes:100,workingSetBytes:150},{pid:2,created:'B',cpuSeconds:i*.25,privateBytes:200,workingSetBytes:300}]}));}
test('resource totals, CPU normalization and observer exclusion',()=>{
 const r=summarizeResources(fixture(),0,34000);assert.equal(r.valid,true);assert.equal(r.privateBytesMedian,300);assert.equal(r.workingSetBytesMedian,450);assert.equal(r.cpuPercentOneCore,75);assert.equal(r.cpuPercentMachine,75/16);assert.ok(Math.abs(r.samplerCpuPercentOneCore-1)<1e-9);assert.equal(r.samples,31);
});
test('PID reuse, process disappearance, missing samples and sampling stalls reject',()=>{
 for(const mutate of [xs=>{xs[10].rows[0].created='new';},xs=>{xs[10].rows.pop();},xs=>{xs[10].rows=[];},xs=>{xs[10].elapsedMs+=3000;},xs=>{xs[10].rows[0].cpuSeconds=NaN;}]){const xs=fixture();mutate(xs);assert.equal(summarizeResources(xs,0,34000).valid,false);}
 assert.equal(summarizeResources(fixture().slice(0,3),0,34000).valid,false);
 assert.equal(summarizeResources(fixture(),undefined,undefined).valid,false);
});
test('comparison aggregates preserve rejected counts and report spread',()=>{
 const rows=[{name:'CM',scenario:'startup',valid:true,behavior:{readyMs:100}},{name:'CM',scenario:'startup',valid:true,behavior:{readyMs:200}},{name:'CM',scenario:'startup',valid:false,behavior:{readyMs:5000}}];
 const r=aggregate(rows).startup.CM;assert.equal(r.attempts,3);assert.equal(r.accepted,2);assert.equal(r.metrics.readyMs.median,150);assert.equal(r.metrics.readyMs.max,200);
 rows.push({name:'UC',scenario:'startup',valid:true,behavior:{readyMs:300}});assert.equal(aggregate(rows).startup.cmVersus.UC.readyMs.percentSaving,50);
});
test('retained CPU ledger counts newly born processes and final CPU after exit',()=>{
 const xs=fixture();for(const x of xs)x.cpuLedger=x.rows.map(p=>({...p,bornElapsedMs:-1000}));
 for(let i=10;i<xs.length;i++)xs[i].cpuLedger.push({pid:3,created:'C',bornElapsedMs:9500,cpuSeconds:i===10?.2:.5});
 const r=summarizeResources(xs,0,34000);assert.equal(r.valid,true);assert.equal(r.cpuSeconds,23);
 xs[12].cpuLedger.pop();assert.equal(summarizeResources(xs,0,34000).valid,false);
});
test('visibility, focus and geometry are required; browser order rotates',()=>{
 const state={focused:true,visibility:'visible',width:1000,height:600,dpr:1,scale:1,fullyVisible:true};assert.equal(validState(state),true);
 for(const delta of [{focused:false},{fullyVisible:false},{scale:1.25}])assert.equal(validState({...state,...delta}),false);
 assert.deepEqual(order(0),['CM','UC','Chrome']);assert.deepEqual(order(1),['UC','Chrome','CM']);assert.deepEqual(order(2),['Chrome','CM','UC']);
});
