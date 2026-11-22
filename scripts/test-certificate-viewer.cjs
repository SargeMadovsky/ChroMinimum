// End-to-end diagnostic of the native button and real certificate WebUI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const [exeArg,outArg]=process.argv.slice(2);assert(exeArg&&outArg);
 const out=path.resolve(outArg),exe=path.resolve(exeArg);fs.mkdirSync(out);
 const session=path.join(out,'session'),readyFile=path.join(session,'ready.json');
 const child=spawn(process.execPath,['scripts/probe-ssl-viewer.cjs',exe,session],{stdio:['pipe','pipe','pipe']});
 let buffer='',ready,failed,exited=false,queue=[];const stderr=[];
 child.stderr.on('data',b=>stderr.push(b.toString()));
 child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.ready)ready=m.ready;else queue.push(m);}});
 child.on('error',e=>{failed=e});child.on('exit',code=>{exited=true;if(code!==0)failed=Error('Controller exit '+code+' '+stderr.join(''));});
 let closed=false;
 async function command(action){child.stdin.write(JSON.stringify({action})+'\n');for(let i=0;i<600;i++){if(failed)throw failed;if(queue.length){const m=queue.shift();assert(!m.error,m.error);return m;}await delay(50);}throw Error('Controller response timeout');}
 const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
 function observe(name){const output=path.join(out,name+'.json');execFileSync('pwsh',['-NoProfile','-File','scripts/probe-test-window-uia.ps1','-ReadyFile',readyFile,'-Output',output],{timeout:30000});return read(output);}
 function invoke(rows,name,label){const matches=rows.filter(x=>x.name===name&&x.invoke&&x.enabled&&!x.offscreen);assert.equal(matches.length,1,'Unique observed button: '+name);const output=path.join(out,label+'.json');execFileSync('pwsh',['-NoProfile','-File','scripts/probe-test-window-uia.ps1','-ReadyFile',readyFile,'-Output',output,'-InvokeRuntimeId',matches[0].id],{timeout:30000});return read(output+'.invoke.json');}
 try{
  for(let i=0;!ready&&i<1200;i++){if(failed)throw failed;await delay(50);}assert(ready);
  await command('open');const cases=[];
  for(let i=0;i<3;i++){
   if(i){const rows=observe('root-'+i);const lock=rows.find(x=>x.automationId==='view_1129140993');assert(lock);invoke(rows,lock.name,'lock-'+i);}
   let rows;
   for(let attempt=0;attempt<20;attempt++){
    rows=observe('panel-'+i);
    if(rows.some(x=>x.name==='Действительный сертификат'&&x.invoke&&x.enabled&&!x.offscreen))break;
    await delay(100);
   }
   const action=invoke(rows,'Действительный сертификат','certificate-'+i);
   // Wait for the viewer target, then the snapshot helper waits for its DOM.
   let found=false;for(let n=0;n<100;n++){const targets=(await command('targets')).result;if(targets.some(t=>t.url==='chrome://view-cert/')){found=true;break;}await delay(50);}assert(found);
   const snapshot=path.join(out,'timing-'+i+'.json');
   execFileSync(process.execPath,['scripts/inspect-certificate-webui.cjs',readyFile,snapshot],{timeout:20000});
   const value=read(snapshot);assert.equal(value.ready,'complete');assert.equal(value.tabHidden,false);assert(value.body.includes('example.com'));assert(value.body.includes('SHA-256'));
   const details=path.join(out,'details-'+i+'.json');execFileSync(process.execPath,['scripts/inspect-certificate-webui.cjs',readyFile,details,'--details'],{timeout:20000});assert.equal(read(details).selectedTab,'1');
   if(i===0){const tokens=execFileSync('pwsh',['-NoProfile','-File','scripts/inspect-test-process-tokens.ps1','-RootProcessId',String(ready.pid)],{timeout:30000,encoding:'utf8'});fs.writeFileSync(path.join(out,'tokens.json'),tokens);}
   const closeAction=invoke(observe('viewer-'+i),'Закрыть','close-'+i);
   let after;
   for(let n=0;n<100;n++){after=(await command('targets')).result;if(!after.some(t=>t.url==='chrome://view-cert/'))break;await delay(50);}
   assert(!after.some(t=>t.url==='chrome://view-cert/'));assert(after.some(t=>t.id===ready.mainTarget));
   cases.push({iteration:i,invokeAt:action.at,loadMs:value.navigation[0].duration,fcpMs:value.paint.find(p=>p.name==='first-contentful-paint')?.startTime,closeReturnMs:closeAction.returnMs});
  }
  const end=await command('close');assert(end.closed);assert.equal(end.code,0);closed=true;child.stdin.end();
  // Controller finally copies the CEF log after emitting closed.
  for(let i=0;!exited&&i<200;i++)await delay(50);
  assert(exited,'Controller did not finish copying logs');if(failed)throw failed;
  const log=fs.readFileSync(path.join(session,'cef.log'),'utf8');
  const timeouts=log.split('\n').filter(s=>s.includes('Timeout of new browser info response'));
  const result={cases,newBrowserInfoTimeouts:timeouts,exit:0};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(!closed&&!failed)await command('close').catch(()=>{});child.stdin.end();fs.writeFileSync(path.join(out,'controller-stderr.log'),stderr.join(''));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
