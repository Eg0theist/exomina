// Compiled desktop renderer, isolated profile and synthetic IPC. No provider/account access.
import {_electron as electron} from 'playwright';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=await mkdtemp(path.resolve(root,'../Workspace/qa-decision-bundle-'));
const hardware={ramGb:16,freeRamGb:8,threads:8,gpus:[],npus:[]};
const localStatus={hardware,tier:{capable:3,active:2},tiers:[{tier:1,name:'Quick classifier',state:'active'},{tier:2,name:'Statement checker',state:'active'},{tier:3,name:'Local chat model',state:'not-installed'}],gates:[{name:'next-prompt.useful',examples:12,trained:false}],manualPause:null,paused:null,tier2Model:{id:'multilingual',name:'Multilingual',sizeMb:355}};
const state={settings:{provider:'codex',model:'auto',workspace:'C:\\synthetic',interfaceView:'standard',memoryEnabled:true,decisionLayer:{enabled:true,makeWay:true},agent:{enabled:false,dailyBudget:10},appearance:{theme:'ink-wash',motion:'reduced'}},connections:[],conversations:[],memories:[],tools:[],approvals:[],workbench:{projects:[],prompts:[],schedules:[{id:'task',name:'Summarize reports',provider:'codex',prompt:'Summarize new reports.'}]},version:'synthetic',archive:{documents:0}};
const preload=path.join(output,'preload.cjs'),entry=path.join(output,'main.cjs');
await writeFile(preload,`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('studio',{invoke:(m,p)=>ipcRenderer.invoke('qa',m,p),onEvent:cb=>{const f=(_e,d)=>cb(d);ipcRenderer.on('studio:event',f);return()=>ipcRenderer.removeListener('studio:event',f)}});`,'utf8');
await writeFile(entry,`const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',process.env.QA_PROFILE);globalThis.qa={state:${JSON.stringify(state)},status:${JSON.stringify(localStatus)},calls:[],triggers:[],inbox:[]};let win;const emit=event=>win.webContents.send('studio:event',event);const view=()=>({settings:qa.state.settings.decisionLayer,status:qa.state.settings.decisionLayer.enabled?qa.status:null,models:[{id:'multilingual',name:'Multilingual',sizeMb:355},{id:'english',name:'English',sizeMb:96}],agent:{settings:qa.state.settings.agent,triggers:qa.triggers,inbox:qa.inbox,runsToday:0}});ipcMain.handle('qa',(_e,m,p={})=>{qa.calls.push({m,p});switch(m){case 'security.status':return{protected:true,supported:true,needsRecovery:false};case 'bootstrap':return qa.state;case 'settings.save':Object.assign(qa.state.settings,p);return qa.state.settings;case 'decision.status':return view();case 'decision.pause':qa.status.manualPause='until-resumed';qa.status.paused='paused by the user';return view();case 'decision.resume':qa.status.manualPause=null;qa.status.paused=null;return view();case 'decision.tier2.download':qa.status.tier2Model={id:p.id,name:'English',sizeMb:96};return view();case 'agent.chooseFolder':return'C:/synthetic/reports';case 'agent.saveTrigger':qa.triggers=[{...p,id:'trigger'}];emit({type:'agent.changed'});return qa.triggers[0];case 'agent.removeTrigger':qa.triggers=[];return view();case 'agent.feedback':qa.inbox.find(x=>x.id===p.id).feedback=p.shouldRun;return{};case 'update.status':return{supported:false};default:return{};}});app.whenReady().then(()=>{win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`,'utf8');
const env={...process.env,QA_PROFILE:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[entry],env,timeout:30000});
const report={syntheticOnly:true,checks:{},errors:[]};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 const nav=page.getByRole('navigation',{name:'Main navigation'});
 assert.equal(await nav.getByRole('button',{name:'Connections',exact:true}).count(),0);assert.equal(await nav.getByRole('button',{name:'Memory',exact:true}).count(),0);
 // Empty-account onboarding remains visible on the home screen.
 assert.ok(await page.locator('button').filter({hasText:/Connect/}).count()>0);
 await page.keyboard.press('Control+,');
 await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:'Connections & sync',exact:true}).click();
 await page.getByRole('button',{name:'Manage connections',exact:true}).click();
 await page.getByRole('heading',{name:'Connect your accounts',exact:true}).waitFor();
 await page.getByRole('button',{name:'Back to Settings',exact:true}).click();
 const search=page.getByLabel('Search settings',{exact:true});await search.fill('local AI');await search.press('Enter');
 await page.locator('#settings-local-ai').waitFor();
 assert.equal(await page.getByRole('switch',{name:'Run tasks when files change',exact:true}).getAttribute('aria-checked'),'false');
 assert.ok((await page.locator('.local-ai-tiers').textContent()).includes('Statement checker'));
 await page.getByRole('button',{name:'Pause local AI now',exact:true}).click();await page.getByRole('button',{name:'Resume local AI',exact:true}).waitFor();
 await page.getByRole('button',{name:'Resume local AI',exact:true}).click();
 await page.getByRole('switch',{name:'Give demanding apps priority',exact:true}).click();
 assert.equal(await app.evaluate(()=>qa.state.settings.decisionLayer.makeWay),false);
 await page.getByRole('switch',{name:'Use local decisions',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Pause local AI now',exact:true}).isDisabled(),true);
 await page.getByRole('switch',{name:'Use local decisions',exact:true}).click();
 report.checks.settingsAndPause=true;
 await page.getByRole('button',{name:'Add a folder trigger',exact:true}).click();
 await page.getByLabel('Trigger name',{exact:true}).fill('New reports');await page.getByRole('button',{name:'Choose folder',exact:true}).click();
 await page.locator('.local-ai-form .path-text').filter({hasText:'reports'}).waitFor();
 await page.getByLabel('Task to run',{exact:true}).selectOption('task');await page.getByLabel('File names (optional)',{exact:true}).fill('*.pdf');
 await page.getByRole('button',{name:'Save trigger',exact:true}).click();await page.locator('.local-ai-trigger').waitFor();
 assert.equal(await app.evaluate(()=>qa.state.settings.agent.enabled),false);
 await page.getByRole('switch',{name:'Run tasks when files change',exact:true}).click();
 assert.equal(await app.evaluate(()=>qa.state.settings.agent.enabled),true);
 await app.evaluate(({BrowserWindow})=>{qa.inbox=[{id:'event',triggerName:'New reports',status:'ran',at:'2026-10-15T12:00:00Z',files:['report.pdf'],input:'synthetic event'}];BrowserWindow.getAllWindows()[0].webContents.send('studio:event',{type:'agent.changed'});});
 await page.locator('.local-ai-inbox').getByRole('button',{name:'Yes',exact:true}).click();await page.getByText('Feedback saved: useful',{exact:true}).waitFor();
 assert.equal(await app.evaluate(()=>qa.calls.some(x=>x.m==='chat.send'||x.m==='schedules.run')),false);
 report.checks.triggerSetupAndInboxWithoutProviderCalls=true;
 report.checks.layouts=[];
 for(const width of [1440,760,360]){
   await page.setViewportSize({width,height:1000});
   await page.getByRole('heading',{name:'Background agent',exact:true}).scrollIntoViewIfNeeded();
   const geometry=await page.locator('#settings-local-ai').evaluate(el=>({width:innerWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,contentOverflow:el.scrollWidth>el.clientWidth+1}));
   assert.equal(geometry.documentOverflow,false);assert.equal(geometry.contentOverflow,false);
   report.checks.layouts.push(geometry);await page.screenshot({path:path.join(output,'local-ai-'+width+'.png')});
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;const page=await app.firstWindow();report.calls=await app.evaluate(()=>qa.calls.slice(-20));report.form=await page.locator('.local-ai-form').evaluateAll(elements=>elements.map(el=>({text:el.innerText,inputs:[...el.querySelectorAll('input,select')].map(input=>({value:input.value,disabled:input.disabled})),buttons:[...el.querySelectorAll('button')].map(button=>({text:button.innerText,disabled:button.disabled}))})));await page.screenshot({path:path.join(output,'failure.png')});}
finally{await app.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,...report},null,2));}
