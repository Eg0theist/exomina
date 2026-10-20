// Exact packaged UI and real signed-out voice metadata, with a fresh protected profile.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {extractFile} from '@electron/asar';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';

const root=process.cwd(),build=path.join(root,'release/win-unpacked');
const fixture=await createProtectedQaProfile('realtime-package'),{output,profile}=fixture,workspace=path.join(output,'workspace');
await mkdir(workspace);
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,closeToTray:false,memoryEnabled:false,browserEnabled:false,voice:{realtimeVoice:'marin'}});
const chat=store.create('codex');chat.title='Synthetic voice preview';chat.messages=[{role:'assistant',provider:'codex',content:'Synthetic packaged voice selector check.'}];await store.save();
const report={build:JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8')),scope:'Exact packaged app, fresh encrypted synthetic profile, actual Settings/chat controls and signed-out runtime metadata. No personal accounts, microphone or live subscription playback.',checks:{},errors:[]};
let child,browser,page;
try {
  const unpacked=path.join(build,'resources/app.asar.unpacked'),asar=path.join(build,'resources/app.asar');
  for(const file of ['desktop/realtime-voice.mjs','desktop/realtime-transcript.mjs','desktop/realtime-voice-context.mjs','desktop/voice-transcript.mjs','desktop/voice.mjs','desktop/main.mjs'])assert.ok((await readFile(path.join(unpacked,file))).equals(await readFile(path.join(root,file))),file);
  const html=extractFile(asar,'dist/index.html');assert.ok(html.equals(await readFile(path.join(root,'dist/index.html'))));
  const rendererPath=/src="\.\/([^" ]+\.js)"/.exec(html.toString())?.[1];assert.ok(rendererPath,'The package references its compiled renderer.');
  const renderer=extractFile(asar,path.join('dist',rendererPath));assert.ok(renderer.equals(await readFile(path.join(root,'dist',rendererPath))));assert.ok(renderer.includes('No preview recording is available for this voice.'));assert.ok(!renderer.includes('response.create'));
  assert.ok(renderer.includes('voice.realtime.transcript'),'The compiled renderer forwards recognized WebRTC transcript events to the host.');
  report.checks.packagedSourceMatches=true;report.checks.compiledPreviewUsesPrerecordedSamples=true;report.checks.compiledTranscriptBridgeIncluded=true;
  const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(path.join(build,'Exomina.exe'),['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{env,cwd:build,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();
  const endpoint=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Packaged voice QA did not start')),30000);child.stderr.on('data',chunk=>{text=(text+chunk).slice(-16000);const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(text);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  browser=await chromium.connectOverCDP(endpoint);
  const deadline=Date.now()+30000;
  while(!page&&Date.now()<deadline){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().endsWith('/dist/index.html'));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(page,'Packaged main page loaded');page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  const inactive=await page.evaluate(()=>window.studio.invoke('voice.realtime.transcript',{sessionId:'inactive-synthetic-session',event:{type:'transcript',id:'inactive-item',role:'user',text:'An inactive session cannot write a transcript.',done:true}}));
  assert.deepEqual(inactive,{accepted:false});
  const unchanged=await page.evaluate(async()=>{const state=await window.studio.invoke('bootstrap');return state.conversations.flatMap(chat=>chat.messages).some(message=>message.content==='An inactive session cannot write a transcript.');});
  assert.equal(unchanged,false);report.checks.inactiveTranscriptIpcCannotAppendChat=true;
  const catalog=await page.evaluate(()=>window.studio.invoke('voice.realtime.voices'));
  assert.ok(catalog.voices.includes('juniper')&&catalog.voices.includes('cove'));assert.ok(!catalog.voices.includes('marin')&&!catalog.voices.includes('cedar'));report.checks.nativeChatGPTVoiceCatalog=catalog;
  await page.locator('.sidebar-bottom').getByRole('button',{name:/^Settings/}).click();
  await page.locator('#settings-voice').scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Load ChatGPT voices',exact:true}).click();
  const picker=page.getByLabel('ChatGPT realtime voice',{exact:true});assert.equal(await picker.inputValue(),'');
  await page.getByRole('status').filter({hasText:'Your previous voice is unavailable.'}).waitFor();
  assert.deepEqual(await picker.locator('option').evaluateAll(options=>options.map(option=>option.value)),['',...catalog.voices]);report.checks.packagedSettingsShowsSupportedVoicesAndLegacyDefault=true;
  await picker.selectOption('cove');
  await page.waitForFunction(()=>document.querySelector('[aria-label="ChatGPT realtime voice"]')?.value==='cove');
  await page.screenshot({path:path.join(output,'settings-voice.png')});
  await page.locator(`[data-chat-id="${chat.id}"] .chat-open`).click();await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:'Load ChatGPT voices',exact:true}).click();
  assert.equal(await picker.inputValue(),'cove');assert.deepEqual(await picker.locator('option').evaluateAll(options=>options.map(option=>option.value)),['',...catalog.voices]);report.checks.packagedChatUsesSameCatalogAndPersistedSelection=true;
  report.previewVerification='Actual local clip decoding/playback is covered by qa-voice-preview-clips.mjs.';
  await page.screenshot({path:path.join(output,'chat-voice.png')});
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){
  report.passed=false;report.error=error.stack;process.exitCode=1;
  if(page){report.visibleErrors=await page.locator('[role="alert"],.inline-error').allTextContents().catch(()=>[]);report.voiceUi=await page.locator('.realtime-voice-picker').allTextContents().catch(()=>[]);await page.screenshot({path:path.join(output,'failed-ui.png')}).catch(()=>{});}
}
finally {
  if(page)await page.evaluate(()=>window.close()).catch(()=>{});
  if(child&&child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill();}
  await browser?.close().catch(()=>{});
  try{report.profileProtection=await fixture.verify();}catch(error){report.passed=false;report.protectionError=error.message;process.exitCode=1;}
  await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}
