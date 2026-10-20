// Real renderer and WebRTC, two local peers with generated tones, no microphone/account.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve(process.argv[2]||'../Workspace/qa-realtime/ui');await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:0},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Hidden real renderer and Chromium WebRTC; local generated tones, muted audio output; no microphone, accounts or cloud inference',checks:{},errors:[]};let app,page;
async function waitForAudioStats(side,predicate) {
  const peer=await page.evaluateHandle(side=>side==='client'?window.__voiceQaClientPeer:window.__exominaPreviewRealtime.peer,side),deadline=Date.now()+15000;
  try {
    while(Date.now()<deadline) {
      const stats=await peer.evaluate(async peer=>{
        const reports=[...(await peer.getStats()).values()],incoming=reports.filter(stat=>stat.type==='inbound-rtp'&&stat.kind==='audio'),outgoing=reports.filter(stat=>stat.type==='outbound-rtp'&&stat.kind==='audio');
        return {receivedPackets:incoming.reduce((sum,stat)=>sum+(stat.packetsReceived||0),0),receivedBytes:incoming.reduce((sum,stat)=>sum+(stat.bytesReceived||0),0),receivedEnergy:incoming.reduce((sum,stat)=>sum+(stat.totalAudioEnergy||0),0),receivedDuration:incoming.reduce((sum,stat)=>sum+(stat.totalSamplesDuration||0),0),sentPackets:outgoing.reduce((sum,stat)=>sum+(stat.packetsSent||0),0),sentBytes:outgoing.reduce((sum,stat)=>sum+(stat.bytesSent||0),0),clientOutbound:outgoing.length};
      });
      if(predicate(stats))return stats;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Timed out waiting for '+side+' audio RTP statistics.');
  } finally {await peer.dispose();}
}
try {
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(()=>window.studio.invoke('settings.save',{provider:'codex',model:'auto'}));
  await page.evaluate(()=>{
    const NativePeer=window.RTCPeerConnection;
    window.RTCPeerConnection=class extends NativePeer {
      createDataChannel(...args){window.__voiceQaClientPeer=this;return super.createDataChannel(...args);}
    };
  });
  await page.evaluate(()=>{window.__voiceCaptureCount=0;Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async constraints=>{window.__voiceCaptureCount++;window.__voiceCaptureConstraints=constraints;const context=new AudioContext(),osc=context.createOscillator(),destination=context.createMediaStreamDestination();osc.frequency.value=440;osc.connect(destination);osc.start();window.__voiceQaCapture={context,stream:destination.stream};return destination.stream;}});});
  await page.getByLabel('Message',{exact:true}).fill('');
  await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:/Realtime ChatGPT/}).click();
  await page.getByRole('button',{name:'Stop voice',exact:true}).waitFor();
  await page.waitForFunction(()=>window.__exominaPreviewRealtime?.peer?.connectionState==='connected'&&window.__exominaPreviewRealtime?.channel?.readyState==='open');
  await waitForAudioStats('remote',stats=>stats.receivedBytes>0&&stats.sentBytes>0);
  const state=await page.evaluate(()=>({constraints:window.__voiceCaptureConstraints,receivedAudio:window.__exominaPreviewRealtime.receivedAudio,microphoneLive:window.__voiceQaCapture.stream.getAudioTracks()[0].readyState}));
  assert.equal(state.constraints.video,false);assert.equal(state.receivedAudio,true);assert.equal(state.microphoneLive,'live');report.checks.realWebrtcCarriesAudioBetweenLocalPeers=true;
  await page.evaluate(()=>window.__exominaPreviewRealtime.channel.send(JSON.stringify({type:'transcript.delta',role:'user',delta:'My spoken question.'})));
  await page.locator('.voice-status p').filter({hasText:'My spoken question.'}).waitFor();
  await page.evaluate(()=>window.__exominaPreviewRealtime.channel.send(JSON.stringify({type:'transcript.done',role:'user',text:'My spoken question.'})));
  await page.waitForFunction(()=>[...document.querySelectorAll('.message')].some(message=>message.textContent.includes('My spoken question.')));
  await page.evaluate(()=>{const channel=window.__exominaPreviewRealtime.channel,event={type:'response.output_audio_transcript.done',item_id:'spoken-answer',transcript:'My spoken answer.'};channel.send(JSON.stringify(event));channel.send(JSON.stringify(event));});
  await page.waitForFunction(()=>[...document.querySelectorAll('.message')].some(message=>message.textContent.includes('My spoken answer.')));
  const transcripts=await page.evaluate(async()=>{const bootstrap=await window.studio.invoke('bootstrap');return bootstrap.conversations.find(chat=>chat.id===window.__exominaPreviewRealtime.conversationId).messages.filter(message=>message.voice==='realtime');});assert.deepEqual(transcripts.map(message=>[message.role,message.content]),[['user','My spoken question.'],['assistant','My spoken answer.']]);report.checks.rawDataChannelCaptionsAndBothCompletedTranscriptsPersistOnce=true;
  await page.evaluate(()=>window.__exominaPreviewRealtime.channel.send(JSON.stringify({type:'output_audio_buffer.started'})));
  await page.getByRole('button',{name:'Interrupt',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__voiceQaCapture.stream.getAudioTracks()[0].enabled),true);report.checks.microphoneRemainsOnDuringStreamedReply=true;
  await page.getByRole('button',{name:'Mute microphone',exact:true}).click();assert.equal(await page.evaluate(()=>window.__voiceQaCapture.stream.getAudioTracks()[0].enabled),false);
  await page.getByRole('button',{name:'Unmute microphone',exact:true}).click();assert.equal(await page.evaluate(()=>window.__voiceQaCapture.stream.getAudioTracks()[0].enabled),true);report.checks.muteControlsActualAudioTrack=true;
  await page.getByRole('button',{name:'Interrupt',exact:true}).click();await page.waitForFunction(()=>window.__exominaPreviewRealtime.controls?.some(event=>event.type==='output_audio_buffer.clear'));
  report.checks.interruptionReachesRemoteDataChannel=true;
  await page.evaluate(()=>window.__exominaPreviewRealtime.channel.send(JSON.stringify({type:'output_audio_buffer.started'})));await page.getByRole('button',{name:'Interrupt',exact:true}).waitFor();
  await page.evaluate(()=>window.__exominaPreviewRealtime.channel.send(JSON.stringify({type:'input_audio_buffer.speech_started'})));
  await page.waitForFunction(()=>window.__exominaPreviewRealtime.controls.filter(event=>event.type==='output_audio_buffer.clear').length===2);report.checks.spokenInterruptionSignalClearsPlayback=true;
  await page.screenshot({path:path.join(output,'realtime.png')});
  await page.getByRole('button',{name:'Stop voice',exact:true}).click();await page.getByRole('button',{name:'Voice options',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__voiceQaCapture.stream.getAudioTracks()[0].readyState),'ended');await page.waitForFunction(()=>window.__exominaPreviewRealtime.stopped&&window.__exominaPreviewRealtime.peer.connectionState==='closed');report.checks.stopClosesMicrophoneAndPeer=true;
  await page.getByRole('button',{name:'Voice options',exact:true}).click();await page.getByRole('button',{name:/Realtime ChatGPT/}).click();await page.waitForFunction(()=>window.__exominaPreviewRealtime?.peer?.connectionState==='connected');
  await page.keyboard.press('Control+,');await page.waitForFunction(()=>window.__exominaPreviewRealtime?.stopped);assert.equal(await page.evaluate(()=>window.__voiceQaCapture.stream.getAudioTracks()[0].readyState),'ended');report.checks.navigationClosesRealtimeVoice=true;
  report.previewVerification='Prerecorded Settings/chat samples are covered by qa-voice-preview-clips.mjs.';assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page){report.visibleErrors=await page.locator('[role="alert"]').allTextContents().catch(()=>[]);report.settings=await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).settings.voice).catch(()=>null);await page.screenshot({path:path.join(output,'failed-ui.png')}).catch(()=>{});}}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
