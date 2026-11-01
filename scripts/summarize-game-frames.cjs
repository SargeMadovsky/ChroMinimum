function summarizeGameFrames(raw,hz=165){
 const reasons=[],samples=raw.samples||[];
 const duration=samples.length>1?(samples.at(-1).now-samples[0].now)/1000:0;
 const geometry=x=>x&&x.width===1000&&x.height===600&&x.dpr===1&&x.scale===1&&x.fullyVisible===true;
 if(!geometry(raw.environment)||!geometry(raw.startEnvironment))reasons.push('viewport mismatch or clipped');
 if(raw.reason!=='measurement-window-complete'||duration<60)reasons.push('incomplete observation');
 if(!raw.sceneReady||!samples.length||samples.some(s=>!(s.calls>0)||!(s.triangles>0)))reasons.push('scene did not render');
 if(raw.contextLost||raw.glError||raw.errors?.length)reasons.push('graphics or script error');
 if(raw.truncated)reasons.push('buffer truncated');
 if(samples.some(s=>s.visibility!=='visible'||!s.focused)||(raw.events||[]).some(e=>e.visibility!=='visible'||!e.focused))reasons.push('focus or visibility interrupted');
 if((raw.events||[]).some(e=>['resize','scroll'].includes(e.type)))reasons.push('geometry changed');
 const intervals=samples.slice(1).map((s,i)=>s.now-samples[i].now);
 if(intervals.some(x=>!Number.isFinite(x)||x<=0))reasons.push('nonmonotonic timestamps');
 const sorted=[...intervals].sort((a,b)=>a-b),pct=p=>sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null;
 return {valid:reasons.length===0,reasons,durationSeconds:duration,renderSamples:samples.length,
  intervalMs:{p50:pct(.5),p95:pct(.95),p99:pct(.99)},displayHzReference:hz,
  over2Periods:intervals.length?intervals.filter(x=>x>2000/hz).length/intervals.length:null,
  over4Periods:intervals.length?intervals.filter(x=>x>4000/hz).length/intervals.length:null,
  gpu:raw.gpu,limitation:'Instrumented render-loop submission intervals, not physical presentation timing; fixed yaw path, not input compatibility'};
}
module.exports={summarizeGameFrames};
