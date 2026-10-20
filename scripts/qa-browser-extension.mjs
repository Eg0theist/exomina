import { chromium } from 'playwright';
import { BrowserBridge } from '../desktop/browser-bridge.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(root,'../Workspace/drafts-browser-verification');await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'extension-profile-'));
const extension=path.join(root,'desktop/browser-extension');
const executablePath=process.env.EXOMINA_QA_CHROMIUM || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const report={scope:'Real unpacked extension and authenticated loopback bridge, isolated browser profile and synthetic local website only. No existing browser profile, real account, cookie or password was accessed.',executablePath,profile,checks:{}};
const server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','text/html; charset=utf-8');
  if(request.url==='/login'){response.setHeader('Set-Cookie','signed=synthetic; Path=/; HttpOnly; SameSite=Lax');response.end('<title>Synthetic sign-in</title><main>Signed in on the fixture</main>');return;}
  response.end(`<title>Fixture ${request.url}</title><main><h1>${request.headers.cookie?.includes('signed=synthetic')?'Synthetic signed-in session':'Signed out'}</h1><input id="field" aria-label="Fixture draft"><button id="button" onclick="document.querySelector('#clicked').textContent='Clicked'">Fixture button</button><p id="clicked">Waiting</p></main>`);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const bridge=new BrowserBridge({port:0,timeout:30000});const setup=await bridge.prepare();let context;
const handle=bridge.handle.bind(bridge);report.requests=[];bridge.handle=(request,response)=>{report.requests.push({path:request.url,method:request.method,origin:request.headers.origin||null,host:request.headers.host,authenticated:!!request.headers.authorization});return handle(request,response);};
let options;
try{
  context=await chromium.launchPersistentContext(profile,{executablePath,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking','--disable-sync','--no-first-run']});
  await context.route('**/*',route=>/^https?:/.test(route.request().url())&&!route.request().url().startsWith('http://127.0.0.1:')?route.abort():route.continue());
  const worker=context.serviceWorkers().find(value=>value.url().includes('background.js'))||await context.waitForEvent('serviceworker',{timeout:10000});
  await worker.evaluate(()=>{globalThis.qaMessages=[];chrome.runtime.onMessage.addListener((message,sender)=>{globalThis.qaMessages.push({action:message.action,id:sender.id,url:sender.url,own:chrome.runtime.id});return false;});});
  const extensionId=new URL(worker.url()).host;options=await context.newPage();await options.goto(`chrome-extension://${extensionId}/connect.html`);
  report.workerUrl=worker.url();
  await options.getByLabel('Connection code from Exomina → Tools').fill(setup.code);await options.getByRole('button',{name:'Connect',exact:true}).click();
  const ready=options.getByRole('status').filter({hasText:'Connected.'}).waitFor({timeout:12000});
  await ready.catch(async error=>{report.messages=await worker.evaluate(()=>globalThis.qaMessages).catch(()=>null);throw error;});report.checks.realPairing=true;
  await bridge.request('navigate',{url:base+'/login'},'a');await bridge.request('navigate',{url:base+'/a'},'a');
  let a=await bridge.request('snapshot',{},'a');let data=JSON.parse(a.content.find(item=>item.type==='text').text);assert.match(data.text,/Synthetic signed-in session/);
  const field=data.elements.find(item=>item.text==='Fixture draft');assert.ok(field);
  await bridge.request('type',{selector:field.selector,text:'Only chat A'},'a');
  await bridge.request('navigate',{url:base+'/b'},'b');let b=await bridge.request('snapshot',{},'b');assert.match(JSON.parse(b.content[0].text).text,/Synthetic signed-in session/);report.checks.sharedSignedInBrowserProfile=true;
  a=await bridge.request('snapshot',{},'a');data=JSON.parse(a.content[0].text);const button=data.elements.find(item=>item.text==='Fixture button');
  await bridge.request('click',{selector:button.selector},'a');a=await bridge.request('snapshot',{},'a');assert.match(JSON.parse(a.content[0].text).text,/Clicked/);report.checks.nativeMouseClick=true;
  const pages=context.pages();const pageA=pages.find(page=>page.url()===base+'/a'),pageB=pages.find(page=>page.url()===base+'/b');assert.ok(pageA&&pageB);
  assert.equal(await pageA.locator('#field').inputValue(),'Only chat A');assert.equal(await pageB.locator('#field').inputValue(),'');report.checks.tabsAndFormDraftsArePerChat=true;
  assert.ok(a.content.some(item=>item.type==='image'&&item.mimeType==='image/png'));report.checks.realScreenshot=true;
  await assert.rejects(bridge.request('navigate',{url:'file:///C:/private.txt'},'a'),/Only HTTP/);report.checks.rejectsFileUrls=true;
  await pageA.screenshot({path:path.join(output,'connected-browser-fixture.png')});report.passed=true;
}catch(error){report.failure=error.stack;report.browserStatus=await options?.getByRole('status').innerText().catch(()=>null);process.exitCode=1;}
finally{await context?.close();await bridge.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'extension-qa.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({passed:report.passed||false,checks:report.checks,failure:report.failure,browserStatus:report.browserStatus,messages:report.messages,requests:report.passed?undefined:report.requests,report:path.join(output,'extension-qa.json')}));
