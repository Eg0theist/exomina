// Actual main entry with a deliberately refused, synthetic setup profile.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createPlatformQaProfile as createProtectedQaProfile} from './qa-profile.mjs';
import {prepareWindowsQaOwner} from './native-qa-windows-owner.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

await prepareWindowsQaOwner();
const root=path.resolve(import.meta.dirname,'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root),require=createRequire(import.meta.url),executable=require('electron');
const {profile,output}=await createProtectedQaProfile('startup-refusal'),home=path.join(output,'home'),accounts=path.join(output,'accounts'),workspace=path.join(output,'workspace');for(const directory of [home,accounts,workspace,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local')])await mkdir(directory,{recursive:true});
const before=await readFile(path.join(profile,'synthetic-profile.txt'),'utf8'),record=path.join(output,'blocked.json'),launcher=path.join(output,'launcher.cjs'),moduleUrl=name=>JSON.stringify(pathToFileURL(path.join(runtimeRoot,name)).href);
await writeFile(launcher,`const {app,dialog}=require('electron');const fs=require('node:fs');app.setAppPath(${JSON.stringify(runtimeRoot)});let opened=false;dialog.showErrorBox=(title,message)=>fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({title,message,storesOpened:opened}),'utf8');(async()=>{const {ProfileStorage}=await import(${moduleUrl('desktop/profile-storage.mjs')});ProfileStorage.prototype.initialize=async function(){this.status={ready:false,supported:false,mode:'standard',message:'Synthetic permission failure'};return this.status;};ProfileStorage.prototype.setupProfile=async()=>{throw Error('Synthetic access restriction could not be confirmed');};const {Store}=await import(${moduleUrl('desktop/store.mjs')});Store.prototype.init=async()=>{opened=true;throw Error('Stores must remain closed');};await import(${moduleUrl('desktop/main.mjs')});})().catch(()=>app.exit(9));`,'utf8');
const env={...process.env,EXOMINA_WINDOWS_INDEPENDENT:randomUUID(),EXOMINA_DATA_DIR:profile,EXOMINA_ACCOUNTS_DIR:accounts,EXOMINA_WORKSPACE_DIR:workspace,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),TEMP:output,TMP:output,TMPDIR:output};for(const key of Object.keys(env))if(/token|secret|password|api_?key|credential|authorization|^(NODE_OPTIONS|BUN_OPTIONS|ELECTRON_RUN_AS_NODE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(key))delete env[key];
let stdout='',stderr='',timedOut=false;const child=spawn(executable,[launcher],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',value=>stdout=(stdout+value).slice(-8000));child.stderr.on('data',value=>stderr=(stderr+value).slice(-8000));const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
const result={at:new Date().toISOString(),runtimeRoot,scope:'Injected synthetic setup-profile refusal in actual application entry; no real account storage accessed.',exitCode:code,timedOut};
try{result.dialog=JSON.parse(await readFile(record,'utf8'));assert.equal(timedOut,false);assert.equal(code,1);assert.equal(result.dialog.storesOpened,false);assert.match(result.dialog.title,/could not start safely/);assert.doesNotMatch(stdout+stderr,/Uncaught Exception|App threw an error during load/);assert.equal(await readFile(path.join(profile,'synthetic-profile.txt'),'utf8'),before);result.passed=true;}catch(error){result.error=error.message;result.stderr=stderr;}
await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify({passed:!!result.passed,output,result}));if(!result.passed)process.exitCode=1;
