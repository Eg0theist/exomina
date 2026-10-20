import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Updater} from '../desktop/updates.mjs';

async function fixture(){
  const home=await mkdtemp(path.join(tmpdir(),'exomina-program-health-')),appDir=path.join(home,'App'),stateDir=path.join(home,'state');
  await Promise.all([mkdir(appDir),mkdir(stateDir)]);
  await writeFile(path.join(appDir,'exomina.build.json'),JSON.stringify({id:'new-build-identity'}));
  const now=Date.now(),challenge={schema:1,token:'a'.repeat(32),buildId:'new-build-identity',createdAt:new Date(now-5000).toISOString(),expiresAt:new Date(now+175000).toISOString()};
  await writeFile(path.join(stateDir,'program-cleanup-pending.json'),JSON.stringify(challenge));
  return {home,appDir,stateDir,now,challenge,updater:new Updater({packaged:true,home,appDir,stateDir}),cleanup:()=>rm(home,{recursive:true,force:true})};
}
test('startup confirmation contains only the current build, exact handoff and process identity',async()=>{
  const f=await fixture();try{
    assert.equal(await f.updater.confirmStartup({now:f.now,pid:123,rendererPid:124}),true);
    const value=JSON.parse(await readFile(path.join(f.stateDir,'program-cleanup-health.json'),'utf8'));
    assert.deepEqual(value,{schema:1,token:f.challenge.token,buildId:f.challenge.buildId,pid:123,rendererPid:124,ready:true,readyAt:new Date(f.now).toISOString()});
  }finally{await f.cleanup();}
});
test('startup confirmation refuses stale, malformed and different-build challenges',async()=>{
  const f=await fixture();try{
    for(const change of [{token:'old'},{buildId:'old-build-identity'},{expiresAt:new Date(f.now).toISOString()},{createdAt:new Date(f.now+1).toISOString()},{expiresAt:new Date(f.now+190000).toISOString()},{schema:2}]){
      await writeFile(path.join(f.stateDir,'program-cleanup-pending.json'),JSON.stringify({...f.challenge,...change}));
      assert.equal(await f.updater.confirmStartup({now:f.now,rendererPid:124}),false);
    }
    assert.equal(await readFile(path.join(f.stateDir,'program-cleanup-health.json'),'utf8').catch(()=>null),null);
  }finally{await f.cleanup();}
});
test('development and alternate app copies cannot confirm an installed update',async()=>{
  const f=await fixture();try{
    f.updater.packaged=false;assert.equal(await f.updater.confirmStartup(),false);
    f.updater.packaged=true;f.updater.appDir=path.join(f.home,'App.previous-older');assert.equal(await f.updater.confirmStartup(),false);
  }finally{await f.cleanup();}
});
