// Browser-only observer for the pinned game fixture. Render submission != presentation.
(()=>{
 const result={events:[],samples:[],errors:[],contextLost:0,truncated:false,sceneReady:false};
 let renderer,camera,readyAt=null,start=null,sent=false,initialYaw=0;
 const geometry=()=>{const box=frameElement?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale,fullyVisible:!!box&&box.left>=0&&box.top>=0&&box.right<=parent.innerWidth&&box.bottom<=parent.innerHeight};};
 const event=type=>{if(start!==null){if(result.events.length<1000)result.events.push({type,visibility:document.visibilityState,focused:document.hasFocus()});else result.truncated=true;}};
 document.addEventListener('visibilitychange',()=>event('visibilitychange'));
 for(const type of ['focus','blur','resize'])window.addEventListener(type,()=>event(type));
 parent.addEventListener('resize',()=>event('resize'));parent.addEventListener('scroll',()=>event('scroll'));
 addEventListener('error',e=>{result.errors.push(String(e.message).slice(0,500));});
 addEventListener('unhandledrejection',e=>{result.errors.push(String(e.reason).slice(0,500));});
 async function finish(reason){if(sent)return;sent=true;clearTimeout(watchdog);result.reason=reason;result.environment=geometry();result.userAgent=navigator.userAgent;
  if(renderer){const gl=renderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info');result.gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);result.glError=gl.getError();
   result.cameraEnd={position:camera.position.toArray(),yaw:camera.rotation.y};
   try{result.canvasPng=renderer.domElement.toDataURL('image/png');}catch(e){result.errors.push('Screenshot: '+e.message);}}
  try{await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});}catch(e){console.error(e);}
 }
 const watchdog=setTimeout(()=>finish('timeout'),110000);
 window.cmGameMeasurement={
  attach(r,c){renderer=r;camera=c;renderer.domElement.addEventListener('webglcontextlost',()=>{result.contextLost++;});},
  ready(){result.sceneReady=true;readyAt=performance.now();},
  before(now){if(readyAt===null||sent)return;
   if(start===null&&now-readyAt>=10000){start=now;initialYaw=camera.rotation.y;result.startEnvironment=geometry();result.cameraStart={position:camera.position.toArray(),yaw:initialYaw};}
   if(start!==null)camera.rotation.y=initialYaw+(now-start)/60000*Math.PI*2;
  },
  after(now,end){if(start===null||sent)return;
   if(result.samples.length<20000)result.samples.push({now,submitMs:end-now,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,visibility:document.visibilityState,focused:document.hasFocus()});else result.truncated=true;
   if(now-start>=60000)finish('measurement-window-complete');
  }
 };
})();
