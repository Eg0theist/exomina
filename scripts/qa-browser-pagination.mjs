import {_electron as electron} from 'playwright';
import {createProtectedQaProfile} from './qa-profile.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root);
const reportDir=path.resolve(process.env.EXOMINA_QA_REPORT_DIR||path.join(root,'../Workspace/harness-audit-20261011'));
await mkdir(reportDir,{recursive:true});
const {profile,output}=await createProtectedQaProfile('browser-pagination');
const prefix=runtimeRoot===root?'source':'packaged';
const reportPath=path.join(reportDir,prefix+'-browser-pagination.json');
const launcher=path.join(output,'launcher.cjs');
await writeFile(launcher,`const {app,BrowserWindow,WebContentsView}=require('electron');
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(profile)});
const report={runtimeRoot:${JSON.stringify(runtimeRoot)},scope:'Production browser runtime and actual Electron main frame in fresh restricted EFS synthetic profile; no remote browsing, provider/model/account calls.',checks:{}};
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
const view=new WebContentsView({webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});win.contentView.addChildView(view);view.setBounds({x:0,y:0,width:700,height:600});
const wc=view.webContents;let runtime;
try{
const {BrowserRuntime}=await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot,'desktop/browser-runtime.mjs')).href)});
const original='Synthetic scientific paper '+ '🧭 long paragraph\\n'.repeat(5000)+'End';
await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<main style="white-space:pre-wrap">'+original+'</main>'));
runtime=new BrowserRuntime({wc,readState:()=>({url:wc.getURL(),title:wc.getTitle(),loading:wc.isLoading()})});
let captured=0;wc.capturePage=()=>{captured++;return new Promise(()=>{});};
let offset=0;const pages=[];do{const response=await runtime.snapshot(undefined,{offset,limit:9000,include_screenshot:false});const page=JSON.parse(response.content[0].text);assert.equal(response.isError,undefined);assert.equal(page.textOffset,offset);assert.equal(page.screenshot.reason,'Screenshot omitted by request.');pages.push(page.text);offset=page.nextOffset;}while(offset!==null);
const hash=value=>createHash('sha256').update(value).digest('hex');assert.equal(hash(pages.join('')),hash(original));assert.ok(pages.length>3);assert.equal(captured,0);report.checks.fullNativeTextReassembled=true;report.checks.nativeCaptureSkipped=true;report.pages=pages.length;
await assert.rejects(runtime.snapshot(undefined,{limit:24001}),/Snapshot/);report.checks.invalidPagingRejected=true;
assert.equal(win.isVisible(),false);report.checks.noVisibleQaWindow=true;report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{runtime?.close();wc.close();win.destroy();await fs.writeFile(${JSON.stringify(reportPath)},JSON.stringify(report,null,2)+'\\n');console.log(JSON.stringify(report));app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1)});`);
const env={...process.env,EXOMINA_DATA_DIR:profile,TEMP:output,TMP:output,TMPDIR:output};
delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(/(?:token|secret|password|api_?key|credential|authorization)/i.test(key))delete env[key];
const app=await electron.launch({args:[launcher],cwd:root,env,timeout:30000});
const child=app.process();
if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));
process.exitCode=child.exitCode||0;
const report=JSON.parse(await readFile(reportPath,'utf8'));
if(!report.passed)process.exitCode=1;
console.log(JSON.stringify({...report,reportPath}));
