/* Local diagnostic only. Run in the page Console before changing quality/restarting
 * its player. No network, storage, URLs, cookies, or page text are collected.
 * Export with: copy(cmMseCapture.exportJSON())
 * Stop/restoration: cmMseCapture.stop()
 */
(() => {
  if (globalThis.cmMseCapture) throw Error('Capture already installed; reload page to start again');
  const maxBytes=12*1024*1024, maxOps=128;
  const state={version:1,maxBytes,maxOps,bytes:0,dropped:0,operations:[],mediaEvents:[]};
  const ids=new WeakMap(), restore=[]; let serial=0, active=true;
  const elapsed=()=>Math.round(performance.now()*1000)/1000;
  const finite=n=>Number.isFinite(n)?n:String(n);
  const identity=sb=>{if(!ids.has(sb))ids.set(sb,{id:++serial,mime:null});return ids.get(sb);};
  const add=op=>{if(state.operations.length<maxOps)state.operations.push({at:elapsed(),...op});else state.dropped++;};
  const wrap=(prototype,key,observe)=>{
    const original=prototype[key]; if(typeof original!=='function')return;
    const wrapped=function(...args){
      const value=Reflect.apply(original,this,args);
      if(active)try{observe(this,args,value);}catch{state.dropped++;}
      return value;
    };
    prototype[key]=wrapped;
    restore.push(()=>{if(prototype[key]===wrapped)prototype[key]=original;});
  };
  wrap(MediaSource.prototype,'addSourceBuffer',(_ms,args,sb)=>{
    const entry=identity(sb);entry.mime=String(args[0]);add({kind:'create',...entry});
  });
  wrap(SourceBuffer.prototype,'appendBuffer',(sb,args)=>{
    const data=args[0];
    const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);
    if(state.bytes+bytes.length>maxBytes||state.operations.length>=maxOps){state.dropped++;return;}
    const entry=identity(sb); const copied=bytes.slice();state.bytes+=copied.length;
    add({kind:'append',...entry,mode:sb.mode,timestampOffset:sb.timestampOffset,
      appendWindowStart:finite(sb.appendWindowStart),appendWindowEnd:finite(sb.appendWindowEnd),data:copied});
  });
  for(const key of ['abort','remove','changeType'])wrap(SourceBuffer.prototype,key,(sb,args)=>{
    const entry=identity(sb);if(key==='changeType')entry.mime=String(args[0]);
    add({kind:key,...entry,args:args.map(v=>typeof v==='number'?finite(v):String(v))});
  });
  wrap(MediaSource.prototype,'endOfStream',(_ms,args)=>add({kind:'endOfStream',args}));
  const event=e=>{
    if(!active||!(e.target instanceof HTMLMediaElement)||state.mediaEvents.length>=256)return;
    const v=e.target;state.mediaEvents.push({at:elapsed(),type:e.type,currentTime:v.currentTime,
      paused:v.paused,readyState:v.readyState,visibility:document.visibilityState,
      error:v.error?{code:v.error.code,message:v.error.message}:null});
  };
  const types=['loadstart','loadedmetadata','playing','pause','seeking','seeked','waiting','stalled','ended','error'];
  types.forEach(type=>document.addEventListener(type,event,true));
  const base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
  globalThis.cmMseCapture={
    summary:()=>({bytes:state.bytes,operations:state.operations.length,dropped:state.dropped,
      mimes:[...new Set(state.operations.map(o=>o.mime).filter(Boolean))]}),
    exportJSON:()=>JSON.stringify({...state,operations:state.operations.map(op=>op.data?
      {...op,data:undefined,base64:base64(op.data)}:op)}),
    stop:()=>{active=false;restore.reverse().forEach(fn=>fn());types.forEach(type=>document.removeEventListener(type,event,true));return 'Capture stopped';}
  };
  console.log('MSE capture installed (12 MiB / 128 operations). Restart player by changing quality, wait for spinner, then copy(cmMseCapture.exportJSON()).');
})();
