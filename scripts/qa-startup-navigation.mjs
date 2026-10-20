// Inspector instrumentation applies only to the explicitly launched, synthetic QA process.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {Store} from '../desktop/store.mjs';
import {_electron as electron} from 'playwright';

const build=path.resolve(process.argv[2]||'release/win-unpacked'),scenario=process.argv[3]||'reload',baseline=process.argv.includes('--baseline');
assert.ok(['reload','close','bad-url'].includes(scenario));
const fixture=await createProtectedQaProfile('startup-navigation'),{profile,output}=fixture;
const workspace=path.join(output,'workspace');await mkdir(workspace);
const store=new Store(profile,{workspace});await store.init();Object.assign(store.state.settings,{autoUpdate:false,autoTitle:false,closeToTray:false,quickAccess:false,memoryEnabled:false,browserEnabled:false});await store.save();
const report={build:JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8')),scenario,baseline,syntheticOnly:true,personalProfileAccessed:false,events:[],dialogs:[]};
const env={...process.env,EXOMINA_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
let socket,child,clipApp,closed=false,nextId=0,stderr='',pending=new Map(),notifications=[];
function command(method,params={}){const id=++nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout: '+method));},12000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,includeCommandLineAPI:true,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
async function poll(check,message,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(message);}
try{
  child=spawn(path.join(build,'Exomina.exe'),['--inspect-brk=0','--remote-debugging-port=0','--mute-audio'],{cwd:build,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.on('exit',(code,signal)=>{closed=true;report.exit={code,signal};});child.stderr.on('data',bytes=>{stderr+=bytes;});
  const endpoint=await poll(()=>/Debugger listening on (ws:\/\/[^\r\n]+)/.exec(stderr)?.[1],'Inspector endpoint did not appear.');
  socket=new WebSocket(endpoint);await once(socket,'open');socket.addEventListener('message',({data})=>{const message=JSON.parse(data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);message.error?task?.reject(Error(message.error.message)):task?.resolve(message.result);}else{notifications.push(message);const value=message.params?.args?.[0]?.value;if(message.method==='Runtime.consoleAPICalled'&&typeof value==='string'&&value.startsWith('EXOMINA_STARTUP_QA:')){const qa=JSON.parse(value.slice('EXOMINA_STARTUP_QA:'.length));report.events=qa.events;report.dialogs=qa.dialogs;}}});
  await command('Runtime.enable');await command('Debugger.enable');await command('Runtime.runIfWaitingForDebugger');await poll(()=>notifications.find(event=>event.method==='Debugger.paused'),'Entry breakpoint was not reached.');
  const main=await readFile(path.join(build,'resources/app.asar.unpacked/desktop/main.mjs'),'utf8'),line=main.split('\n').findIndex(line=>line.includes("startupStage='workspace page'"));assert.ok(line>0);
  const breakpoint=await command('Debugger.setBreakpointByUrl',{urlRegex:'desktop/main\\.mjs$',lineNumber:line});notifications=[];await command('Debugger.resume');
  const paused=await poll(()=>notifications.find(event=>event.method==='Debugger.paused'&&event.params.hitBreakpoints?.includes(breakpoint.breakpointId)),'Workspace loader breakpoint was not reached.');
  const instrumentation=await command('Debugger.evaluateOnCallFrame',{callFrameId:paused.params.callFrames[0].callFrameId,returnByValue:true,expression:`(()=>{
    globalThis.__startupNavigationQa={events:[],dialogs:[],scenario:${JSON.stringify(scenario)}};
    const qa=globalThis.__startupNavigationQa,record=(type,extra={})=>{qa.events.push({type,at:Date.now(),...extra});console.log('EXOMINA_STARTUP_QA:'+JSON.stringify(qa));};
    BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false);record('show',{url:this.webContents.getURL()});return this.hide();};
    const display=dialog.showMessageBox;dialog.showMessageBox=async function(...args){const options=args.at(-1);if(options?.title==='Exomina could not start'){qa.dialogs.push(options);record('fatal-dialog',{detail:options.detail});return {response:0};}return display.apply(this,args);};
    const original=BrowserWindow.prototype.loadURL;let injected=false;
    BrowserWindow.prototype.loadURL=function(url,...args){
      if(injected||!url.includes('/dist/index.html'))return original.call(this,url,...args);
      injected=true;const wc=this.webContents;record('initial-load',{url});
      wc.on('did-start-navigation',(_event,url,_inPlace,isMainFrame)=>{if(isMainFrame)record('navigation-start',{url});});
      wc.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{if(isMainFrame)record('load-failed',{code,description,url});});
      wc.on('did-finish-load',()=>record('load-finished',{url:wc.getURL()}));
      wc.on('did-stop-loading',()=>record('loading-stopped',{url:wc.getURL()}));
      const result=original.call(this,qa.scenario==='bad-url'?url+'-missing':url,...args);
      result.then(()=>record('initial-resolved'),error=>record('initial-rejected',{message:error.message,code:error.code}));
      if(qa.scenario==='reload')setImmediate(()=>{if(!this.isDestroyed()){record('supersede');original.call(this,url,...args).then(()=>record('replacement-resolved'),error=>record('replacement-rejected',{message:error.message}));}});
      if(qa.scenario==='close')setImmediate(()=>{record('intentional-close');this.close();});
      return result;
    };
    app.on('before-quit',()=>record('before-quit'));
    return true;
  })()`});if(instrumentation.exceptionDetails)throw Error(instrumentation.exceptionDetails.exception?.description||instrumentation.exceptionDetails.text);assert.equal(instrumentation.result.value,true);
  await command('Debugger.resume');
  await poll(()=>{
    if(closed)return true;
    if(scenario==='reload')return baseline?report.dialogs.length>0:report.events.some(event=>event.type==='replacement-resolved')&&report.events.some(event=>event.type==='show');
    if(scenario==='close')return report.events.some(event=>event.type==='before-quit');
    return report.dialogs.length>0;
  },'The startup scenario did not reach a terminal result.',20000);
  await new Promise(resolve=>setTimeout(resolve,150));
  if(scenario==='reload'){
    assert.ok(report.events.some(event=>event.type==='initial-rejected'&&event.message.includes('ERR_ABORTED')));
    if(baseline)assert.ok(report.dialogs?.some(dialog=>dialog.detail.includes('ERR_ABORTED')),'Original package shows fatal startup abort.');
    else{assert.equal(report.dialogs.length,0);assert.ok(report.events.some(event=>event.type==='replacement-resolved'));assert.ok(report.events.some(event=>event.type==='show'));assert.ok(!report.events.some(event=>event.type==='before-quit'));assert.equal(report.events.filter(event=>event.type==='navigation-start').length,2,'The completed replacement is accepted without another navigation.');report.recoveryMs=report.events.find(event=>event.type==='show').at-report.events.find(event=>event.type==='initial-rejected').at;}
  }else if(scenario==='close'){assert.ok(report.events.some(event=>event.type==='intentional-close'));if(!baseline)assert.equal(report.dialogs.length,0);}
  else assert.ok(report.dialogs?.some(dialog=>/ERR_FILE_NOT_FOUND/.test(dialog.detail)),'Genuine failed startup remains fatal.');
  if(scenario==='reload'&&!baseline){
    // Electron requires its own Playwright attachment; ordinary Chromium CDP
    // attachment can stall. Reopen only this same synthetic protected profile.
    await evaluate("require('electron').app.quit()");socket.close();await poll(()=>closed,'Instrumented startup fixture did not close.',5000);
    clipApp=await electron.launch({executablePath:path.join(build,'Exomina.exe'),args:['--mute-audio'],cwd:build,env,timeout:15000});const page=await clipApp.firstWindow();page.setDefaultTimeout(10000);
    await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
    await clipApp.evaluate(({ipcMain,BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.hide();window.webContents.setBackgroundThrottling(false);}globalThis.__startupClipMethods=[];const original=ipcMain._invokeHandlers.get('studio:invoke');ipcMain._invokeHandlers.set('studio:invoke',(event,method,payload)=>{globalThis.__startupClipMethods.push(method);return original(event,method,payload);});});
    await page.evaluate(()=>{
      window.__startupClipQa={captures:0,peers:0};const NativeAudio=window.Audio;
      document.addEventListener('click',event=>{if(event.target.closest?.('.realtime-preview-button'))window.__startupClipQa.clickedAt=performance.now();},true);
      window.Audio=function(...args){const audio=new NativeAudio(...args);window.__startupClipQa.audio=audio;audio.play=function(){const promise=NativeAudio.prototype.play.call(audio);promise.then(()=>{window.__startupClipQa.playedAt=performance.now();},()=>{});return promise;};return audio;};window.Audio.prototype=NativeAudio.prototype;
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{window.__startupClipQa.captures++;throw Error('Clip preview must not capture audio.');}});window.RTCPeerConnection=function(){window.__startupClipQa.peers++;throw Error('Clip preview must not use WebRTC.');};
    });
    await page.locator('.sidebar-bottom').getByRole('button',{name:/^Settings/}).click();await page.locator('#settings-voice').scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Load ChatGPT voices',exact:true}).click();await page.getByLabel('ChatGPT realtime voice',{exact:true}).selectOption('cove');await page.getByRole('button',{name:'Preview realtime voice',exact:true}).click();
    await page.waitForFunction(()=>window.__startupClipQa.playedAt&&window.__startupClipQa.audio.currentTime>0.12&&!window.__startupClipQa.audio.paused);
    report.clipPlayback=await page.evaluate(()=>{const qa=window.__startupClipQa;return {file:qa.audio.src.split('/').at(-1),currentTime:qa.audio.currentTime,duration:qa.audio.duration,clickToPlayMs:qa.playedAt-qa.clickedAt,captures:qa.captures,peers:qa.peers};});assert.match(report.clipPlayback.file,/^cove-.*\.wav$/);assert.ok(report.clipPlayback.clickToPlayMs<1000);assert.equal(report.clipPlayback.captures,0);assert.equal(report.clipPlayback.peers,0);
    const methods=await clipApp.evaluate(()=>globalThis.__startupClipMethods);assert.ok(!methods.some(method=>/^voice\.realtime\.(?:preview\.|prepare$|start$)/.test(method)));report.clipPlayback.remotePreviewCalls=0;
    await page.getByRole('button',{name:'Stop realtime preview',exact:true}).click();await page.waitForFunction(()=>window.__startupClipQa.audio.paused&&window.__startupClipQa.audio.getAttribute('src')==='');report.clipPlayback.manualStopReleasedPlayer=true;report.clipPlayback.physicalAudibility='Unverified: test process output is muted.';
  }
  report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;report.stderr=stderr;process.exitCode=1;}
finally{
  await clipApp?.close().catch(()=>{});
  if(socket?.readyState===WebSocket.OPEN&&!closed)await evaluate("require('electron').app.quit()").catch(()=>{});
  socket?.close();if(child&&!closed){await Promise.race([once(child,'exit').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);if(!closed)child.kill();}
  try{report.profileProtection=await fixture.verify();}catch(error){report.passed=false;report.protectionError=error.message;process.exitCode=1;}
  await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}
