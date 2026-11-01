// Diagnostic counters and callback timings, not physical presentation FPS.
function summarizeVideoFrames(observation, minimumSeconds = 60) {
  const m = observation.frameMetrics;
  const reasons = [];
  if (!m || !m.supported) return {valid:false, reasons:['frame callback API unavailable']};
  const samples = m.samples || [];
  const span = samples.length > 1 ? (samples.at(-1).now - samples[0].now) / 1000 : 0;
  if (span < minimumSeconds) reasons.push('observation too short');
  if (m.truncated) reasons.push('sample buffer truncated');
  if (samples.some(s => s.visibility !== 'visible' || !s.focused) ||
      (observation.events || []).some(e => e.visibility !== 'visible' || !e.focused)) reasons.push('visibility or focus interrupted');
  if ((observation.events || []).some(e => e.type === 'pause' && !e.ended)) reasons.push('playback paused');
  if ((observation.events || []).some(e => e.type === 'resize')) reasons.push('viewport resized');
  if ((observation.events || []).some(e => e.type === 'outer-scroll')) reasons.push('measurement container scrolled');
  if (observation.error || observation.playError) reasons.push('playback error');
  const intervals = [], mediaSteps = [];
  for (let i=1;i<samples.length;i++) {
    intervals.push(samples[i].now-samples[i-1].now);
    mediaSteps.push(samples[i].mediaTime-samples[i-1].mediaTime);
  }
  if (intervals.some(x=>!Number.isFinite(x)||x<=0) || mediaSteps.some(x=>!Number.isFinite(x)||x<=0)) reasons.push('nonmonotonic callback timeline');
  const deltaTotal = m.lastQuality?.totalVideoFrames - m.firstQuality?.totalVideoFrames;
  const deltaDropped = m.lastQuality?.droppedVideoFrames - m.firstQuality?.droppedVideoFrames;
  if (!Number.isFinite(deltaTotal)||!Number.isFinite(deltaDropped)||deltaTotal<=0||deltaDropped<0||deltaDropped>deltaTotal) reasons.push('invalid quality counters');
  const sorted = [...intervals].sort((a,b)=>a-b);
  const percentile = p => sorted.length ? sorted[Math.ceil(p*sorted.length)-1] : null;
  return {valid:reasons.length===0,reasons,spanSeconds:span,samples:samples.length,
    deltaTotal,deltaDropped,droppedFraction:deltaTotal>0?deltaDropped/deltaTotal:null,
    callbackIntervalMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)},
    waitingEvents:(observation.events||[]).filter(e=>e.type==='waiting').length,
    stalledEvents:(observation.events||[]).filter(e=>e.type==='stalled').length,
    limitation:'Callback timing is not physical presentation timing; startup waiting included; no warmup window yet'};
}
module.exports={summarizeVideoFrames};
