// Acceptance of the real Chromium PageInfo security subpage, with a disposable profile.

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

const http = require('node:http'), https = require('node:https');

const {spawn, spawnSync} = require('node:child_process');

const assert = require('node:assert/strict');

const {observeChild, requireRunning, waitForExit} = require('./diagnose-media.cjs');

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {

  const [exe, output] = process.argv.slice(2).map(p => path.resolve(p));

  fs.mkdirSync(output);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ChroMinimum-security-'));

  fs.writeFileSync(path.join(output, 'profile-location.json'), JSON.stringify({data, disposable:true}));

  const server = http.createServer((req, res) => {

    if (req.url === '/redirect') { res.writeHead(302, {Location:'https://example.com/'}); res.end(); }

    else { res.end('<!doctype html><title>Connection indicator fixture</title>HTTP'); }

  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const base = `http://127.0.0.1:${server.address().port}`;

  const key=path.join(data,'fixture-key.pem'), cert=path.join(data,'fixture-cert.pem');

  const openssl=process.env.CHROMINIMUM_TEST_OPENSSL || 'C:/Program Files/Git/usr/bin/openssl.exe';

  const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-noenc','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{encoding:'utf8'});

  assert.equal(generated.status,0,generated.stderr);

  let invalidTlsRequests=0;

  const tlsServer=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(_req,res)=>{invalidTlsRequests++;res.end('TLS bypass');});

  await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CHROMINIMUM_')));

  env.CHROMINIMUM_DATA_DIR = data;

  const child = spawn(exe, ['--smoke-test', '--test-cdp', '--test-native-security-panel', ...(process.argv.includes('--ru')?['--test-cef-locale=ru']:[]), `--url=${base}/`], {env, stdio:['ignore','ignore',fs.openSync(path.join(output,'stderr.log'),'w')]});

  const state = observeChild(child);

  const cefLog = () => fs.existsSync(path.join(data,'cef.log')) ? fs.readFileSync(path.join(data,'cef.log'),'utf8') : '';

  const log = () => fs.existsSync(path.join(data,'smoke.log')) ? fs.readFileSync(path.join(data,'smoke.log'),'utf8') : '';

  let socket, call;

  const cases = [];

  try {

    const portFile = path.join(data,'profile-smoke','DevToolsActivePort');

    for (let i=0; !fs.existsSync(portFile) && i<1200; i++) { requireRunning(state); await delay(50); }

    const port = Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);

    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

    const page = pages.find(p => p.type === 'page'); assert(page);

    socket = new WebSocket(page.webSocketDebuggerUrl);

    await new Promise((r,j) => { socket.onopen=r; socket.onerror=j; });

    let id=0; const pending = new Map();

    socket.onmessage = e => { const m=JSON.parse(e.data), p=pending.get(m.id); if(p) { pending.delete(m.id); m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result); } };

    call = (method,params={}) => new Promise((resolve,reject) => {

      const serial=++id, timer=setTimeout(() => { pending.delete(serial); reject(Error(`Timeout: ${method}`)); },8000);

      pending.set(serial,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});

      socket.send(JSON.stringify({id:serial,method,params}));

    });

    async function accept(name, expected, offset=0, sameDocument=false) {

      for(let i=0;i<600;i++) {

        requireRunning(state);

        const segment=log().slice(offset);

        const states=[...segment.matchAll(/connection_security=(\w+)/g)].map(m=>m[1]);

        const allStates=[...log().matchAll(/connection_security=(\w+)/g)].map(m=>m[1]);
        const observed=states.at(-1)??allStates.at(-1);
        if((sameDocument?segment.includes('connection_security_address_committed'):segment.includes('main_frame_loaded;')) && observed===expected) {

          const before=cefLog().length;

          await call('Runtime.evaluate',{expression:`document.title='ChroMinimum test security panel open'`});

          let segment;

          for(let k=0;k<300;k++) {

            segment=cefLog().slice(before);

            if(segment.includes('CM_SSL_OPEN')) break;

            await delay(20);

          }

          assert(segment?.includes('CM_SSL_OPEN'),`${name}: native PageInfo did not open`);

          const internal=expected==='Local';

          assert(segment.includes(`security_page=${internal?'0':'1'}`),`${name}: wrong native bubble type`);

          await call('Runtime.evaluate',{expression:`document.title='ChroMinimum test security panel inspect'`});

          for(let k=0;k<200 && !cefLog().slice(before).includes('CM_SSL_INSPECT visible=1');k++) await delay(20);

          segment=cefLog().slice(before);

          assert(segment.includes('CM_SSL_INSPECT visible=1'));
          const openPages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          assert.equal(openPages.filter(p=>p.type==='page').length,1,'PageInfo must not create another browser page');

          const labels=[...segment.matchAll(/CM_SSL_LABEL ([^\r\n]*)/g)].map(m=>m[1]);

          // InternalPageInfo uses the bubble frame title, outside GetContentsView.
          if(!internal) assert(labels.length>0, 'Native security label text must be observable');

          const text=labels.join('\n');

          if(expected==='Secure') assert(/Connection is secure|\u0421\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0437\u0430\u0449\u0438\u0449\u0435\u043d\u043e|\u041f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u0437\u0430\u0449\u0438\u0449\u0435\u043d\u043e/i.test(text),text);

          if(expected==='Secure') assert(/certificate|\u0441\u0435\u0440\u0442\u0438\u0444\u0438\u043a\u0430\u0442/i.test(text),'Native security page must expose certificate information');
          if(expected==='Http'||expected==='CertificateError') assert(/not secure|\u043d\u0435 \u0437\u0430\u0449\u0438\u0449\u0435\u043d\u043e|not valid|\u043d\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043b/i.test(text),text);

          await call('Runtime.evaluate',{expression:`document.title='ChroMinimum test security panel close'`});

          for(let k=0;k<200 && !cefLog().slice(before).includes('CM_SSL_CLOSED');k++) await delay(20);

          assert(cefLog().slice(before).includes('CM_SSL_CLOSED'));

          const alive=await call('Runtime.evaluate',{expression:'1+1',returnByValue:true});

          assert.equal(alive.result.value,2);

          cases.push({name,expected,states,native_security_page:!internal,same_document:sameDocument,labels:[...new Set(labels)]}); return;

        }

        await delay(50);

      }

      throw Error(`${name}: expected ${expected}\n${log().slice(offset)}`);

    }

    await accept('plain-http','Http');

    for(const [name,url,expected] of [

      ['https','https://example.com/','Secure'],

      ['local-file',new URL('file:///'+path.resolve(__dirname,'../tests/fixtures/smoke.html').replaceAll('\\','/')).href,'Local'],

      ['http-redirect-to-https',base+'/redirect','Secure'],

      ['invalid-certificate',`https://localhost:${tlsServer.address().port}/`,'CertificateError'],

      ['recover-after-certificate-error','https://example.com/','Secure'],

      ['https-fragment','https://example.com/#ssl-panel-fixture','Secure'],
      ['https-to-http',base+'/again','Http'],

    ]) {

      const offset=log().length;

      await call('Page.navigate',{url});

      await accept(name,expected,offset,name==='https-fragment');

      if(name!=='https-fragment') assert(cases.at(-1).states.includes('Unknown'), 'Previous confirmation must be cleared before commit');

    }

    assert.equal(invalidTlsRequests,0,'Invalid TLS must never reach HTTP');

    // Closing the owner while its native PageInfo is open must not hang.

    await call('Runtime.evaluate',{expression:`document.title='ChroMinimum test security panel open'`});

    await delay(500);

    await call('Page.close');

    socket.close();

    await waitForExit(state,15000);

    assert.equal(state.code,0);

    assert(log().includes('shutdown_complete'));

    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({cases,exit:state.code,shutdown_complete:true,native_visual_acceptance:false,invalid_tls_http_requests:invalidTlsRequests},null,2));

  } finally {

    socket?.close(); server.close(); tlsServer.close();

    fs.unlinkSync(key);

    for(const file of ['smoke.log','cef.log']) if(fs.existsSync(path.join(data,file))) fs.copyFileSync(path.join(data,file),path.join(output,file));

    if(!state.finished) child.kill();

  }

}

main().catch(e=>{console.error(e);process.exitCode=1;});

