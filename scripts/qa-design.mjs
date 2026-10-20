// Design QA: drives the real renderer against the synthetic preview backend
// (preview/mock-studio.mjs) and saves screenshots. No vault, accounts or private
// data are involved. Usage: node scripts/qa-design.mjs [output folder]
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import path from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const root=process.cwd();
const output=path.resolve(process.argv[2]||path.join(tmpdir(),'exomina-design-qa'));
await mkdir(output,{recursive:true});
const server=await createServer({root,server:{port:5181,strictPort:false},logLevel:'error'});
await server.listen();
const url=`http://localhost:${server.config.server.port}/preview.html`;
const env={...process.env,EXOMINA_DESIGN_QA_URL:url,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts','qa-design-main.cjs')],env,timeout:30000});
const shots=[];const errors=[];
try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const shot=async name=>{await page.waitForTimeout(250);const file=path.join(output,`${name}.png`);await page.screenshot({path:file});shots.push(file);};
  await page.getByRole('button',{name:'Exomina home'}).waitFor();
  await page.getByRole('heading',{name:/^(Good (morning|afternoon|evening)|Up late)\.$/}).waitFor();
  await shot('01-home');
  await page.getByLabel('Message',{exact:true}).fill('Please run the production build and tell me if anything is broken.');
  await page.getByRole('button',{name:'Send message'}).click();
  await page.getByRole('button',{name:'Allow once'}).waitFor();
  await shot('02-running-approval');
  await page.locator('.usage-summary').dispatchEvent('click');
  await page.locator('.usage-details').waitFor();
  await shot('02b-usage');
  await page.locator('.usage-summary').dispatchEvent('click');
  await page.getByLabel('Message',{exact:true}).fill('Also check the bundle size warning afterwards.');
  await page.getByRole('button',{name:'Send follow-up',exact:true}).click();
  await page.locator('.live-followup[data-status="answered"]').waitFor();
  if(!await page.getByRole('button',{name:'Stop this reply',exact:true}).count())throw Error('The original task stopped while answering a follow-up.');
  await shot('03-follow-up-answered-during-work');
  await page.getByRole('button',{name:'Allow once'}).click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Stop this reply"]')&&!document.querySelector('.queued-item'),null,{timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('.activity.is-running'),null,{timeout:30000});
  await shot('04-finished');
  await page.locator('.activity-head').first().click();
  await shot('05-timeline-expanded');
  await page.locator('.activity-step.tool .step-head').nth(1).click();
  await shot('06-step-details');
  // Its answer remains available after the original task finishes.
  await page.getByText('The warning concerns bundle size.',{exact:false}).waitFor({timeout:20000});
  await shot('06b-follow-up-answered');
  await page.keyboard.press('Control+,');
  await page.locator('#settings-appearance').scrollIntoViewIfNeeded();
  await page.getByRole('radio',{name:/^Paper/}).click();
  await page.getByRole('button',{name:'Text colour Navy'}).click();
  await page.locator('.text-color-row').scrollIntoViewIfNeeded();
  await shot('07-paper-text-colour');
  await page.locator('#settings-personalization').scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:'Add style'}).click();
  await page.locator('#settings-personalization').scrollIntoViewIfNeeded();
  await shot('07b-personalization');
  await page.locator('#settings-messaging').scrollIntoViewIfNeeded();
  await shot('07c-messaging');
  await page.locator('#settings-sounds').scrollIntoViewIfNeeded();
  await shot('08-sounds');
  await page.getByRole('radio',{name:/^Erebus/}).click();
  await page.locator('.text-swatch.theme-default').click();
  await page.getByRole('button',{name:'Exomina home'}).click();
  await shot('09-home-erebus');
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByText('Let your AI use this computer').waitFor();
  await page.locator('.driver-panel').scrollIntoViewIfNeeded();
  await shot('10-computer-use');
}catch(error){console.log(JSON.stringify({failed:error.message.split('\n')[0],errors},null,2));throw error;}finally{
  await app.close().catch(()=>{});await server.close();
  await rm(path.join(output,'profile'),{recursive:true,force:true}).catch(()=>{});
}
console.log(JSON.stringify({output,shots:shots.map(file=>path.basename(file)),errors},null,2));
if(errors.length)process.exitCode=1;
