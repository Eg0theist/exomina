// Real renderer and production activity mapper. Synthetic receipts only; no
// personal profiles, account stores, authenticated runtimes or external network.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {extractFile} from '@electron/asar';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {RunActivity} from '../desktop/activity.mjs';
import {nativeHelperStep} from '../desktop/helper-step.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.resolve(process.argv[2]||'../Workspace/qa-activity-helper-details');
await mkdir(output,{recursive:true});
const archive=process.env.EXOMINA_QA_PACKAGED_ASAR,resources={},prefix='/__qa_helpers/';
let html='<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="./entry.mjs"></script></body></html>',entry,packagedRenderer=null;
if(archive){
  html=extractFile(archive,'dist/index.html').toString('utf8');entry=/<script\b[^>]*src="\.\/([^" ]+\.js)"[^>]*><\/script>/.exec(html);assert.ok(entry);
  packagedRenderer={archive:path.resolve(archive),version:JSON.parse(extractFile(archive,'package.json')).version,build:JSON.parse(await readFile(path.resolve(path.dirname(archive),'../exomina.build.json'),'utf8')),resources};
}
const startedAt=new Date().toISOString(),events=[],current={id:'current-reply',role:'assistant',provider:'codex',content:'The parent answer remains separate.',startedAt};
const activity=new RunActivity(current,{conversationId:'c1',emit:event=>events.push(structuredClone(event))});
activity.tool({id:'problem',name:'workspace_read',status:'error',detail:'Synthetic file could not be read.',output:'Synthetic file missing.'});
activity.helper({id:'native-one',kind:'native',provider:'codex',sourceProvider:'codex',nativeThreadId:'one',name:'Reviewer',task:'Review only the parser change.',effectiveModel:'gpt-runtime-reported',configuredModel:'gpt-configured',status:'running'});
activity.helper({id:'native-two',kind:'native',provider:'codex',sourceProvider:'codex',nativeThreadId:'two',name:'Tests',task:'Check only the regression tests.',configuredModel:'gpt-configured-only',status:'waiting'});
activity.tool({id:'native-start',name:'subAgentActivity',status:'done',helper:nativeHelperStep({type:'subAgentActivity',agentThreadId:'one',agentPath:'/root/reviewer',kind:'started'})});
activity.tool({id:'collab',name:'collabAgentToolCall',status:'done',helper:nativeHelperStep({type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['two'],prompt:'Check only the regression tests.',model:'gpt-requested-alias',agentsStates:{two:{status:'pendingInit'}}})});
activity.tool({id:'unlinked',name:'subAgentActivity',status:'done'});
const earlier={id:'claude-reply',role:'assistant',provider:'claude',content:'Earlier Claude task completed.',startedAt,finishedAt:startedAt},earlierActivity=new RunActivity(earlier,{conversationId:'c1',emit:()=>{}});
earlierActivity.helper({id:'native-claude',kind:'native',provider:'claude',sourceProvider:'claude',nativeToolUseId:'claude-use',task:'Review the saved UI draft.',effectiveModel:'claude-runtime-reported',status:'complete'});
earlierActivity.tool({id:'continuation:claude-use',nativeToolUseId:'claude-use',name:'Agent',status:'done',input:{prompt:'Review the saved UI draft.',model:'sonnet'}});
const fixture=`const chat=await window.studio.invoke('conversations.get',{id:'c1'});chat.provider='codex';chat.title='Helper details QA';chat.messages=[{id:'user',role:'user',content:'Synthetic helper display check.'},${JSON.stringify(earlier)},${JSON.stringify(current)}];window.__exominaPreviewReplaceChat(chat);window.__exominaPreviewSetRun('c1',${JSON.stringify(startedAt)});window.__qaEmit=event=>window.__exominaPreviewEmit(event);`;
const plugin={name:'isolated-activity-helper-fixture',configureServer(server){server.middlewares.use((request,response,next)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;if(!pathname.startsWith(prefix))return next();const file=decodeURIComponent(pathname.slice(prefix.length));
  if(!file||file.split('/').some(part=>!part||part==='..'||part==='.')||file.includes('\\')){response.statusCode=400;return response.end();}
  try{let content,mime;if(file==='index.html'){content=archive?html.replace(entry[0],entry[0].replace('./'+entry[1],'./entry.mjs')):html;mime='text/html';}
    else if(file==='entry.mjs'){content=`import '/preview/mock-studio.mjs';\n${fixture}\nawait import(${JSON.stringify(archive?'./'+entry[1]:'/src/main.jsx')});`;mime='text/javascript';}
    else if(archive){content=extractFile(archive,path.join('dist',...file.split('/')));resources[`dist/${file}`]={bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};mime=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream';}
    else return next();response.setHeader('Content-Type',mime);response.setHeader('Cache-Control','no-store');response.end(content);
  }catch{response.statusCode=404;response.end('QA resource unavailable');}
});}};
const server=await createServer({root,plugins:[plugin],server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_DIR:output,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}${prefix}index.html`};delete env.ELECTRON_RUN_AS_NODE;
const report={output,packagedRenderer,scope:'Hidden Electron real renderer and production RunActivity mapper; synthetic helper metadata, fresh QA profile, external requests denied, no account stores or authenticated provider calls.',checks:{},errors:[]};let app,page;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],cwd:root,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
  await page.locator('[data-chat-id="c1"] .chat-open').click();const work=page.locator('.activity').last(),problem=work.locator('.activity-problem-details');await problem.waitFor();
  for(let i=0;i<3;i++){
    await problem.getByText('View details',{exact:true}).click();assert.equal(await problem.getAttribute('aria-expanded'),'true');assert.equal(await work.locator('.activity-head').getAttribute('aria-expanded'),'true');await work.locator('.activity-work-details').waitFor();
    await problem.getByText('Hide details',{exact:true}).click();assert.equal(await problem.getAttribute('aria-expanded'),'false');assert.equal(await work.locator('.activity-head').getAttribute('aria-expanded'),'false');assert.equal(await work.locator('.activity-work-details').count(),0);
  }
  report.checks.problemDetailsButtonOpensAndClosesRepeatedlyWithAccessibleState=true;
  await problem.click();const rows=work.locator('.native-kind-helper');assert.equal(await rows.count(),3);
  const reviewer=rows.nth(0);assert.match(await reviewer.textContent(),/ChatGPT.*gpt-runtime-reported \(reported\).*Running/);await reviewer.getByText('Review only the parser change.',{exact:true}).waitFor();assert.equal(await reviewer.getByText('Check only the regression tests.',{exact:true}).count(),0);
  const configured=rows.nth(1);await configured.getByText('gpt-configured-only (configured)',{exact:true}).waitFor();await configured.getByText('Runtime model not reported',{exact:true}).waitFor();await configured.getByText('Check only the regression tests.',{exact:true}).waitFor();await configured.getByText('Waiting',{exact:true}).waitFor();assert.equal(await configured.getByText(/gpt-configured-only \(reported\)/).count(),0);
  assert.equal(await work.getByText('Used sub agent activity',{exact:true}).count(),0);report.checks.nativeActivityShowsExactProviderModelTaskStatusAndConfiguredUnknown=true;
  const unlinked=rows.nth(2);await unlinked.getByText('Runtime model not reported',{exact:true}).waitFor();await unlinked.getByText('Task not reported',{exact:true}).waitFor();await unlinked.getByText('Status not reported',{exact:true}).waitFor();assert.equal(await unlinked.getByText('gpt-runtime-reported (reported)',{exact:true}).count(),0);await unlinked.locator('.step-head').click();await unlinked.getByText('A matching helper receipt was not available. Only the identity fields supplied with this activity are shown.',{exact:true}).waitFor();report.checks.legacyUnlinkedRowsNeverBorrowNearbyIdentityOrInventCompletion=true;
  const claude=page.locator('.activity').first();await claude.locator('.activity-head').click();const claudeRow=claude.locator('.native-kind-helper');assert.match(await claudeRow.textContent(),/Claude.*claude-runtime-reported \(reported\).*Completed/);await claudeRow.getByText('Review the saved UI draft.',{exact:true}).waitFor();report.checks.claudeToolUseIdentityRemainsExactAcrossContinuationPrefix=true;
  activity.helper({id:'native-one',status:'complete',summary:'Verified synthetic completion.'});await page.evaluate(event=>window.__qaEmit(event),events.at(-1));await reviewer.getByText('Completed',{exact:true}).waitFor();assert.equal(await rows.count(),3);await page.getByText('The parent answer remains separate.',{exact:true}).waitFor();
  const card=page.locator('.helper-card').filter({has:page.locator('.helper-task-preview').getByText('Check only the regression tests.',{exact:true})});await card.locator('summary').getByText('Runtime model not reported',{exact:true}).waitFor();await card.locator('summary').click();assert.notEqual(await card.getAttribute('open'),null);await card.locator('summary').click();assert.equal(await card.getAttribute('open'),null);report.checks.liveHelperReceiptsUpdateRowsAndCardsAndCardsToggleClosed=true;
  await page.screenshot({path:path.join(output,'helper-activity-wide.png')});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,900));
  for(const item of [work,claude,card]){const bounds=await item.evaluate(element=>{const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,width:innerWidth};});assert.ok(bounds.left>=-1&&bounds.right<=bounds.width+1);}
  await page.screenshot({path:path.join(output,'helper-activity-narrow.png')});report.checks.helperRowsAndCardsFitNarrowRenderer=true;assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
