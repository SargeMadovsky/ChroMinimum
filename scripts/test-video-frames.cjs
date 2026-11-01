const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeVideoFrames}=require('./summarize-video-frames.cjs');
function fixture(){return {events:[],frameMetrics:{supported:true,samples:[0,1000,2000].map((now,i)=>({now,mediaTime:i,focused:true,visibility:'visible'})),firstQuality:{totalVideoFrames:10,droppedVideoFrames:1},lastQuality:{totalVideoFrames:70,droppedVideoFrames:4}}};}
test('counter deltas exclude prior drops and report callback percentiles',()=>{const r=summarizeVideoFrames(fixture(),2);assert.equal(r.valid,true);assert.equal(r.deltaDropped,3);assert.equal(r.droppedFraction,.05);assert.equal(r.callbackIntervalMs.p99,1000);});
test('short smoke cannot become a 60-second acceptance result',()=>assert.equal(summarizeVideoFrames(fixture()).valid,false));
test('transient focus loss invalidates even after recovery',()=>{const f=fixture();f.events=[{type:'blur',visibility:'visible',focused:false}];assert.ok(summarizeVideoFrames(f,2).reasons.includes('visibility or focus interrupted'));});
test('counter reset and nonmonotonic media timeline rejected',()=>{const f=fixture();f.frameMetrics.lastQuality.totalVideoFrames=2;f.frameMetrics.samples[2].mediaTime=0;const r=summarizeVideoFrames(f,2);assert.ok(r.reasons.includes('invalid quality counters'));assert.ok(r.reasons.includes('nonmonotonic callback timeline'));});
test('normal EOF pause allowed, user pause and truncated samples rejected',()=>{const f=fixture();f.events=[{type:'pause',ended:true,visibility:'visible',focused:true}];assert.equal(summarizeVideoFrames(f,2).valid,true);f.events[0].ended=false;f.frameMetrics.truncated=true;assert.equal(summarizeVideoFrames(f,2).valid,false);});
test('resize invalidates comparison window',()=>{const f=fixture();f.events=[{type:'resize',visibility:'visible',focused:true}];assert.ok(summarizeVideoFrames(f,2).reasons.includes('viewport resized'));});
test('embedded sustained-page script parses and timeout cannot pass',()=>{const {page,summarizeSustained}=require('./probe-video-sustained.cjs');const {Script}=require('node:vm');new Script(page.split('<script>')[1].split('</script>')[0]);const f=fixture();f.frameMetrics.samples[2].now=60000;f.reason='timeout';const r=summarizeSustained(f);assert.equal(r.valid,false);assert.ok(r.reasons.includes('timeout'));assert.equal(r.warmupMediaSeconds,10);});
test('fixed viewport rejects clipping, scaling and missing initial geometry',()=>{
 const {summarizeSustained}=require('./probe-video-sustained.cjs');const f=fixture();f.frameMetrics.samples[2].now=60000;f.reason='measurement-window-complete';
 f.environment={measurementViewport:true,innerWidth:1000,innerHeight:600,dpr:1,visualScale:1,fullyVisible:true};f.startEnvironment={...f.environment};assert.equal(summarizeSustained(f).valid,true);
 f.environment.fullyVisible=false;assert.equal(summarizeSustained(f).valid,false);f.environment.fullyVisible=true;f.environment.dpr=1.25;assert.equal(summarizeSustained(f).valid,false);
 f.environment.dpr=1;delete f.startEnvironment;assert.equal(summarizeSustained(f).valid,false);
});
