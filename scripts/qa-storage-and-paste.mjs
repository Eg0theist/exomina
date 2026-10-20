// Hidden real host and production renderer, real metadata worker, synthetic data only.
import {_electron as electron} from 'playwright';
import {mkdir,writeFile,readFile,utimes} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProtectedQaProfile} from './qa-profile.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packageRoot=process.env.EXOMINA_QA_PACKAGE_DIR;
const runtime=packageRoot?path.join(packageRoot,'resources/app.asar'):project,host=packageRoot?runtime+'.unpacked':project;
const fixture=await createProtectedQaProfile('storage-and-paste'),{profile,output}=fixture;
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
 const message=page.getByRole('textbox',{name:'Message',exact:true});await message.fill('> ');
 await message.evaluate(element=>{element.focus();element.setSelectionRange(2,2);const data=new DataTransfer();data.setData('text/plain','First\r\nSecond\r\n\r\nLast');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 assert.equal(await message.inputValue(),'> First\n> Second\n> \n> Last');report.checks.multilinePasteRemainsQuoted=true;
 await page.getByRole('button',{name:'Browser',exact:true}).click();await page.getByRole('button',{name:'Close tab New tab',exact:true}).waitFor();await page.getByRole('button',{name:'Close tab New tab',exact:true}).click();
 const blank=await invoke('browser.state',{conversationId:chat.id});assert.equal(blank.tabs.length,1);assert.equal(blank.tabs[0].url,'');report.checks.lastBrowserTabHasCloseAndLeavesBlank=true;
 await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();
 await page.getByRole('button',{name:'Storage',exact:true}).click();await page.getByRole('combobox',{name:'Drive',exact:true}).waitFor();
 await until(()=>page.getByRole('combobox',{name:'Drive',exact:true}).locator('option').count(),value=>value===2,'Both drives loaded');report.checks.driveSelectorAndRealCapacity=true;
 await page.getByRole('button',{name:'Scan this drive',exact:true}).click();await until(()=>invoke('disk.drives'),result=>result.scans.some(s=>s.status==='complete'),'Storage scan finished');
 await page.locator('.disk-row').first().waitFor();const scan=(await invoke('disk.drives')).scans[0],result=await invoke('disk.read',{id:scan.id});assert.equal(result.bytes,167168);assert.ok(result.alloc>=167168,'size on disk is reported');assert.equal(result.engine,'native','the fast scanner ran');assert.ok(!JSON.stringify(result).includes('MUST_NOT_APPEAR'));report.checks.realWorkerMetadataAndPrivateExclusion=true;
 await page.screenshot({path:path.join(output,'storage-map.png')});
 await page.getByRole('button',{name:/Open Media,/}).click();await page.locator('.disk-folder-heading h2').filter({hasText:'Media'}).waitFor();assert.equal((await invoke('disk.read',{id:scan.id,node:result.rows[0].id})).folder.bytes,124096);report.checks.mapAndFolderDrilldown=true;
 await page.getByRole('button',{name:'Largest files',exact:true}).click();await page.getByRole('list',{name:'Largest measured files'}).waitFor();report.checks.largestFilesVisible=true;
 await page.screenshot({path:path.join(output,'storage-desktop.png')});
 await page.getByRole('button',{name:'File types',exact:true}).click();await page.getByText('Biggest individual file extensions',{exact:true}).waitFor();await page.mouse.move(5,5);assert.equal(await page.getByRole('button',{name:'File types',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByRole('button',{name:'Largest files',exact:true}).getAttribute('aria-pressed'),'false');await page.screenshot({path:path.join(output,'storage-types.png')});report.checks.fileTypesView=true;
 await page.getByRole('button',{name:'File age',exact:true}).click();await page.getByRole('list',{name:'Space by file age'}).getByText('Over 2 years',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'storage-age.png')});report.checks.fileAgeView=true;
 await page.getByRole('button',{name:'Cleanup leads',exact:true}).click();await page.getByText('Project dependencies (node_modules)',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'storage-cleanup.png')});report.checks.cleanupLeadsView=true;
 await page.getByRole('button',{name:'Largest files',exact:true}).click();await page.getByRole('button',{name:'Untouched over a year',exact:true}).click();await page.getByRole('list',{name:'Largest measured files'}).getByText('old-movie.mp4',{exact:true}).waitFor();await until(()=>page.getByRole('list',{name:'Largest measured files'}).locator('.disk-row').count(),count=>count===1,'Only files untouched for over a year remain');report.checks.untouchedLargeFilesFilter=true;
 await page.getByRole('combobox',{name:'Drive',exact:true}).selectOption('Fixture B');assert.equal(await page.getByRole('button',{name:'Scan this drive',exact:true}).isEnabled(),true);report.checks.independentDriveSelection=true;
 await page.getByRole('combobox',{name:'Drive',exact:true}).selectOption('Fixture A');await page.getByRole('button',{name:'Prepare AI analysis',exact:true}).click();
 await until(()=>message.inputValue(),text=>text.includes('Analyze storage scan '+scan.id),'AI draft populated');const state=await invoke('bootstrap'),review=state.conversations.find(c=>c.title==='Storage review');assert.ok(review);assert.equal(review.messages.length,0);assert.equal(review.permissionMode,'ask');report.checks.aiDraftSharedWithoutSendingOrDeleting=true;
 await page.getByRole('button',{name:'Storage',exact:true}).click();await page.getByRole('combobox',{name:'Drive',exact:true}).waitFor();
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(360,600);window.setSize(420,820)});
 await until(()=>page.evaluate(()=>innerWidth),value=>value<=440,'Narrow viewport');assert.equal(await page.locator('.disk-page').evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);await page.screenshot({path:path.join(output,'storage-narrow.png')});report.checks.narrowLayoutHasNoHorizontalOverflow=true;
 assert.deepEqual(report.errors,[]);report.protection=await fixture.verify();report.passed=true;
}catch(error){report.error=error.stack;report.passed=false;}finally{if(app)await app.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;}
