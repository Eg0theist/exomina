import test from 'node:test';
import assert from 'node:assert/strict';
import {beginSettingsTransaction} from '../desktop/runtime-settings-transaction.mjs';
import {validateAppearance,resolveTheme} from '../desktop/themes.mjs';

test('failed save restores changed fields and persists rollback once',async()=>{
  const settings={appearance:{textSize:'default'},quickAccess:false},tx=beginSettingsTransaction(settings,{appearance:{textSize:'large'},quickAccess:true});settings.appearance={textSize:'large'};settings.quickAccess=true;
  let saves=0,notices=0;assert.deepEqual(await tx.rollback({persist:async()=>saves++,onRestore:()=>notices++}),{restored:2,preserved:0});assert.deepEqual(settings,{appearance:{textSize:'default'},quickAccess:false});assert.equal(saves,1);assert.equal(notices,1);
});
test('later unrelated edits in the same object survive rollback',async()=>{
  const settings={appearance:{textSize:'default',motion:'system'}},first=beginSettingsTransaction(settings,{appearance:{textSize:'large'}});settings.appearance={...settings.appearance,textSize:'large'};
  const second=beginSettingsTransaction(settings,{appearance:{motion:'reduced'}});settings.appearance={...settings.appearance,motion:'reduced'};second.commit();await first.rollback();assert.deepEqual(settings.appearance,{textSize:'default',motion:'reduced'});
});
test('later edits to the same field are preserved even when the user chose the same value',async()=>{
  for(const next of ['large','xl']){
    const settings={appearance:{textSize:'default'}},first=beginSettingsTransaction(settings,{appearance:{textSize:'large'}});settings.appearance.textSize='large';
    const second=beginSettingsTransaction(settings,{appearance:{textSize:next}});settings.appearance.textSize=next;second.commit();assert.equal((await first.rollback()).preserved,1);assert.equal(settings.appearance.textSize,next);
  }
});
test('a failed later validation releases field ownership so the older failed save can roll back',async()=>{
  const settings={quickAccess:false},first=beginSettingsTransaction(settings,{quickAccess:true});settings.quickAccess=true;
  const second=beginSettingsTransaction(settings,{quickAccess:'invalid'});await second.rollback();await first.rollback();assert.equal(settings.quickAccess,false);
});
test('nested replacement and voicePatch aliases preserve later user changes',async()=>{
  const settings={voice:{voice:'one',enabled:false}},first=beginSettingsTransaction(settings,{voicePatch:{voice:'two'}});settings.voice.voice='two';
  const second=beginSettingsTransaction(settings,{voice:{voice:'three',enabled:true}});settings.voice={voice:'three',enabled:true};second.commit();await first.rollback();assert.deepEqual(settings.voice,{voice:'three',enabled:true});
});
test('commit prevents rollback; rollback failures remain visible and prototype fields fail closed',async()=>{
  const settings={quickAccess:false},first=beginSettingsTransaction(settings,{quickAccess:true});settings.quickAccess=true;first.commit();assert.equal((await first.rollback()).restored,0);
  const second=beginSettingsTransaction(settings,{quickAccess:false});settings.quickAccess=false;await assert.rejects(second.rollback({persist:async()=>{throw Error('disk still unavailable');}}),/disk still unavailable/);assert.equal(settings.quickAccess,true);
  assert.throws(()=>beginSettingsTransaction(settings,JSON.parse('{"appearance":{"__proto__":{"polluted":true}}}')),/Invalid/);assert.equal({}.polluted,undefined);
});
test('failed theme save restores its cleared custom palette and preserves a later explicit palette choice',async()=>{
 const palette={baseTheme:'verdigris',colors:{accent:'#bceacf'}},initial=validateAppearance({theme:'verdigris',customPalette:palette},{});
 const settings={appearance:initial},first=beginSettingsTransaction(settings,{appearance:{theme:'paper'}});settings.appearance=validateAppearance({theme:'paper'},settings.appearance);assert.equal(settings.appearance.customPalette,null);await first.rollback();assert.equal(settings.appearance.theme,'verdigris');assert.deepEqual(settings.appearance.customPalette,palette);
 const older=beginSettingsTransaction(settings,{appearance:{theme:'paper'}});settings.appearance=validateAppearance({theme:'paper'},settings.appearance);const chosen={baseTheme:'paper',colors:{accent:resolveTheme(settings.appearance).colors.accent}},newer=beginSettingsTransaction(settings,{appearance:{customPalette:chosen}});settings.appearance=validateAppearance({customPalette:chosen},settings.appearance);newer.commit();await older.rollback();assert.equal(settings.appearance.theme,'paper');assert.deepEqual(settings.appearance.customPalette,chosen);
});
