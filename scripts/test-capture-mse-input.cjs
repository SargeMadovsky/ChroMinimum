const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
class BufferMock {
  constructor(){this.mode='segments';this.timestampOffset=0;this.appendWindowStart=0;this.appendWindowEnd=Infinity;this.calls=0;}
  appendBuffer(data){if(data===null)throw Error('original failure');this.calls++;return 42;}
  abort(){} remove(){} changeType(){}
}
class SourceMock {addSourceBuffer(){return new BufferMock();}endOfStream(){}}
const append=BufferMock.prototype.appendBuffer;
const listeners=new Map();
const context=vm.createContext({MediaSource:SourceMock,SourceBuffer:BufferMock,HTMLMediaElement:class{},
 Uint8Array,ArrayBuffer,performance:{now:()=>123},console:{log(){}},btoa:s=>Buffer.from(s,'binary').toString('base64'),
 document:{visibilityState:'visible',addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t)}});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'capture-mse-input.js'),'utf8'),context);
const source=new SourceMock(),sb=source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
const bytes=new Uint8Array([9,1,2,8]);
assert.equal(sb.appendBuffer(bytes.subarray(1,3)),42);
bytes[1]=7;
let exported=JSON.parse(context.cmMseCapture.exportJSON());
assert.equal(exported.operations[1].base64,'AQI=');
assert.equal(exported.operations[1].appendWindowEnd,'Infinity');
assert.equal(exported.operations[1].mime,'audio/mp4; codecs="mp4a.40.2"');
assert.throws(()=>sb.appendBuffer(null),/original failure/);
assert.equal(JSON.parse(context.cmMseCapture.exportJSON()).operations.length,2);
sb.appendBuffer(new Uint8Array(13*1024*1024));
assert.equal(context.cmMseCapture.summary().bytes,2);
assert.equal(context.cmMseCapture.summary().dropped,1);
for(let i=0;i<150;i++)sb.appendBuffer(new Uint8Array([1]));
assert.equal(context.cmMseCapture.summary().operations,128);
assert.ok(context.cmMseCapture.summary().dropped>1);
context.cmMseCapture.stop();
assert.equal(BufferMock.prototype.appendBuffer,append);
assert.equal(listeners.size,0);
console.log('capture checks passed: data copy/view offsets, return/throw, quotas, restore');
