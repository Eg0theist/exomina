import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {nativeScopeLive,assertNativeScope} from '../desktop/native-tool-scope.mjs';
test('scope is absent for ordinary host calls and fail-closed for malformed native capabilities',()=>{
  assert.equal(nativeScopeLive(),true);for(const scope of [{},{isActive:true},{isActive:()=>1},{isActive:()=>{throw Error('gone')}}])assert.equal(nativeScopeLive(scope),false);
});
test('revocation during a pending approval stops the originating call and leaves another call scoped',async()=>{
  const contexts=new AsyncLocalStorage();let childLive=true,release;const pending=new Promise(resolve=>release=resolve);
  const child=contexts.run({nativeScope:{isActive:()=>childLive}},async()=>{assertNativeScope(contexts.getStore().nativeScope);await pending;assertNativeScope(contexts.getStore().nativeScope);return 'dispatched';});
  const root=contexts.run({},async()=>{await pending;assertNativeScope(contexts.getStore().nativeScope);return 'root allowed';});
  childLive=false;release();await assert.rejects(child,/originating/);assert.equal(await root,'root allowed');
});
