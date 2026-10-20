import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve('../Workspace/prospect-task-20261013'),server=await createServer({root,server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'limits-profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});
const report={passed:false,checks:[],errors:[],scope:'Synthetic renderer: reported usage limits and permission labels.'};
try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',err=>report.errors.push(err.message));
  await page.getByRole('button',{name:'Bring your own task',exact:true}).click();
  await page.getByRole('textbox',{name:'Task material and context',exact:true}).fill('A sample proposal');
  await page.getByRole('combobox',{name:'Task AI',exact:true}).selectOption('codex');
  await page.evaluate(()=>window.__exominaPreviewSetUsage({codex:{provider:'codex',ordinaryUsageAllowed:false,fetchStatus:'ready',updatedAt:new Date().toISOString(),windows:[]}}));
  await page.getByText('The selected AI reports its usage limit has been reached. Choose another connected AI, or wait for the limit to reset.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Review task request',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.__exominaPreviewSetUsage({codex:{provider:'codex',ordinaryUsageAllowed:true,fetchStatus:'ready',updatedAt:new Date().toISOString(),windows:[]}}));
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Review task request')).disabled);
  await page.getByText('Permissions: Ask before acting. Browser: built-in · tools on. Computer use: off.',{exact:true}).waitFor();
  await page.evaluate(()=>window.studio.invoke('settings.save',{browserSource:'connected',permissionMode:'full'}));
  await page.getByText('Permissions: Full access. Browser: your connected browser · tools on. Computer use: off.',{exact:true}).waitFor();
  await page.setViewportSize({width:840,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.getByRole('button',{name:'Review task request',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'task-access.png')});
  report.checks.push('Reported provider exhaustion blocks review, renewed availability unblocks it, and tool source and permission labels reflect settings.');
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(err){report.failure=err.stack;throw err;}finally{await writeFile(path.join(output,'limits-result.json'),JSON.stringify(report,null,2));await app.close();await server.close();}
console.log(JSON.stringify(report,null,2));
