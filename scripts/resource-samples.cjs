const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};
function summarizeResources(samples,start,end){
 const reasons=[];
 // Discard edge samples to avoid including transport delay around page markers.
 const selected=samples.filter(s=>s.at>=start+1500&&s.at<=end-1500);
 if(selected.length<20)reasons.push('Too few resource samples');
 if(selected.some(s=>!s.rows?.length))reasons.push('Browser processes missing');
 if(selected.some(s=>s.rows.some(p=>!Number.isInteger(p.pid)||!p.created||['cpuSeconds','privateBytes','workingSetBytes'].some(k=>!Number.isFinite(p[k])||p[k]<0))))reasons.push('Invalid process counters');
 let cpu=0,seconds=0,maxGap=0,samplerCpu=0;
 for(let i=1;i<selected.length;i++){
  const a=selected[i-1],b=selected[i],dt=(b.elapsedMs-a.elapsedMs)/1000;maxGap=Math.max(maxGap,dt);
  if(!(dt>0)||dt>2.5)reasons.push('Resource sampling gap or invalid clock');
  const prior=a.cpuLedger||a.rows,current=b.cpuLedger||b.rows;
  const old=new Map(prior.map(p=>[p.pid+':'+p.created,p]));
  for(const p of current){const prev=old.get(p.pid+':'+p.created);if(!Number.isFinite(p.cpuSeconds)||p.cpuSeconds<0)reasons.push('Invalid CPU ledger');
   else if(prev){const delta=p.cpuSeconds-prev.cpuSeconds;if(delta<0)reasons.push('CPU counter decreased');else cpu+=delta;}
   else if(b.cpuLedger&&Number.isFinite(p.bornElapsedMs)&&p.bornElapsedMs>=a.elapsedMs)cpu+=p.cpuSeconds;
   else reasons.push('Process appeared without CPU baseline');}
  if(prior.some(p=>!current.some(q=>q.pid===p.pid&&q.created===p.created)))reasons.push('CPU ledger lost a process');
  seconds+=dt;samplerCpu+=b.samplerCpuSeconds-a.samplerCpuSeconds;
 }
 const logical=selected[0]?.logicalProcessors;
 if(!logical||selected.some(s=>s.logicalProcessors!==logical))reasons.push('Processor count missing or changed');
 const sum=(s,k)=>s.rows.reduce((n,p)=>n+p[k],0);
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],samples:selected.length,seconds,
  privateBytesMedian:median(selected.map(s=>sum(s,'privateBytes'))),workingSetBytesMedian:median(selected.map(s=>sum(s,'workingSetBytes'))),
  cpuSeconds:cpu,cpuPercentOneCore:seconds>0?100*cpu/seconds:null,cpuPercentMachine:seconds>0&&logical?100*cpu/seconds/logical:null,
  samplerCpuPercentOneCore:seconds>0?100*samplerCpu/seconds:null,samplerPrivateBytesMedian:median(selected.map(s=>s.samplerPrivateBytes)),
  sampleCostMsMedian:median(selected.map(s=>s.sampleCostMs)),maxGapSeconds:maxGap,
  limitation:'Same-session runtime-directory processes; retained query handles preserve final CPU counters of discovered processes. Processes outside directory and processes entirely between samples are not counted. Working-set sums may double-count shared pages. Observer overhead recorded, not subtracted.'};
}
module.exports={summarizeResources,median};
