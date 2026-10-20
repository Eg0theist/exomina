// Real renderer, synthetic backend. Walks every start-screen tip and every tutorial step.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve('../Workspace/qa-tutorials');await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:0},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Hidden real renderer with synthetic data.',checks:{},tips:[],steps:[],missingTargets:[],errors:[]};let app;
try {
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  const home=async()=>{await page.getByRole('button',{name:'Exomina home',exact:true}).click();await page.locator('.welcome-hero').waitFor();};
  const guide=page.getByLabel('Tutorial walkthrough');
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.evaluate(()=>localStorage.removeItem('exomina.tips.hidden'));await page.reload();await page.locator('.welcome-tip').waitFor();
  await page.screenshot({path:path.join(output,'home-tip.png')});
  // Every tip opens its tutorial at the step that explains it.
  for(let k=0;k<7;k++){
    // The tip keeps its place while the start screen stays mounted, so advance once per round.
    await home();if(k)await page.locator('.welcome-tip').getByRole('button',{name:'Next tip',exact:true}).click();
    const text=await page.locator('.welcome-tip span').innerText();
    await page.locator('.welcome-tip').getByRole('button',{name:'Show me',exact:true}).click();await guide.waitFor();
    const heading=await guide.locator('small').innerText(),title=await guide.locator('h2').innerText();report.tips.push({text,heading,title});
    await page.getByRole('button',{name:'Close tutorial',exact:true}).click();
  }
  assert.equal(new Set(report.tips.map(t=>t.text)).size,7,'seven distinct tips');
  report.checks.tipsOpenTutorialSteps=true;
  // Hiding tips sticks, and Tutorials can bring them back.
  await home();await page.getByRole('button',{name:'Hide tips',exact:true}).click();assert.equal(await page.locator('.welcome-tip').count(),0);
  await (await home(),page.getByRole('button',{name:/Learn Exomina/}).click());await page.getByRole('heading',{name:'Learn Exomina'}).waitFor();
  const toggle=page.getByLabel('Show a tip on the start screen');assert.equal(await toggle.isChecked(),false);await home();assert.equal(await page.locator('.welcome-tip').count(),0);
  await (await home(),page.getByRole('button',{name:/Learn Exomina/}).click());await toggle.check();await home();await page.locator('.welcome-tip').waitFor();
  report.checks.hideAndRestoreTips=true;
  await (await home(),page.getByRole('button',{name:/Learn Exomina/}).click());await page.getByRole('heading',{name:'Learn Exomina'}).waitFor();
  assert.equal(await page.locator('.tutorial-card').count(),10);assert.match(await page.locator('.tutorial-card').first().innerText(),/Getting the most out of Exomina[\s\S]*Start here/);
  await page.screenshot({path:path.join(output,'tutorials.png')});report.checks.tenCardsHabitsFirst=true;
  // Every step: Show me must find and highlight its target.
  const cards=await page.locator('.tutorial-card strong').allInnerTexts();
  for(const [index,name] of cards.entries()){
    await (await home(),page.getByRole('button',{name:/Learn Exomina/}).click());await page.locator('.tutorial-card').nth(index).click();await guide.waitFor();
    for(let step=0;;step++){
      const title=await guide.locator('h2').innerText();
      await guide.getByRole('button',{name:'Show me',exact:true}).click();
      const found=await page.waitForFunction(()=>document.querySelector('.tutorial-highlight'),null,{timeout:2500}).then(()=>true,()=>false);
      report.steps.push({tutorial:name,step:step+1,title,found});if(!found)report.missingTargets.push(`${name} → ${title}`);
      if(index===0&&step===0)await page.screenshot({path:path.join(output,'habits-step.png')});
      const finish=guide.getByRole('button',{name:'Finish',exact:true});
      if(await finish.count()){await finish.click();break;}
      await guide.getByRole('button',{name:'Next',exact:true}).click();
    }
  }
  await (await home(),page.getByRole('button',{name:/Learn Exomina/}).click());assert.match(await page.locator('.tutorial-card').first().innerText(),/Completed · Replay/);assert.doesNotMatch(await page.locator('.tutorial-card').first().innerText(),/Start here/);
  report.checks.completionClearsStartHere=true;
  assert.deepEqual(report.errors,[]);report.passed=report.missingTargets.length===0;if(!report.passed)process.exitCode=1;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
