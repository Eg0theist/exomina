import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {UI_SCALES,installUiZoom,normalizeUiScale} from '../desktop/ui-zoom.mjs';
import {libraryRestoreLauncher} from '../desktop/library-launcher.mjs';

test('interface zoom accepts supported sizes and rejects unbounded input',()=>{
  for(const scale of UI_SCALES)assert.equal(normalizeUiScale(scale),scale);
  for(const scale of [0,4,-1,'1.5',NaN,null])assert.equal(normalizeUiScale(scale),1);
});
test('keyboard zoom persists a changed size and resets without intercepting ordinary text',async()=>{
  const wc=new EventEmitter(),applied=[];wc.setZoomFactor=scale=>applied.push(scale);
  let scale=1,prevented=0;
  installUiZoom({webContents:wc},{getScale:()=>scale,onChange:async next=>{scale=next;}});
  const key=(key,control=true)=>wc.emit('before-input-event',{preventDefault:()=>prevented++},{type:'keyDown',key,control});
  key('+',false);assert.equal(prevented,0);
  key('+');await new Promise(r=>setImmediate(r));assert.equal(scale,1.1);assert.equal(applied.at(-1),1.1);
  key('0');await new Promise(r=>setImmediate(r));assert.equal(scale,1);
  scale=1.5;key('+');await new Promise(r=>setImmediate(r));assert.equal(scale,1.5);
  wc.emit('did-finish-load');assert.equal(applied.at(-1),1.5);
});
test('restored libraries receive native launchers with quoted paths and isolated profile variables',()=>{
  const data={target:"/synthetic/owner's library",workspace:"/synthetic/$(literal)/work",executable:"/synthetic/Exomina's app/exomina"};
  for(const platform of ['darwin','linux']){
    const launcher=libraryRestoreLauncher({...data,platform});
    assert.equal(launcher.mode,0o700);assert.ok(launcher.name.endsWith(platform==='darwin'?'.command':'.sh'));
    assert.ok(launcher.text.includes("owner'\\''s library"));assert.ok(launcher.text.includes("'/synthetic/$(literal)/work'"));
    assert.match(launcher.text,/export EXOMINA_ACCOUNTS_DIR=/);assert.match(launcher.text,/exec .+ "\$@"/);
  }
  const windows=libraryRestoreLauncher({...data,platform:'win32'});assert.match(windows.text,/owner''s library/);assert.match(windows.text,/-WindowStyle Normal/);
  assert.throws(()=>libraryRestoreLauncher({...data,platform:'other'}),/support/);
});
