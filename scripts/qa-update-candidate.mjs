// Required before a local Windows package is offered as an update. Exercise the
// exact executable with synthetic retained EFS data and legacy runtime entries.
import {createProtectedQaProfile} from './qa-profile.mjs';
import {prepareWindowsQaOwner} from './native-qa-windows-owner.mjs';
import {Store} from '../desktop/store.mjs';
import {WindowsVault} from '../desktop/vault.mjs';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {watchStartup} from './native-qa-startup.mjs';
if(process.platform!=='win32')throw Error('Local update candidate qualification currently requires Windows.');
await prepareWindowsQaOwner();
const build=path.resolve(process.argv[2]||''),stamp=JSON.parse(await readFile(path.join(build,'exomina.build.json'),'utf8'));
const require=createRequire(import.meta.url),{_electron}=require('playwright');
const fixture=await createProtectedQaProfile('update-candidate'),profile=fixture.profile,output=fixture.output;
const runtime=path.join(output,'synthetic-runtime'),workspace=path.join(profile,'workspace'),cache=path.join(output,'cache'),home=path.join(output,'home');
for(const directory of [runtime,workspace,cache,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(home,'Documents')])await mkdir(directory,{recursive:true});
const recovery=await readFile(profile+'.setup/recovery-backup.json','utf8'),proof={recoveryThumbprint:JSON.parse(recovery).thumbprint};
const vault=new WindowsVault();await vault.protect(runtime,proof);vault.close();
await writeFile(path.join(cache,'sentinel.txt'),'Synthetic legacy runtime cache');await symlink(cache,path.join(runtime,'legacy-cache'),'junction');
const store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,autoUpdate:false,autoTitle:false,closeToTray:false,quickAccess:false,attentionNotifications:false,memoryEnabled:false,chatMemoryEnabled:false,chatMemoryBackfill:false,chatMemorySummaries:false,browserEnabled:false,desktopEnabled:false,toolUpdates:{checkAutomatically:false,automatic:false,automaticConnections:false},externalMcpServers:[]});
const chat=store.create('codex');chat.title='Synthetic retained update conversation';chat.messages=[{id:'synthetic-message',role:'user',content:'Synthetic retained update data'}];await store.save();
const env={...process.env,EXOMINA_WINDOWS_INDEPENDENT:randomUUID(),EXOMINA_STARTUP_DIAGNOSTICS:'1',EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:runtime,EXOMINA_WORKSPACE_DIR:workspace,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),TEMP:output,TMP:output,TMPDIR:output};
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization|^(NODE_OPTIONS|BUN_OPTIONS|ELECTRON_RUN_AS_NODE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(key))delete env[key];
let app,report={at:new Date().toISOString(),buildId:stamp.id,version:stamp.version,passed:false,scope:'Exact candidate executable, fresh synthetic retained EFS profile and legacy runtime junction; no real account store, sign-in, inference or personal profile access.'};
try{
  app=await _electron.launch({executablePath:path.join(build,'Exomina.exe'),args:['--mute-audio'],env,timeout:30000});
  const guard=watchStartup(app.process()),page=await guard.race(app.firstWindow());page.setDefaultTimeout(15000);
  await guard.race(page.locator('.app-shell').waitFor());
  const state=await guard.race(page.evaluate(()=>window.studio.invoke('security.status')));
  assert.equal(state.ready,true);assert.equal(state.mode,'efs');assert.equal(state.folderEncrypted,true);
  const retained=await page.evaluate(id=>window.studio.invoke('conversations.get',{id}),chat.id);
  assert.equal(retained.messages[0].content,'Synthetic retained update data');
  const responsive=await page.evaluate(()=>document.readyState==='complete'&&!!document.querySelector('#root .app-shell'));assert.equal(responsive,true);
  report.checks={legacyEfsWorkspaceOpened:true,retainedConversation:true,responsiveRenderer:true,noRecoveryOrSetupPrompt:true};report.passed=true;
}catch(error){report.error=error.message;}
finally{if(app)await app.close();}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(profile+'.setup/recovery-backup.json')),hash(Buffer.from(recovery)));
assert.equal(await readFile(path.join(cache,'sentinel.txt'),'utf8'),'Synthetic legacy runtime cache');
report.recoveryAndCacheUnchanged=true;
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report}));if(!report.passed)process.exitCode=1;
