// Real renderer, synthetic update states, no public endpoints or personal data.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-update-controls-'));
const server=await createServer({root,server:{port:5198,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'renderer-profile')};delete env.ELECTRON_RUN_AS_NODE;
const report={output,scope:'Real renderer; synthetic remote update states. Real ZIP download/extraction and apply handoff are checked in public-updates.test.mjs.',checks:{},errors:[]};let app,page;
try{
 app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.addInitScript(()=>{
  let studio;
  Object.defineProperty(window,'studio',{configurable:true,get:()=>studio,set:value=>{
   studio={...value};const invoke=value.invoke.bind(value),onEvent=value.onEvent.bind(value),listeners=new Set();
   const state={supported:true,installed:{id:'installed-qa-build',version:'0.4.0',builtAt:'2026-10-06T12:00:00Z'},available:false,autoUpdate:false,activity:{idle:true,blockers:[]},remote:{configured:true,feedUrl:'https://updates.example.invalid/latest.json',release:null,progress:null}};
   const next={id:'downloaded-qa-build',version:'0.4.1',builtAt:'2026-10-07T12:00:00Z',notes:'Synthetic release notes: <script>untrusted text</script>'};
   const calls=[];let failures=1,cancelNext=false;window.qaUpdates={state,calls,cancelNextApply:()=>{cancelNext=true;},setActivity:activity=>{state.activity=activity;emit({type:'terminal.changed'});},setMerge:merge=>{state.merge=merge;emit({type:'update.progress',progress:state.remote.progress});}};
   const emit=event=>listeners.forEach(listener=>listener(event));
   const progress=phase=>{state.remote.progress={phase,message:phase==='ready'?'Update ready to apply':phase==='downloading'?'Downloading update':'Checking for updates',completed:50,total:100};emit({type:'update.progress',progress:state.remote.progress});};
   studio.onEvent=callback=>{listeners.add(callback);const unsubscribe=onEvent(callback);return()=>{listeners.delete(callback);unsubscribe?.();};};
   studio.invoke=async(method,payload={})=>{
    if(method==='update.status')return structuredClone(state);
    if(method==='settings.save'&&'autoUpdate'in payload)state.autoUpdate=payload.autoUpdate;
    if(method==='settings.save'&&'updateFeedUrl'in payload){state.remote.feedUrl=payload.updateFeedUrl;state.remote.configured=!!payload.updateFeedUrl;}
    if(method==='update.check'||method==='update.download'){
     calls.push(method);progress('checking');await new Promise(resolve=>setTimeout(resolve,100));state.remote.release=next;
     if(method==='update.download'||state.autoUpdate){progress('downloading');await new Promise(resolve=>setTimeout(resolve,250));state.available=true;state.staged=next;progress('ready');}else progress('available');
     return structuredClone(state);
    }
    if(method==='update.install'){calls.push(method);if(failures-->0){throw Error('Synthetic installation could not start. Try again.');}if(cancelNext){cancelNext=false;return{cancelled:true};}return{restarting:true};}
    if(method==='update.prepare'){state.merge={required:true,phase:'conflicts',workspace:'synthetic merge workspace',conflicts:[{path:'src/App.jsx',resolved:false}],changes:[{path:'src/App.jsx',local:true,release:true}]};return structuredClone(state.merge);}
    return invoke(method,payload);
   };
  }});
 });
 await page.reload();await page.locator('.sidebar-bottom').getByRole('button',{name:/^Settings/}).click();await page.getByRole('button',{name:'Updates',exact:true}).click();
 const section=page.locator('#settings-updates');await section.waitFor();await section.scrollIntoViewIfNeeded();
 await page.getByRole('button',{name:'Check for updates',exact:true}).click();await section.getByText('New version available',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isDisabled(),true);report.checks.checkOnlyAndManualDownload=true;
 await page.getByRole('button',{name:'Download update',exact:true}).click();await page.getByRole('progressbar',{name:'Update download progress'}).waitFor();await section.getByText('Ready to apply',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isEnabled(),true);
 assert.equal(await page.evaluate(()=>window.qaUpdates.calls.filter(method=>method==='update.install').length),0);report.checks.downloadWaitsForUserApply=true;
 await page.getByRole('switch',{name:'Download updates automatically'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Download updates automatically"]').getAttribute('aria-checked')==='true');
 report.checks.automaticDownloadToggle=true;
 await section.locator('.update-notes summary').click();await section.getByText('Synthetic release notes: <script>untrusted text</script>',{exact:true}).waitFor();assert.equal(await section.locator('script').count(),0);report.checks.releaseNotesAreText=true;
 await section.locator('.update-source summary').click();await page.getByLabel('Release feed address').fill('https://publisher.example.invalid/latest.json');await page.getByRole('button',{name:'Save address',exact:true}).click();await page.waitForFunction(()=>window.qaUpdates.state.remote.feedUrl==='https://publisher.example.invalid/latest.json');report.checks.configurableReleaseAddress=true;
 await page.getByRole('button',{name:'Apply update',exact:true}).click();await section.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isEnabled(),true);report.checks.failedApplyCanRetry=true;
 await page.screenshot({path:path.join(output,'update-controls.png')});
 await page.evaluate(()=>window.qaUpdates.setMerge({required:true,phase:'customized',message:'Your source differs from its official baseline.'}));await section.getByText('Your source differs from its official baseline.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Prepare merged update',exact:true}).click();await page.getByRole('button',{name:'Review with AI',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isDisabled(),true);report.checks.customizedReleaseRequiresReview=true;
 await page.evaluate(()=>window.qaUpdates.setMerge({required:true,phase:'verified',workspace:'synthetic merge workspace',conflicts:[],changes:[{path:'src/App.jsx',local:true}],checks:[{name:'tests',passed:true}]}));await section.getByText(/merged version passed dependency/).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isEnabled(),true);report.checks.verifiedMergeEnablesApply=true;
 await page.evaluate(()=>window.qaUpdates.setMerge({required:true,phase:'baseline-missing',message:'No verified source baseline.'}));await section.getByText('No verified source baseline.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Prepare merged update',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isDisabled(),true);report.checks.missingBaselineCannotBeBypassed=true;await page.screenshot({path:path.join(output,'customized-update-controls.png')});
 await page.evaluate(()=>{window.qaUpdates.setMerge(null);window.qaUpdates.setActivity({idle:false,blockers:[{kind:'terminals',count:1,message:'Close 1 open terminal session in Terminal, including shells waiting at a prompt.'}]});});
 await section.getByText(/including shells waiting at a prompt/).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isEnabled(),true);report.checks.openTerminalIsExplainedAndApplyCanRequestClosure=true;
 await page.evaluate(()=>window.qaUpdates.cancelNextApply());await page.getByRole('button',{name:'Apply update',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#settings-updates .primary-button').disabled);report.checks.cancelledClosureReleasesApplyButton=true;
 await page.evaluate(()=>window.qaUpdates.setActivity({idle:false,blockers:[{kind:'analysis',count:1,message:'Finish or stop 1 app analysis job in Tools.'}]}));await section.getByText('Finish or stop 1 app analysis job in Tools.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply update',exact:true}).isDisabled(),true);report.checks.actualAnalysisBlockerPreventsApply=true;
 await page.evaluate(()=>window.qaUpdates.setActivity({idle:true,blockers:[]}));await page.waitForFunction(()=>!document.querySelector('#settings-updates .primary-button').disabled);await page.getByRole('button',{name:'Apply update',exact:true}).click();assert.equal(await page.evaluate(()=>window.qaUpdates.calls.filter(method=>method==='update.install').length),3);report.checks.explicitApplyAction=true;assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;report.diagnostic=await page?.evaluate(()=>({fixture:window.qaUpdates,text:document.getElementById('settings-updates')?.textContent})).catch(()=>null);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await app?.close().catch(()=>{});await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
