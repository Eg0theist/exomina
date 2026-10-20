import {_electron as electron} from 'playwright';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const output=path.resolve('../Workspace/qa-realtime/media-permissions');await mkdir(output,{recursive:true});await writeFile(path.join(output,'page.html'),'<!doctype html><title>Voice permission QA</title><p>Synthetic media only.</p>');
const env={...process.env,EXOMINA_MEDIA_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;const report={scope:'Hidden isolated Electron, Chromium fake microphone/camera devices; no hardware audio or accounts',checks:{},errors:[]};let app;
try{
  app=await electron.launch({args:[path.resolve('scripts/qa-media-permissions-main.cjs')],env,timeout:30000});const page=await app.firstWindow();
  const capture=constraints=>page.evaluate(async constraints=>{try{const stream=await navigator.mediaDevices.getUserMedia(constraints);const types=stream.getTracks().map(track=>track.kind);stream.getTracks().forEach(track=>track.stop());return {granted:true,types};}catch(error){return {granted:false,error:error.name};}},constraints);
  assert.equal((await capture({audio:true,video:false})).granted,false);report.checks.unarmedMicrophoneDenied=true;
  await app.evaluate(()=>{global.qaMedia.armed=true;});const audio=await capture({audio:true,video:false});assert.deepEqual(audio,{granted:true,types:['audio']});report.checks.realChromiumAudioPermissionDetailsAccepted=true;
  assert.equal((await capture({video:true,audio:false})).granted,false);report.checks.cameraDenied=true;
  await app.evaluate(()=>{global.qaMedia.visible=false;});assert.equal((await capture({audio:true,video:false})).granted,false);report.checks.backgroundCaptureDenied=true;
  report.calls=await app.evaluate(()=>global.qaMedia.calls);report.passed=true;
}catch(error){report.error=error.stack;report.passed=false;process.exitCode=1;report.calls=await app?.evaluate(()=>global.qaMedia?.calls).catch(()=>[]);}
finally{await app?.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
