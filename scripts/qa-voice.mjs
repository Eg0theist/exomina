// Real renderer in hidden Electron, synthetic speech and model events. No microphone or accounts.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root=process.cwd(),output=path.resolve(process.argv[2]||'../Workspace/qa-voice-ui');await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:0},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Hidden Electron, real renderer, synthetic speech/model events; no personal accounts or microphone input',checks:{},errors:[]};let app;
try{
 app=await electron.launch({args:[path.join(root,'scripts','qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}'});
 const voiceEvent=async event=>{await page.waitForFunction(type=>window.__exominaPreviewVoice?.method===(type==='done'?'voice.speak':'voice.listen')&&document.querySelector('.voice-live')?.textContent.includes(type==='done'?'Speaking':'Listening'),event.type);return page.evaluate(value=>window.__exominaPreviewEmit({type:'voice.event',sessionId:window.__exominaPreviewVoice.sessionId,event:value}),event);};
 const callCount=method=>page.evaluate(name=>window.__exominaPreviewCalls.filter(call=>call.method===name).length,method);
 const message=page.getByLabel('Message',{exact:true});await message.fill('Typed beginning');
 await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('dialog',{name:'Voice options',exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'voice-options.png')});await page.locator('.sidebar').dispatchEvent('pointerdown');assert.equal(await page.getByRole('dialog',{name:'Voice options',exact:true}).count(),0);report.checks.clickAway=true;
 await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:/Dictate a message/}).click();await page.getByRole('button',{name:'Stop voice',exact:true}).waitFor();
 await voiceEvent({type:'transcript',text:'spoken ending'});await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]').value==='Typed beginning spoken ending');
 assert.equal(await callCount('chat.send'),0);report.checks.dictationKeepsDraftAndDoesNotSend=true;
 await page.getByRole('button',{name:'Stop voice',exact:true}).click();await page.getByRole('button',{name:'Voice options',exact:true}).waitFor();
 await message.fill('');await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:/Spoken replies/}).click();await page.getByRole('button',{name:'Stop voice',exact:true}).waitFor();
 await voiceEvent({type:'transcript',text:'Hello from a voice conversation'});
 await page.waitForFunction(()=>window.__exominaPreviewCalls.some(call=>call.method==='voice.speak'));
 assert.equal(await callCount('chat.send'),1);assert.equal(await message.inputValue(),'');
 const spoken=await page.evaluate(()=>window.__exominaPreviewCalls.findLast(call=>call.method==='voice.speak').payload.text);assert.ok(!spoken.includes('812 kB')&&!spoken.includes('```'));report.checks.newChatSendsAndSpeaksOnlyFinalProse=true;
 await page.screenshot({path:path.join(output,'speaking.png')});await voiceEvent({type:'done'});
 await page.waitForFunction(()=>window.__exominaPreviewVoice?.method==='voice.listen');report.checks.microphoneResumesAfterPlayback=true;
 await page.getByRole('button',{name:'Stop voice',exact:true}).click();const listens=await callCount('voice.listen');
 await page.getByRole('button',{name:'Read aloud',exact:true}).last().click();await page.getByRole('button',{name:'Stop voice',exact:true}).waitFor();await voiceEvent({type:'done'});await page.getByRole('button',{name:'Voice options',exact:true}).waitFor();
 assert.equal(await callCount('voice.listen'),listens);report.checks.readAloudDoesNotOpenMicrophone=true;
 await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:/Dictate a message/}).click();await page.getByRole('button',{name:'Stop voice',exact:true}).waitFor();
 await page.keyboard.press('Control+,');await page.locator('#settings-voice').scrollIntoViewIfNeeded();
 await page.getByLabel('Speech language',{exact:true}).selectOption('de-DE');await page.getByLabel('Pause before sending',{exact:true}).selectOption('2200');
 const settings=await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).settings.voice);assert.equal(settings.language,'de-DE');assert.equal(settings.silenceMs,2200);
 assert.equal(await page.evaluate(()=>window.__exominaPreviewVoice),null);report.checks.navigationStopsMicrophoneAndSettingsPersist=true;
 await page.screenshot({path:path.join(output,'settings.png')});
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
