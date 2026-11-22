// Timing/DOM capture; optional --details exercises the real WebUI tab handler.
const fs=require('node:fs'),assert=require('node:assert/strict');
async function main(){
 const [readyFile,out]=process.argv.slice(2),details=process.argv.includes('--details');
 const ready=JSON.parse(fs.readFileSync(readyFile,'utf8'));
 const targets=await(await fetch(`http://127.0.0.1:${ready.port}/json/list`)).json();
 const matches=targets.filter(t=>t.url==='chrome://view-cert/');assert.equal(matches.length,1);
 const ws=new WebSocket(matches[0].webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 try{
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Viewer snapshot timeout')),10000);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}};
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,awaitPromise:true,expression:`(async()=>{for(let i=0;i<150&&(!document.querySelector('#details')||document.readyState!=='complete');i++)await new Promise(r=>setTimeout(r,50));if(!document.querySelector('#details')||document.readyState!=='complete')throw Error('Viewer DOM not ready');if(${details}){document.querySelector('#details-tab').click();await new Promise(r=>setTimeout(r,500));}return {at:Date.now(),timeOrigin:performance.timeOrigin,url:location.href,ready:document.readyState,tabHidden:document.querySelector('#tabbox')?.hidden,selectedTab:document.querySelector('#tabbox')?.getAttribute('selected-index'),detailsDisplay:getComputedStyle(document.querySelector('#details')).display,detailsItems:[...document.querySelectorAll('#hierarchy cr-tree-item,#cert-fields cr-tree-item')].map(x=>x.label),body:document.body.innerText,paint:performance.getEntriesByType('paint').map(x=>x.toJSON()),navigation:performance.getEntriesByType('navigation').map(x=>x.toJSON()),resources:performance.getEntriesByType('resource').map(x=>x.toJSON())}})()`}}));
 });assert(!result.exceptionDetails);fs.writeFileSync(out,JSON.stringify(result.result.value,null,2));
 console.log(JSON.stringify({output:out,navigationMs:result.result.value.navigation[0]?.duration,paint:result.result.value.paint}));
 }finally{ws.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
