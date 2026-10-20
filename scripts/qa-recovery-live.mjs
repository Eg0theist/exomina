import {_electron} from 'playwright';
import http from 'node:http';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {WindowsVault} from '../desktop/vault.mjs';
import {createProtectedQaProfile} from './qa-profile.mjs';
const fixture=await createProtectedQaProfile('recovery-live'),profile=path.join(fixture.profile,'setup-profile'),temporary=path.join(fixture.profile,'runtime-tmp');await mkdir(profile);await mkdir(temporary);
const source=await readFile(path.resolve('scripts/qa-vault-fixture.cjs'),'utf8'),entry=path.join(fixture.output,'synthetic-live-fixture.cjs');await writeFile(entry,source.replace("app.whenReady().then",`app.setPath('temp',process.env.TEMP);app.setPath('crashDumps',path.join(process.env.TEMP,'crash-dumps'));app.setAppLogsPath(path.join(process.env.TEMP,'logs'));app.whenReady().then`));
const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>Synthetic recovery profile</title><input>');});server.listen(0,'127.0.0.1');await once(server,'listening');
const env={...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary,EXOMINA_QA_VAULT_PROFILE:profile,EXOMINA_QA_VAULT_URL:`http://127.0.0.1:${server.address().port}`};delete env.ELECTRON_RUN_AS_NODE;let app;
try{app=await _electron.launch({args:[entry],env,timeout:30000});let ready;for(let n=0;n<100;n++){ready=await app.evaluate(()=>globalThis.vaultQa);if(ready?.ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready?.ready);
 const vault=new WindowsVault(),checks=[];for(let n=0;n<3;n++){const check=await vault.verify(fixture.profile);assert.equal(check.encrypted,true);assert.equal(check.restrictedAccess,true);checks.push(check);}
 await app.close();app=null;const closed=await vault.verify(fixture.profile);assert.equal(closed.encrypted,true);assert.equal(closed.restrictedAccess,true);const report={syntheticOnly:true,probe:fixture.profile,appReady:true,liveChecks:checks,closed};await writeFile(path.join(fixture.output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve));}
