// Windows gate for the update path public installs actually use: the next
// installer replacing the program over an existing library. Runs a previously
// released program and the candidate against one synthetic profile, then drives
// the real "existing library" dialog. Nothing here reads a real profile: every
// launch either names explicit synthetic folders or is stopped as soon as the
// dialog shows it resolved outside the synthetic home.
import {chromium} from 'playwright';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,realpath,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {prepareWindowsQaOwner} from './native-qa-windows-owner.mjs';

if(process.platform!=='win32')throw Error('The upgrade gate requires Windows.');
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const previous=path.resolve(option('--previous')||''),candidate=path.resolve(option('--candidate')||'');
const reportFile=path.resolve(option('--report')||'public-upgrade-report.json');
for(const file of [previous,candidate])assert.ok((await stat(file)).isFile(),'Pass both --previous and --candidate executables.');
await prepareWindowsQaOwner();
const run=promisify(execFile),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'exomina-upgrade-')));
// The development workspace can inherit EFS. This empty fixture must model an
// ordinary fresh profile before any app or account file exists inside it.
{const {WindowsProfileAccess}=await import('../desktop/profile-access.mjs'),checker=new WindowsProfileAccess();
 try{
  if((await checker.inspect(root)).anyEncrypted===true)await run(path.join(process.env.SystemRoot,'System32','cipher.exe'),['/d',root],{windowsHide:true});
  assert.equal((await checker.inspect(root)).anyEncrypted,false,'The empty fixture must not inherit EFS.');
 }finally{checker.close();}
}
const documents=path.join(root,'Documents'),local=path.join(root,'AppData','Local'),roaming=path.join(root,'AppData','Roaming');
const library=path.join(documents,'Exomina','Private'),choiceFile=path.join(local,'Exomina','profile-choice.json');
const legacy={EXOMINA_DATA_DIR:path.join(library,'data'),EXOMINA_ACCOUNTS_DIR:path.join(library,'accounts'),EXOMINA_WORKSPACE_DIR:path.join(documents,'Exomina','Workspace')};
for(const directory of [documents,local,roaming,path.join(root,'Desktop'),path.join(root,'Downloads'),legacy.EXOMINA_DATA_DIR,legacy.EXOMINA_ACCOUNTS_DIR,legacy.EXOMINA_WORKSPACE_DIR])await mkdir(directory,{recursive:true});
const stamp=async executable=>JSON.parse(await readFile(path.join(path.dirname(executable),'exomina.build.json'),'utf8'));
const report={at:new Date().toISOString(),scope:'Released program and candidate executables on one synthetic standard profile with real Windows dialogs. No installer registration, account sign-in, model request or real profile.',previous:await stamp(previous),candidate:await stamp(candidate),checks:{},passed:false};
assert.notEqual(report.previous.id,report.candidate.id);
const baseEnvironment=()=>{
 const environment={...process.env,HOME:root,USERPROFILE:root,APPDATA:roaming,LOCALAPPDATA:local,TEMP:root,TMP:root,TMPDIR:root,EXOMINA_STARTUP_DIAGNOSTICS:'1'};
 for(const key of Object.keys(environment))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key)||/^(?:ELECTRON_RUN_AS_NODE|OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|GITHUB_|GH_|EXOMINA_(?!STARTUP))/i.test(key))delete environment[key];
 return environment;
};
const pwsh=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
function launch(executable,extra={}){
 const environment={...baseEnvironment(),...extra};
 const child=spawn(executable,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--mute-audio'],{cwd:path.dirname(executable),env:environment,windowsHide:false,stdio:['ignore','pipe','pipe']});
 const state={child,stderr:'',exit:null};
 child.stderr.on('data',chunk=>{state.stderr=(state.stderr+chunk).slice(-32768);});child.stdout.on('data',()=>{});
 state.exited=new Promise(resolve=>child.once('close',(code,signal)=>{state.exit={code,signal};resolve(state.exit);}));
 return state;
}
async function stop(state){
 if(state.browser)await state.browser.close().catch(()=>{});
 if(state.exit)return;
 await new Promise(resolve=>{const killer=spawn(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/pid',String(state.child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});killer.once('close',resolve);killer.once('error',resolve);});
 await state.exited;
}
async function workspace(state){
 const deadline=Date.now()+120000;let endpoint;
 while(Date.now()<deadline&&!endpoint){
  if(state.exit)throw Error('The app exited during startup: '+JSON.stringify(state.exit)+'\n'+state.stderr.slice(-2000));
  endpoint=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(state.stderr)?.[1];
  if(!endpoint)await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(endpoint,'The app did not expose its debugging endpoint.');
 // Connecting before the window exists never reports the page that appears later.
 const targets=new URL(endpoint).host;let ready=false;
 while(Date.now()<deadline&&!ready){
  if(state.exit)throw Error('The app exited during startup: '+JSON.stringify(state.exit)+'\n'+state.stderr.slice(-2000));
  ready=await fetch(`http://${targets}/json/list`).then(response=>response.json()).then(list=>list.some(item=>/\/dist\/index\.html(?:\?|$)/.test(item.url)),()=>false);
  if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'The workspace page did not load.');
 state.browser=await chromium.connectOverCDP(`http://${targets}`,{noDefaults:true});
 let page;
 while(Date.now()<deadline&&!page){page=state.browser.contexts().flatMap(context=>context.pages()).find(item=>/\/dist\/index\.html(?:\?|$)/.test(item.url()));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(page,'The workspace page did not load.');page.setDefaultTimeout(30000);
 try{await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();}
 catch(error){const shown=await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');throw Error(error.message.slice(0,200)+' | On screen: '+String(shown).slice(0,1500));}
 return page;
}
const invoke=(page,method,payload)=>page.evaluate(([name,value])=>window.studio.invoke(name,value),[method,payload]);
const titles=async page=>(await invoke(page,'bootstrap')).conversations.map(chat=>chat.title);
// Opening the older library restarts the program. Adopt the new main process.
async function followRelaunch(state){
 const ended=await Promise.race([state.exited,new Promise(resolve=>setTimeout(()=>resolve('timeout'),30000))]);
 assert.notEqual(ended,'timeout','The program did not close to reopen.');
 const script=`Get-CimInstance Win32_Process -Filter "Name='Exomina.exe'"|Where-Object{$_.ExecutablePath -eq '${candidate.replaceAll("'","''")}' -and $_.CommandLine -notmatch '--type='}|Select-Object -First 1 -ExpandProperty ProcessId`;
 const deadline=Date.now()+120000;let pid,port;
 while(Date.now()<deadline&&!(pid&&port)){
  pid=Number((await run(pwsh,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:30000})).stdout.trim())||undefined;
  port=undefined;
  if(pid){
   const {stdout}=await run(pwsh,['-NoProfile','-NonInteractive','-Command',`Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue|Select-Object -ExpandProperty LocalPort`],{windowsHide:true,timeout:30000}).catch(()=>({stdout:''}));
   for(const candidatePort of stdout.split(/\s+/).filter(Boolean).map(Number)){
    const answers=await fetch(`http://127.0.0.1:${candidatePort}/json/version`,{signal:AbortSignal.timeout(3000)}).then(response=>response.ok,()=>false);
    if(answers){port=candidatePort;break;}
   }
  }
  if(!(pid&&port))await new Promise(resolve=>setTimeout(resolve,500));
 }
 assert.ok(pid&&port,'The program did not start again in the older library.');
 const next={child:{pid},stderr:`DevTools listening on ws://127.0.0.1:${port}/devtools/browser/relaunched`,exit:null};
 next.exited=(async()=>{for(;;){try{process.kill(pid,0);}catch{next.exit={code:null};return next.exit;}await new Promise(resolve=>setTimeout(resolve,300));}})();
 return next;
}
const removeChoice=async()=>{await rm(path.join(local,'Exomina'),{recursive:true,force:true,maxRetries:5,retryDelay:300});};
const SENTINEL='Upgrade gate library';
let state;
try{
 // 1. The released program creates a library and writes a real conversation.
 state=launch(previous,legacy);let page=await workspace(state);
 const created=await invoke(page,'analysis.newChat',{});
 await invoke(page,'conversations.rename',{id:created.id,title:SENTINEL});
 assert.ok((await titles(page)).includes(SENTINEL));
 await stop(state);report.checks.releasedProgramWroteLibrary=true;

 // 2. Relaunching the released program records what its users would meet. Chromium
 // adds sandbox grants after the first run; a release may refuse its own profile.
 report.releasedProgramRelaunches=[];
 for(let attempt=0;attempt<2;attempt++){
  state=launch(previous,legacy);
  try{await workspace(state);report.releasedProgramRelaunches.push('opened');}
  catch(error){report.releasedProgramRelaunches.push(error.message.slice(0,300));}
  await stop(state);
 }

 // 3. Upgrade carry-over: the candidate opens that library, whatever state it reached.
 state=launch(candidate,legacy);page=await workspace(state);
 assert.ok((await titles(page)).includes(SENTINEL),'The upgraded program lost the conversation.');
 const security=await invoke(page,'security.status');assert.equal(security.ready,true);
 const update=await invoke(page,'update.status');assert.equal(update.supported,false);assert.equal(update.manualUpdates,true);assert.ok(!update.inProgress,'A manual-update install must never report an update in progress.');
 const disk=await invoke(page,'disk.status');assert.ok(disk.freeBytes>0);assert.ok(['ok','low','critical'].includes(disk.level));
 const usage=await invoke(page,'disk.usage');assert.ok(usage.folders.length>0);
 report.checks.candidateKeptLibrary=true;report.checks.manualUpdatesCannotSelfExit=true;report.checks.diskRoutes={level:disk.level};
 await stop(state);

 // 4. The candidate must keep opening its own profile on every later launch.
 report.candidateRelaunchMs=[];
 for(let attempt=0;attempt<3;attempt++){
  const started=Date.now();state=launch(candidate,legacy);page=await workspace(state);
  report.candidateRelaunchMs.push(Date.now()-started);
  assert.ok((await titles(page)).includes(SENTINEL),'A relaunch lost the conversation.');
  await stop(state);
 }
 report.checks.candidateSurvivesRelaunches=true;


 // 5. Real resolver with the older library in Documents: never opened unasked.
 await removeChoice();
 state=launch(candidate);page=await workspace(state);
 let view=await invoke(page,'bootstrap');
 assert.ok(view.olderLibrary,'The older library must be offered.');
 // Stop before anything else if Documents did not resolve inside the fixture.
 assert.ok(view.olderLibrary.folder.toLowerCase().startsWith(root.toLowerCase()),'Documents resolved outside the synthetic home.');
 assert.ok(!view.conversations.some(chat=>chat.title===SENTINEL),'A new library must not show the older conversations.');
 const card=page.locator('.older-library-card');await card.waitFor();report.cardText=(await card.innerText()).replace(/\s+/g,' ').slice(0,400);
 await page.getByRole('button',{name:'Open older library',exact:true}).waitFor();
 const fresh=await invoke(page,'analysis.newChat',{});await invoke(page,'conversations.rename',{id:fresh.id,title:'New library chat'});
 await stat(path.join(local,'Exomina','Private','data','state.json'));
 assert.ok((await readFile(path.join(legacy.EXOMINA_DATA_DIR,'state.json'))).includes(SENTINEL));
 await stop(state);report.checks.newLibraryIsSeparateAndOlderOneOffered=true;
 // The offer survives a relaunch until answered, with the new library retained.
 state=launch(candidate);page=await workspace(state);view=await invoke(page,'bootstrap');
 assert.ok(view.olderLibrary);assert.ok(view.conversations.some(chat=>chat.title==='New library chat'));
 report.checks.offerSurvivesRelaunch=true;
 // Keeping this library ends the offer for good.
 await page.getByRole('button',{name:'Keep this library',exact:true}).click();
 await page.locator('.older-library-card').waitFor({state:'detached'});
 await stop(state);
 state=launch(candidate);page=await workspace(state);view=await invoke(page,'bootstrap');
 assert.equal(view.olderLibrary,null);assert.ok(view.conversations.some(chat=>chat.title==='New library chat'));
 await stop(state);report.checks.keepingEndsTheOffer=true;
 // Opening it reaches the older library, which is the upgrade path for old testers.
 await removeChoice();
 state=launch(candidate);page=await workspace(state);
 await rm(path.join(legacy.EXOMINA_DATA_DIR,'DevToolsActivePort'),{force:true});
 await page.getByRole('button',{name:'Open older library',exact:true}).click();
 await state.browser?.close().catch(()=>{});state.browser=undefined;
 state=await followRelaunch(state);
 page=await workspace(state);view=await invoke(page,'bootstrap');
 assert.ok(view.conversations.some(chat=>chat.title===SENTINEL));assert.equal(view.olderLibrary,null);
 assert.equal(JSON.parse(await readFile(choiceFile,'utf8')).choice,'existing');
 await stop(state);report.checks.olderLibraryOpensOnRequest=true;
 report.passed=true;
}catch(error){report.error=String(error.stack||error).slice(0,4000);process.exitCode=1;}
finally{
 if(state)await stop(state).catch(()=>{});
 await writeFile(reportFile,JSON.stringify(report,null,2),'utf8');
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error,root},null,1));
}
