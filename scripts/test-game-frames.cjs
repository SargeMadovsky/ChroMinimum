const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarizeGameFrames}=require('./summarize-game-frames.cjs');
function sample(){const environment={width:1000,height:600,dpr:1,scale:1,fullyVisible:true};return {reason:'measurement-window-complete',sceneReady:true,environment,startEnvironment:environment,events:[],samples:[0,10,20,60000].map(now=>({now,calls:10,triangles:200,visibility:'visible',focused:true})),errors:[],contextLost:0,glError:0};}
test('real render samples required, percentiles include long frames',()=>{const r=summarizeGameFrames(sample());assert.equal(r.valid,true);assert.equal(r.intervalMs.p99,59980);assert.equal(r.over4Periods,1/3);const f=sample();f.samples[2].calls=0;assert.equal(summarizeGameFrames(f).valid,false);});
test('focus interruption and context loss cannot pass',()=>{const f=sample();f.events=[{type:'blur',visibility:'visible',focused:false}];f.contextLost=1;assert.equal(summarizeGameFrames(f).valid,false);});
test('patch fails closed if pinned upstream anchors change',()=>{assert.throws(()=>require('./probe-game-sustained.cjs').patchExample('<html></html>'),/anchor changed/);});
test('browser collector parses',()=>{new (require('node:vm').Script)(require('node:fs').readFileSync(require('node:path').join(__dirname,'game-frame-collector.js'),'utf8'));});
