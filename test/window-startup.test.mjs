import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openExominaLocation} from '../desktop/window-startup.mjs';

const url='file:///synthetic/dist/index.html';
const abort=()=>Object.assign(Error("ERR_ABORTED (-3) loading '"+url+"'"),{code:'ERR_ABORTED'});
function fixture(load){
  const contents=new EventEmitter(),window=new EventEmitter(),shutdown=new EventEmitter();let location='',loading=false,destroyed=false,calls=0;
  Object.assign(contents,{isDestroyed:()=>destroyed,getURL:()=>location,isLoadingMainFrame:()=>loading});
  Object.assign(window,{webContents:contents,isDestroyed:()=>destroyed,loadURL:()=>load(++calls,controls)});
  const controls={window,contents,shutdown,get calls(){return calls;},start(next=url){loading=true;contents.emit('did-start-navigation',{},next,false,true);},finish(next=url){loading=false;location=next;contents.emit('did-finish-load');},finishBeforeLoadingStops(next=url){location=next;contents.emit('did-finish-load');setTimeout(()=>{loading=false;contents.emit('did-stop-loading');},10);},committedButUnfinished(){location=url;loading=false;contents.emit('did-stop-loading');},fail(code,description){loading=false;contents.emit('did-fail-load',{},code,description,url,true);},close(){destroyed=true;contents.emit('destroyed');window.emit('closed');}};
  return controls;
}
function assertDetached(value){for(const name of ['did-start-navigation','did-finish-load','did-stop-loading','did-fail-load','destroyed'])assert.equal(value.contents.listenerCount(name),0);assert.equal(value.window.listenerCount('closed'),0);assert.equal(value.shutdown.listenerCount('before-quit'),0);}

test('healthy startup resolves once and removes lifecycle observers',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.finish();return Promise.resolve();});assert.equal(await openExominaLocation(value.window,url,{shutdown:value.shutdown}),true);assert.equal(value.calls,1);assertDetached(value);
});
test('a completed same-page replacement recovers the cancelled initial promise',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.start();qa.finish();return Promise.reject(abort());});assert.equal(await openExominaLocation(value.window,url),true);assert.equal(value.calls,1);assertDetached(value);
});
test('startup waits for a pending same-page replacement instead of quitting',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.start();setTimeout(()=>qa.finish(),15);return Promise.reject(abort());});assert.equal(await openExominaLocation(value.window,url),true);assert.equal(value.calls,1);assertDetached(value);
});
test('Electron finish-before-stop event order recovers promptly without a retry',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.start();setTimeout(()=>qa.finishBeforeLoadingStops(),10);return Promise.reject(abort());});assert.equal(await openExominaLocation(value.window,url,{timeoutMs:300}),true);assert.equal(value.calls,1);assertDetached(value);
});
test('an abort without an observed replacement remains a real failure',async()=>{
  const error=abort(),value=fixture((_call,qa)=>{qa.start();return Promise.reject(error);});await assert.rejects(openExominaLocation(value.window,url),error);assert.equal(value.calls,1);assertDetached(value);
});
test('a different main-frame destination cannot use the recovery path',async()=>{
  const error=abort(),value=fixture((_call,qa)=>{qa.start();qa.start('https://untrusted.example/');qa.finish('https://untrusted.example/');return Promise.reject(error);});await assert.rejects(openExominaLocation(value.window,url),error);assert.equal(value.calls,1);assertDetached(value);
});
test('a replacement file failure remains fatal and is reported accurately',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.start();setTimeout(()=>qa.fail(-6,'ERR_FILE_NOT_FOUND'),10);return Promise.reject(abort());});await assert.rejects(openExominaLocation(value.window,url),/ERR_FILE_NOT_FOUND \(-6\)/);assert.equal(value.calls,1);assertDetached(value);
});
test('a stalled observed replacement gets one bounded retry of the trusted page',async()=>{
  const value=fixture((call,qa)=>{if(call===1){qa.start();qa.start();return Promise.reject(abort());}qa.start();qa.finish();return Promise.resolve();});assert.equal(await openExominaLocation(value.window,url,{timeoutMs:160}),true);assert.equal(value.calls,2);assertDetached(value);
});
test('stopping a committed replacement without finishing does not count as success',async()=>{
  const value=fixture((call,qa)=>{if(call===1){qa.start();qa.start();qa.committedButUnfinished();return Promise.reject(abort());}qa.start();qa.finish();return Promise.resolve();});assert.equal(await openExominaLocation(value.window,url,{timeoutMs:160}),true);assert.equal(value.calls,2);assertDetached(value);
});
test('repeated replacement cancellation stops within the recovery budget',async()=>{
  const value=fixture((_call,qa)=>{qa.start();qa.start();return Promise.reject(abort());});const started=Date.now();await assert.rejects(openExominaLocation(value.window,url,{timeoutMs:120}),/ERR_ABORTED|did not finish loading/);assert.equal(value.calls,2);assert.ok(Date.now()-started<1000);assertDetached(value);
});
test('closing the startup window resolves as cancellation without a fatal error',async()=>{
  const value=fixture((_call,qa)=>{qa.start();setTimeout(()=>qa.close(),10);return new Promise(()=>{});});assert.equal(await openExominaLocation(value.window,url),false);assertDetached(value);
});
test('intentional app shutdown cancels startup even while the window remains alive',async()=>{
  let quitting=false;const value=fixture((_call,qa)=>{qa.start();setTimeout(()=>{quitting=true;qa.shutdown.emit('before-quit');},10);return new Promise(()=>{});});assert.equal(await openExominaLocation(value.window,url,{shutdown:value.shutdown,isShuttingDown:()=>quitting}),false);assertDetached(value);
});
test('other load failures and unexpected successful locations remain fatal',async()=>{
  const error=Error('ERR_FILE_NOT_FOUND (-6)'),missing=fixture(()=>Promise.reject(error));await assert.rejects(openExominaLocation(missing.window,url),error);assertDetached(missing);
  const different=fixture((_call,qa)=>{qa.finish('file:///different.html');return Promise.resolve();});await assert.rejects(openExominaLocation(different.window,url),/unexpected location/);assertDetached(different);
});
