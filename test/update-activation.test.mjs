import test from 'node:test';
import assert from 'node:assert/strict';
import {finishActivation} from '../desktop/update-activation.cjs';

function fixture(){
  const attemptId='12345678-1234-4234-8234-123456789012',buildId='synthetic-build',control={attemptId,buildId,monitored:true,pid:123,token:'a'.repeat(32)},files=new Map(),opened=[];
  let time=0,helperAlive=true;
  const options={attemptId,buildId,control,read:name=>files.get(name),write:(name,value)=>files.set(name,value),alive:()=>helperAlive,open:async()=>opened.push('canonical App'),now:()=>time,wait:async ms=>{time+=ms;},timeoutMs:1000};
  return {options,files,opened,stop:()=>helperAlive=false,verdict:(status,extra={})=>files.set('update-activation.json',{schema:1,...control,status,...extra})};
}
test('file copy alone never counts as a successful installation',async()=>{
  const f=fixture();f.stop();const result=await finishActivation(f.options);assert.equal(result.status,'failed');assert.equal(f.opened.length,0);
});
test('only matching healthy startup completes installation',async()=>{
  const f=fixture();f.verdict('healthy');const result=await finishActivation(f.options);assert.equal(result.status,'installed');assert.equal(f.opened.length,0);
  for(const extra of [{token:'b'.repeat(32)},{attemptId:'stale'},{buildId:'old-build'},{schema:2}]){
    const stale=fixture();stale.verdict('healthy',extra);assert.equal((await finishActivation(stale.options)).status,'failed');
  }
});
test('rollback reopens only the restored normal App and records failure of the new build',async()=>{
  const f=fixture();f.verdict('rolled-back',{message:'Previous program restored'});const result=await finishActivation(f.options);
  assert.equal(result.status,'rolled-back');assert.deepEqual(f.opened,['canonical App']);assert.equal(f.files.get('last-update.json').buildId,f.options.buildId);
});
test('helper crashes and timeouts never race another launch against program replacement',async()=>{
  for(const stopped of [true,false]){
    const f=fixture();if(stopped)f.stop();const result=await finishActivation(f.options);assert.equal(result.status,'failed');assert.equal(f.opened.length,0);
  }
});
test('recovery failure is reported truthfully and a failed automatic reopen leaves the restored shortcut usable',async()=>{
  const f=fixture();f.verdict('recovery-failed',{message:'Both programs preserved'});assert.equal((await finishActivation(f.options)).status,'failed');assert.equal(f.opened.length,0);
  f.verdict('rolled-back');f.options.open=async()=>{throw Error('Windows refused launch');};const result=await finishActivation(f.options);assert.equal(result.status,'rolled-back');assert.match(result.message,/normal shortcut/);
});
test('helper death reopens the preserved previous copy through the bounded fallback',async()=>{
  const f=fixture();f.stop();let recovered=0;f.options.recover=async()=>{recovered++;};
  assert.equal((await finishActivation(f.options)).status,'recovery-opened');assert.equal(recovered,1);
});
test('a helper that is still renaming programs is never raced by emergency fallback',async()=>{
  const f=fixture();f.options.recover=async()=>assert.fail('live helper must finish first');assert.equal((await finishActivation(f.options)).status,'failed');
});
test('a verdict written on helper exit is read before deciding recovery failed',async()=>{
  const f=fixture();f.options.alive=()=>{f.verdict('healthy');return false;};assert.equal((await finishActivation(f.options)).status,'installed');
});
