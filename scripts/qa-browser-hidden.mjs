// Real renderer, synthetic per-chat browser events. No personal browser/profile access.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve('../Workspace/qa-browser-hidden');await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:0},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Hidden real renderer, synthetic browser events and localhost addresses; no user profile or outside pages.',checks:{},errors:[]};let app;
try {
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(()=>window.__exominaPreviewEmit({type:'browser.reveal',conversationId:null}));await page.getByRole('button',{name:'Close embedded browser',exact:true}).waitFor();report.checks.initialAutomaticReveal=true;
  await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();
  await page.evaluate(()=>{window.__exominaPreviewEmit({type:'browser.reveal',conversationId:null});window.studio.invoke('browser.navigate',{url:'http://127.0.0.1:49387/hidden-site',conversationId:null});});
  await page.waitForFunction(()=>document.querySelector('.browser-toggle')?.getAttribute('aria-pressed')==='false');assert.equal(await page.locator('.browser-panel').count(),0);report.checks.hiddenPaneIgnoresRevealAndNewUrl=true;
  const second=(await page.evaluate(()=>window.studio.invoke('bootstrap'))).conversations[0];await page.locator(`[data-chat-id="${second.id}"] .chat-open`).click();
  await page.evaluate(id=>window.__exominaPreviewEmit({type:'browser.reveal',conversationId:id}),second.id);await page.waitForTimeout(200);assert.equal(await page.locator('.browser-panel').count(),0);report.checks.hiddenChoiceAppliesToAnotherChat=true;
  await page.reload();await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.evaluate(()=>window.__exominaPreviewEmit({type:'browser.reveal',conversationId:null}));await page.waitForTimeout(200);assert.equal(await page.locator('.browser-panel').count(),0);assert.equal(await page.evaluate(()=>localStorage.getItem('exomina.browser.auto-reveal')),'false');report.checks.hiddenPreferenceSurvivesRendererReload=true;
  await page.locator('.browser-toggle').click();await page.getByRole('button',{name:'Close embedded browser',exact:true}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('exomina.browser.auto-reveal')),'true');report.checks.explicitBrowserButtonReopens=true;
  await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();await page.screenshot({path:path.join(output,'hidden.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
