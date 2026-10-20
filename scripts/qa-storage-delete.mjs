// Hidden real host and production renderer, real metadata worker, synthetic data only.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,utimes} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {access} from 'node:fs/promises';
const fileExists=file=>access(file).then(()=>true,()=>false);
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packageRoot=process.env.EXOMINA_QA_PACKAGE_DIR;
const runtime=packageRoot?path.join(packageRoot,'resources/app.asar'):project,host=packageRoot?runtime+'.unpacked':project;
const fixture=await createProtectedQaProfile('storage-delete'),{profile,output}=fixture;
const workspace=path.join(output,'workspace'),accounts=path.join(profile,'accounts'),volumeA=path.join(workspace,'drive-a'),volumeB=path.join(workspace,'drive-b');
await mkdir(volumeA,{recursive:true});await mkdir(volumeB);await mkdir(accounts);
for(const [folder,size] of [['Applications',1024],['Media',4096],['Projects',2048]]){await mkdir(path.join(volumeA,folder));await writeFile(path.join(volumeA,folder,'example.bin'),Buffer.alloc(size));}
await mkdir(path.join(volumeA,'Projects','node_modules','pkg'),{recursive:true});await writeFile(path.join(volumeA,'Projects','node_modules','pkg','index.js'),Buffer.alloc(40000));
const oldMovie=path.join(volumeA,'Media','old-movie.mp4'),threeYears=new Date(Date.now()-3*365*86400000);await writeFile(oldMovie,Buffer.alloc(120000));await utimes(oldMovie,threeYears,threeYears);
await mkdir(path.join(volumeA,'accounts'));await writeFile(path.join(volumeA,'accounts','MUST_NOT_APPEAR'),Buffer.alloc(8192));
await writeFile(path.join(volumeB,'other-volume.bin'),Buffer.alloc(256));
const {Store}=await import(pathToFileURL(path.join(host,'desktop/store.mjs')).href),store=new Store(profile,{workspace});await store.init();
Object.assign(store.state.settings,{workspace,provider:'codex',autoUpdate:false,autoTitle:false,closeToTray:false,quickAccess:false,permissionMode:'ask',memoryEnabled:false,chatMemorySummaries:false,attentionNotifications:false,browserEnabled:true,desktopEnabled:false,decisionLayer:{enabled:false},interfaceView:'advanced'});
const chat=store.create('codex');chat.title='Storage QA';chat.titleSource='manual';await store.save();
const drives=[{id:'Fixture A',root:volumeA,label:'Main drive',total:16384,used:12288,free:4096},{id:'Fixture B',root:volumeB,label:'Archive drive',total:4096,used:1024,free:3072}];
const url=file=>JSON.stringify(pathToFileURL(path.join(runtime,file)).href),launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const{app,BrowserWindow,dialog,Notification,session}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile,'browser-data'))});app.commandLine.appendSwitch('mute-audio');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false)};Notification.prototype.show=function(){};dialog.showErrorBox=(t,m)=>{console.error(t,m);app.exit(1)};(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>done({cancel:true}));const{ProviderManager}=await import(${url('desktop/providers.mjs')});ProviderManager.prototype.status=async()=>[{id:'codex',connected:true,installed:true,detail:'Synthetic'}];ProviderManager.prototype.subscriptionModels=async()=>({codex:[{id:'fixture',label:'Fixture',efforts:[]}]});ProviderManager.prototype.modelsFor=async()=>[{id:'fixture',label:'Fixture',efforts:[]}];ProviderManager.prototype.codexUsage=async()=>null;ProviderManager.prototype.claudeUsage=async()=>null;ProviderManager.prototype.getCodex=async()=>{throw Error('No personal account access')};ProviderManager.prototype.run=async()=>{throw Error('Live inference refused')};const{DiskSpace}=await import(${url('desktop/disk-space.mjs')});DiskSpace.prototype.drivesView=async function(){return this.drives=${JSON.stringify(drives)}};await import(${url('desktop/main.mjs')});})().catch(e=>{console.error(e);app.exit(1)});`,'utf8');
const env={...process.env,EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,TEMP:output,TMP:output,TMPDIR:output};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization/i.test(key))delete env[key];
const report={output,runtime,checks:{},errors:[],limitations:['Synthetic volumes verify UI and worker behavior. No personal drive scan, provider inference, antivirus clearance or physical mobile test.']};let app,page;
const invoke=(method,payload={})=>page.evaluate(({method,payload})=>window.studio.invoke(method,payload),{method,payload});
async function until(read,accept,label){const end=Date.now()+15000;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>end)throw Error(label+': '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,80));}}
try{
 app=await electron.launch({args:[launcher],cwd:project,env,timeout:40000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const view=page.getByRole('combobox',{name:'Interface view',exact:true});if(await view.count())await view.selectOption('advanced');
 await page.locator('[data-chat-id="'+chat.id+'"] .chat-open').click();
 const message=page.getByRole('textbox',{name:'Message',exact:true});
 await page.getByRole('button',{name:'Storage',exact:true}).click();await page.getByRole('combobox',{name:'Drive',exact:true}).waitFor();
 await until(()=>page.getByRole('combobox',{name:'Drive',exact:true}).locator('option').count(),value=>value===2,'Both drives loaded');
 await page.getByRole('button',{name:'Scan this drive',exact:true}).click();await until(()=>invoke('disk.drives'),result=>result.scans.some(s=>s.status==='complete'),'Storage scan finished');
 const scan=(await invoke('disk.drives')).scans[0];await page.locator('.disk-row').first().waitFor();
 // 1. Selecting rows shows the selection bar with a running total.
 assert.equal(await page.locator('.disk-selection-bar').count(),0);
 await page.getByRole('checkbox',{name:'Select Applications',exact:true}).check();await page.getByRole('checkbox',{name:'Select Media',exact:true}).check();
 await page.locator('.disk-selection-bar').waitFor();assert.match(await page.locator('.disk-selection-bar').innerText(),/2 selected/);
 await page.screenshot({path:path.join(output,'delete-selected.png')});report.checks.selectionBarCountsSelectedRows=true;
 // 2. Manual path: preview, Recycle Bin is the default and permanent deletion needs an explicit acknowledgement.
 await page.getByRole('button',{name:/Delete myself/}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
 assert.match(await dialog.innerText(),/Delete 2 items\?/);assert.match(await dialog.innerText(),/Media/);
 assert.equal(await dialog.getByRole('radio',{name:/Move to the Recycle Bin/}).isChecked(),true);
 await dialog.getByRole('radio',{name:/Delete permanently/}).check();assert.equal(await dialog.getByRole('button',{name:'Delete permanently',exact:true}).isDisabled(),true);
 await dialog.getByRole('checkbox',{name:/cannot be recovered/}).check();assert.equal(await dialog.getByRole('button',{name:'Delete permanently',exact:true}).isEnabled(),true);
 await page.screenshot({path:path.join(output,'delete-dialog.png')});report.checks.dialogDefaultsToRecycleBinAndGuardsPermanent=true;
 // Cancel changes nothing.
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'detached'});
 assert.equal(await fileExists(path.join(volumeA,'Media')),true);report.checks.cancelDeletesNothing=true;
 // 3. Permanent deletion of the synthetic folders really removes them and the rows disappear.
 await page.getByRole('button',{name:/Delete myself/}).click();await dialog.waitFor();await dialog.getByRole('radio',{name:/Delete permanently/}).check();await dialog.getByRole('checkbox',{name:/cannot be recovered/}).check();
 await dialog.getByRole('button',{name:'Delete permanently',exact:true}).click();await dialog.getByRole('heading',{name:'Done'}).waitFor();
 assert.equal(await fileExists(path.join(volumeA,'Media')),false);assert.equal(await fileExists(path.join(volumeA,'Applications')),false);assert.equal(await fileExists(path.join(volumeA,'Projects')),true);
 await dialog.getByRole('button',{name:'Close',exact:true}).first().click();await dialog.waitFor({state:'detached'});
 await until(()=>page.locator('.disk-row').count(),count=>count===1,'Deleted rows disappear');assert.match(await page.locator('.disk-outcome').innerText(),/deleted permanently/);assert.equal(await page.locator('.disk-selection-bar').count(),0);
 await page.screenshot({path:path.join(output,'delete-done.png')});report.checks=Object.assign(report.checks,{permanentDeleteRemovesFoldersAndRows:true});
 // 4. The Recycle Bin path works from the real app (one 1 KB synthetic file).
 const tiny=path.join(volumeA,'Projects','recycle-me.txt');await writeFile(tiny,Buffer.alloc(1024));
 await page.getByRole('button',{name:'Scan drive again',exact:true}).click();await until(()=>invoke('disk.drives'),result=>result.scans.filter(s=>s.status==='complete').length>=2,'Second scan finished');
 const second=(await invoke('disk.drives')).scans.at(-1);assert.notEqual(second.id,scan.id);
 const recycled=await invoke('disk.delete',{id:second.id,paths:[tiny],method:'recycle',confirmed:true});assert.equal(recycled.deleted.length,1,JSON.stringify(recycled));assert.equal(await fileExists(tiny),false);report.checks.recycleBinMoveWorksInRealApp=true;
 // 5. System locations are refused even when asked for directly, and confirmation is mandatory.
 await assert.rejects(invoke('disk.delete',{id:second.id,paths:[tiny]}),/Confirm the deletion/);
 const refused=await invoke('disk.delete',{id:second.id,paths:['C:\\Windows\\System32','C:\\Users'],method:'permanent',confirmed:true});assert.equal(refused.deleted.length,0);assert.equal(refused.refused.length,2);report.checks.systemLocationsRefused=true;
 // 6. Have AI check and delete: opens a draft chat sharing the scan, sends nothing, deletes nothing.
 await page.locator('.disk-page').waitFor();
 const before=await fileExists(path.join(volumeA,'Projects','node_modules'));assert.equal(before,true);
 await page.getByRole('checkbox',{name:'Select Projects',exact:true}).check();
 await page.getByRole('button',{name:/Have AI check and delete/}).click();
 await until(()=>message.inputValue(),text=>text.includes('disk_delete')&&text.includes('Projects'),'AI cleanup draft populated');
 const stateAfter=await invoke('bootstrap'),cleanup=stateAfter.conversations.find(c=>c.title==='Storage cleanup');assert.ok(cleanup);assert.equal(cleanup.messages.length,0);assert.equal(cleanup.permissionMode,'ask');
 assert.equal(await fileExists(path.join(volumeA,'Projects','node_modules')),true);report.checks.aiCleanupDraftSharesScanAndDeletesNothing=true;
 await page.getByRole('button',{name:'Storage',exact:true}).click();await page.getByRole('combobox',{name:'Drive',exact:true}).waitFor();
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(360,600);window.setSize(420,820)});
 await until(()=>page.evaluate(()=>innerWidth),value=>value<=440,'Narrow viewport');
 await page.getByRole('checkbox',{name:'Select Projects',exact:true}).check();await page.getByRole('button',{name:/Delete myself/}).click();await page.getByRole('dialog').waitFor();
 const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=await page.evaluate(()=>innerWidth)+1,'dialog fits the narrow window');await page.screenshot({path:path.join(output,'delete-narrow.png')});
 await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();report.checks.narrowDialogFits=true;
 assert.deepEqual(report.errors,[]);report.protection=await fixture.verify();report.passed=true;
}catch(error){report.error=error.stack;report.passed=false;}finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;}
