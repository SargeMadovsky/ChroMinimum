// Synthetic file -> captureStream -> local PeerConnection pair. No device capture.
const page=`<!doctype html><meta charset="utf-8"><title>WebRTC loopback pilot</title>
<style>body{margin:0;background:#17202b;color:white;font:16px sans-serif}header{padding:8px}video{width:480px;height:270px;display:inline-block}</style>
<header id="status">WebRTC: connecting two local peers; no camera or microphone</header>
<video id="source" src="/fixture.mp4" muted autoplay playsinline></video><video id="remote" muted autoplay playsinline></video>
<script>
const source=document.querySelector('#source'),remote=document.querySelector('#remote'),status=document.querySelector('#status');
const result={events:[],connectionEvents:[],errors:[],samples:[],audioProbe:{frames:0,blocks:0,peak:0,samplesTested:0},deviceCaptureUsed:false,externalIceServers:false};
const pc1=new RTCPeerConnection({iceServers:[]}),pc2=new RTCPeerConnection({iceServers:[]});
let stream,audioReader,audioClone,started=false,sent=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function geometry(){const box=frameElement?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale,fullyVisible:!!box&&box.left>=0&&box.top>=0&&box.right<=parent.innerWidth&&box.bottom<=parent.innerHeight};}
function record(type){if(started&&result.events.length<1000)result.events.push({type,visibility:document.visibilityState,focused:document.hasFocus()});}
document.addEventListener('visibilitychange',()=>record('visibilitychange'));for(const name of ['focus','blur','resize'])addEventListener(name,()=>record(name));parent.addEventListener('resize',()=>record('resize'));parent.addEventListener('scroll',()=>record('scroll'));
for(const [name,pc] of [['sender',pc1],['receiver',pc2]])pc.addEventListener('connectionstatechange',()=>{if(result.connectionEvents.length<50)result.connectionEvents.push({peer:name,state:pc.connectionState,at:performance.now()});if(started)result.events.push({type:'connection',peer:name,state:pc.connectionState,visibility:document.visibilityState,focused:document.hasFocus()});});
async function inspectAudio(track){
 try{if(typeof MediaStreamTrackProcessor!=='function')throw Error('Audio track processor unavailable');
  audioClone=track.clone();audioReader=new MediaStreamTrackProcessor({track:audioClone}).readable.getReader();
  while(!sent){const {value,done}=await audioReader.read();if(done)break;
   try{if(started){const probe=result.audioProbe;probe.frames+=value.numberOfFrames;probe.blocks++;
    if(probe.blocks%10===0){const pcm=new Float32Array(value.numberOfFrames);value.copyTo(pcm,{planeIndex:0,format:'f32-planar'});for(const sample of pcm)probe.peak=Math.max(probe.peak,Math.abs(sample));probe.samplesTested+=pcm.length;}}}
   finally{value.close();}
  }
 }catch(e){if(!sent)result.errors.push('Audio probe: '+e.message);}
}
pc2.ontrack=e=>{if(e.track.kind==='audio')inspectAudio(e.track);if(remote.srcObject!==e.streams[0]){remote.srcObject=e.streams[0];remote.play().catch(error=>result.errors.push(error.name));}};
function pick(stat,keys){const out={};for(const key of keys)if(stat[key]!==undefined)out[key]=stat[key];return out;}
async function stats(){const report=await pc2.getStats(),out={now:performance.now(),visibility:document.visibilityState,focused:document.hasFocus(),senderState:pc1.connectionState,receiverState:pc2.connectionState,sourceTime:source.currentTime,remoteTime:remote.currentTime};
 for(const stat of report.values())if(stat.type==='inbound-rtp'&&!stat.isRemote){const kind=stat.kind||stat.mediaType;if(kind==='video'||kind==='audio'){
 out[kind]=pick(stat,['bytesReceived','packetsReceived','packetsLost','jitter','framesDecoded','framesReceived','framesDropped','frameWidth','frameHeight','framesPerSecond','totalDecodeTime','freezeCount','totalFreezesDuration','totalSamplesReceived','concealedSamples','totalAudioEnergy','jitterBufferDelay','jitterBufferEmittedCount','decoderImplementation']);
 out[kind].codec=report.get(stat.codecId)?.mimeType;}}
 for(const stat of report.values())if(stat.type==='transport'&&stat.selectedCandidatePairId){const pair=report.get(stat.selectedCandidatePairId);if(pair)out.transport=pick(pair,['state','currentRoundTripTime','availableOutgoingBitrate']);}
 return out;}
async function gathering(pc){const deadline=performance.now()+10000;while(pc.iceGatheringState!=='complete'){if(performance.now()>deadline)throw Error('ICE gathering timeout');await delay(50);}}
async function finish(reason){if(sent)return;sent=true;clearTimeout(watchdog);result.reason=reason;result.environment=geometry();result.userAgent=navigator.userAgent;
 result.peers=[pc1,pc2].map(pc=>{const types={};for(const line of (pc.localDescription?.sdp||'').split('\\n'))if(line.startsWith('a=candidate:')){const type=/ typ (\\w+)/.exec(line)?.[1]||'unknown';types[type]=(types[type]||0)+1;}return {connection:pc.connectionState,iceConnection:pc.iceConnectionState,gathering:pc.iceGatheringState,signaling:pc.signalingState,candidateTypes:types};});
 result.mediaStates={sourceReady:source.readyState,remoteReady:remote.readyState,remoteWidth:remote.videoWidth,remoteHeight:remote.videoHeight};
 try{if(remote.videoWidth){const c=document.createElement('canvas');c.width=remote.videoWidth;c.height=remote.videoHeight;c.getContext('2d').drawImage(remote,0,0);result.remotePng=c.toDataURL('image/png');}}catch(e){result.errors.push('Screenshot: '+e.message);}
 status.textContent='WebRTC measurement finished: '+reason;
 try{await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});}finally{audioReader?.cancel().catch(()=>{});audioClone?.stop();pc1.close();pc2.close();stream?.getTracks().forEach(t=>t.stop());source.pause();remote.pause();}}
const watchdog=setTimeout(()=>finish('timeout'),85000);
(async()=>{
 await source.play();const ready=performance.now()+10000;while(source.readyState<3){if(performance.now()>ready)throw Error('Source readiness timeout');await delay(50);}
 if(typeof source.captureStream!=='function')throw Error('captureStream unavailable');stream=source.captureStream();result.sourceTracks=stream.getTracks().map(t=>({kind:t.kind,enabled:t.enabled,muted:t.muted}));
 for(const track of stream.getTracks())pc1.addTrack(track,stream);
 await pc1.setLocalDescription(await pc1.createOffer());await gathering(pc1);await pc2.setRemoteDescription(pc1.localDescription);
 await pc2.setLocalDescription(await pc2.createAnswer());await gathering(pc2);await pc1.setRemoteDescription(pc2.localDescription);
 const deadline=performance.now()+15000;while(pc2.connectionState!=='connected'||remote.readyState<2){if(performance.now()>deadline)throw Error('Peer connection readiness timeout');await delay(50);}
 status.textContent='WebRTC connected — 5 s warmup, then 30 s observation';await delay(5000);result.startEnvironment=geometry();started=true;
 const first=await stats();result.samples.push(first);while(performance.now()-first.now<30000){await delay(1000);result.samples.push(await stats());}
 await finish('measurement-window-complete');
})().catch(e=>{result.errors.push(e.message);finish('error').catch(()=>{});});
</script>`;
function summarizeWebRTC(raw){
 const samples=raw.samples||[],first=samples[0],last=samples.at(-1),reasons=[];
 const delta=(kind,key)=>last?.[kind]?.[key]-first?.[kind]?.[key];
 const span=first&&last?(last.now-first.now)/1000:0;
 const geometry=x=>x&&x.width===1000&&x.height===600&&x.dpr===1&&x.scale===1&&x.fullyVisible===true;
 if(!geometry(raw.environment)||!geometry(raw.startEnvironment))reasons.push('viewport mismatch or clipped');
 if(raw.reason!=='measurement-window-complete'||span<30)reasons.push('incomplete observation');
 if(raw.errors?.length)reasons.push('script or peer error');
 if(samples.some(s=>s.senderState!=='connected'||s.receiverState!=='connected'))reasons.push('connection interrupted');
 if(samples.some(s=>s.visibility!=='visible'||!s.focused)||(raw.events||[]).some(e=>e.visibility!=='visible'||!e.focused))reasons.push('visibility or focus interrupted');
 if((raw.events||[]).some(e=>['resize','scroll'].includes(e.type)))reasons.push('geometry changed');
 const videoReceived=delta('video','framesDecoded')>0&&delta('video','bytesReceived')>0;
 const audioReceived=delta('audio','packetsReceived')>0&&delta('audio','bytesReceived')>0;
 const audioEnergyVerified=delta('audio','totalAudioEnergy')>0;
 const audioPcmVerified=raw.audioProbe?.frames>0&&raw.audioProbe?.samplesTested>0&&raw.audioProbe?.peak>0;
 if(!videoReceived)reasons.push('decoded video did not advance');
 if(!audioReceived||!audioPcmVerified)reasons.push('nonzero decoded audio PCM not verified');
 return {valid:reasons.length===0,reasons,durationSeconds:span,samples:samples.length,videoReceived,audioReceived,audioEnergyVerified,audioPcmVerified,audioProbe:raw.audioProbe,
  framesDecodedDelta:delta('video','framesDecoded'),framesDroppedDelta:delta('video','framesDropped'),videoPacketsLostDelta:delta('video','packetsLost'),
  audioPacketsDelta:delta('audio','packetsReceived'),audioEnergyDelta:delta('audio','totalAudioEnergy'),videoCodec:last?.video?.codec,audioCodec:last?.audio?.codec,
  videoDimensions:{start:first?.video?[first.video.frameWidth,first.video.frameHeight]:null,end:last?.video?[last.video.frameWidth,last.video.frameHeight]:null},
  limitation:'Two peers in one page on one PC; muted output; no devices, Internet, NAT/TURN or acoustic/end-to-end latency verification'};
}
module.exports={page,summarizeWebRTC};
