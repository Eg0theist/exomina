import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verificationPlan} from '../scripts/check-changes.mjs';
test('test planning traces transitive imports and resource reads, falls back for shared/unknown code, and flags UI limits',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'exomina-check-plan-'));
 try{
  for(const dir of ['desktop','src','test'])await mkdir(path.join(root,dir));
  const files={'desktop/leaf.mjs':'export const a=1;','desktop/bridge.mjs':"export {a} from './leaf.mjs';",'test/leaf.test.mjs':"import '../desktop/bridge.mjs';",'test/resource.test.mjs':"new URL('../desktop/leaf.mjs',import.meta.url)",'test/other.test.mjs':'','src/panel.jsx':"import '../desktop/bridge.mjs';"};
  for(const [file,text] of Object.entries(files))await writeFile(path.join(root,file),text,'utf8');
  const targeted=await verificationPlan(root,['desktop/leaf.mjs']);assert.equal(targeted.mode,'targeted');assert.deepEqual(targeted.tests,['test/leaf.test.mjs','test/resource.test.mjs']);assert.equal(targeted.build,true);
  assert.equal((await verificationPlan(root,['desktop/main.mjs'])).mode,'full');assert.equal((await verificationPlan(root,['unknown-data.json'])).mode,'full');
  await writeFile(path.join(root,'desktop/orphan.mjs'),'','utf8');assert.equal((await verificationPlan(root,['desktop/leaf.mjs','desktop/orphan.mjs'])).mode,'full');
  const ui=await verificationPlan(root,['src/panel.jsx']);assert.equal(ui.build,true);assert.match(ui.limitations[0],/GUI/);
  await assert.rejects(verificationPlan(root,['../outside.mjs']),/inside Source/);
 }finally{await rm(root,{recursive:true,force:true});}
});
