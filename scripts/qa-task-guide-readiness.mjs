// Remaining checks after the main UI run; synthetic data only.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve('../Workspace/prospect-task-20261013');await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'readiness-profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});
const report={passed:false,checks:[],errors:[],scope:'Synthetic renderer: remaining provider readiness and narrow window checks.'};
try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',err=>report.errors.push(err.message));
  await page.getByRole('button',{name:'Bring your own task',exact:true}).click();
  await page.getByRole('textbox',{name:'Task material and context',exact:true}).fill('A sample proposal');
  const connections=await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).connections);
  await page.evaluate(items=>window.__exominaPreviewSetConnections(items.map(item=>({...item,connected:false,configured:false}))),connections);
  await page.getByText('Connection needed',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Review task request',exact:true}).isDisabled(),true);
  await page.evaluate(items=>window.__exominaPreviewSetConnections(items),connections);
  await page.getByRole('combobox',{name:'Task AI',exact:true}).selectOption('codex');
  await page.getByText('ChatGPT connected',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Review task request',exact:true}).isDisabled(),false);
  report.checks.push('Missing provider connections block starting; restoring a connected provider allows review.');
  await page.setViewportSize({width:840,height:760});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const material=await page.getByRole('textbox',{name:'Task material and context',exact:true}).boundingBox();assert.ok(material.width>200);
  await page.getByRole('button',{name:'Review task request',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'task-narrow.png')});
  report.checks.push('Task setup is usable at 840×760 with no horizontal page overflow.');
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(err){report.failure=err.stack;throw err;}finally{await writeFile(path.join(output,'readiness-result.json'),JSON.stringify(report,null,2));await app.close();await server.close();}
console.log(JSON.stringify(report,null,2));
