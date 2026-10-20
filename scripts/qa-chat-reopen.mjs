// Real production renderer, synthetic conversations/assets and a hidden Electron window.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-reopen-'));
const png=await readFile(path.join(root,'build/icon.png'));
const asset={kind:'image',mimeType:'image/png',bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),dataBase64:png.toString('base64')};
const server=await createServer({root,server:{port:5189,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Hidden native Electron and the real renderer; synthetic long chat, delayed PNG assets, nested activity and live events. No personal stores.',checks:{},errors:[]};let app,page;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(async asset=>{
    const invoke=window.studio.invoke.bind(window.studio);
    const attachment=await invoke('attachment.put',{mimeType:asset.mimeType,dataBase64:asset.dataBase64,name:'synthetic-icon.png'});
    window.__exominaPreviewAssetDelay=850;
    const chat=await invoke('conversations.get',{id:'c1'});chat.title='Synthetic Exomina Setup';
    chat.messages=Array.from({length:86},(_,i)=>({id:'synthetic-'+i,role:i%2?'assistant':'user',provider:'claude',content:`Message ${i}: ${i===17?'Exomina Setup historical answer. ':''}`+'A synthetic paragraph with realistic wrapping and delayed content. '.repeat(i%2?60:4),
      ...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:45},(_,n)=>({id:`step-${i}-${n}`,kind:'note',text:'Synthetic activity paragraph. '.repeat(8)}))}:{}),
      ...(i%11===1?{attachments:[attachment]}:{})}));
    chat.messages.push({id:'last-marker',role:'assistant',provider:'claude',content:'FINAL REOPEN MARKER'});window.__exominaPreviewReplaceChat(chat);
  },asset);
  const gap=()=>page.locator('.chat-scroll').evaluate(el=>({gap:el.scrollHeight-el.scrollTop-el.clientHeight,top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight,content:el.firstElementChild?.getBoundingClientRect().height}));
  const open=async()=>{await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(75);};
  await open();report.checks.initial=await gap();
  await page.waitForFunction(()=>document.querySelectorAll('.message img').length===8&&[...document.querySelectorAll('.message img')].every(img=>img.complete&&img.naturalWidth));
  await page.waitForTimeout(100);report.checks.afterDelayedImages=await gap();assert.ok(report.checks.afterDelayedImages.gap<3,'late image loading must preserve the bottom');
  for(const section of ['Memory','Connections','Projects & prompts']){await page.getByRole('button',{name:section,exact:true}).click();await open();report.checks[section]=await gap();assert.ok(report.checks[section].gap<3,section+' must reopen at the bottom');}
  await page.locator('[data-chat-id="c2"] .chat-open').click();await open();assert.ok((await gap()).gap<3);report.checks.otherChat=true;
  await page.getByRole('button',{name:'Scroll to top of chat',exact:true}).click();await open();assert.ok((await gap()).gap<3);report.checks.reselectAfterTop=true;
  await page.getByRole('searchbox',{name:'Search chats',exact:true}).fill('Exomina Setup');await open();report.checks.titleSearchOpensLatest=await gap();assert.ok(report.checks.titleSearchOpensLatest.gap<3,'choosing a matching chat title must open at the bottom, even when an older reply contains the title');
  await page.getByRole('button',{name:'Clear chat search',exact:true}).click();
  // Height changes after insertion need to stay pinned even without text mutations.
  await page.evaluate(()=>{const el=document.createElement('div');el.id='delayed-height';el.style.height='40px';document.querySelector('.message:last-child').append(el);setTimeout(()=>{el.style.height='600px';},250);});
  await page.waitForTimeout(400);report.checks.attributeOnlyGrowth=await gap();assert.ok(report.checks.attributeOnlyGrowth.gap<3);
  // A new active reply can have a separately scrollable work timeline.
  await page.evaluate(async()=>{const now=new Date().toISOString(),chat=await window.studio.invoke('conversations.get',{id:'c1'}),steps=Array.from({length:28},(_,i)=>({id:'live-'+i,kind:'note',text:'Live synthetic work. '.repeat(35)}));chat.messages.push({role:'user',content:'Synthetic live question'},{id:'live-test',role:'assistant',provider:'claude',startedAt:now,content:'',activity:steps});window.__exominaPreviewSetRun('c1',now);window.__exominaPreviewReplaceChat(chat);window.__exominaPreviewEmit({type:'chat.started',conversationId:'c1',provider:'claude',messageId:'live-test',startedAt:now,text:'Synthetic live question'});for(const step of steps)window.__exominaPreviewEmit({type:'chat.activity',conversationId:'c1',step});});
  await page.waitForTimeout(200);await page.getByRole('button',{name:'Memory',exact:true}).click();await open();assert.ok((await gap()).gap<3);report.checks.reopenDuringWork=true;
  const inner=page.locator('.activity.is-running .activity-steps');
  await inner.evaluate(el=>{if(el.scrollHeight-el.clientHeight<100)throw Error('Synthetic timeline must be scrollable');el.scrollTop=150;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));el.scrollTop=50;});
  await page.evaluate(()=>window.__exominaPreviewEmit({type:'chat.delta',conversationId:'c1',text:'A longer streaming answer. '.repeat(150)}));
  await page.waitForTimeout(200);report.checks.nestedScrollDoesNotUnpin=await gap();assert.ok(report.checks.nestedScrollDoesNotUnpin.gap<3,'scrolling inner activity must not unpin outer chat');
  // The reader's deliberate outer scroll must still be respected.
  await page.locator('.chat-scroll').evaluate(el=>{el.dispatchEvent(new WheelEvent('wheel',{deltaY:-600,bubbles:true}));el.scrollTop-=600;});await page.waitForTimeout(100);const before=await gap();
  await page.evaluate(()=>window.__exominaPreviewEmit({type:'chat.delta',conversationId:'c1',text:'More streamed text. '.repeat(150)}));await page.waitForTimeout(150);const after=await gap();assert.ok(Math.abs(before.top-after.top)<3);report.checks.manualReadingPreserved=true;
  await open();assert.ok((await gap()).gap<3);report.checks.reopenAfterManualReading=true;
  await page.screenshot({path:path.join(output,'latest-message.png')});assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;report.diagnostic=await page?.evaluate(()=>({images:[...document.querySelectorAll('.message img')].map(img=>({complete:img.complete,width:img.naturalWidth})),failures:[...document.querySelectorAll('.image-failure')].map(el=>el.textContent)})).catch(()=>null);process.exitCode=1;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
