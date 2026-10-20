// Probe: outer chat position while a reply streams and the reader clicks inside messages.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-live-click-'));
const server=await createServer({root,server:{port:5195,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const log=[];let app;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>log.push('pageerror '+e.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(async()=>{const chat=await window.studio.invoke('conversations.get',{id:'c1'});
    chat.messages=Array.from({length:30},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',provider:'claude',content:`Message ${i}. `+'Readable paragraph text for wrapping. '.repeat(i%2?40:4),...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:30},(_,n)=>({id:`s-${i}-${n}`,kind:'note',text:'Work note. '.repeat(10)}))}:{})}));
    window.__exominaPreviewReplaceChat(chat);});
  await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(400);
  const state=()=>page.locator('.chat-scroll').evaluate(el=>{const box=el.getBoundingClientRect();const mid=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('[data-message-index]');return{top:Math.round(el.scrollTop),gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),mid:mid?.dataset.messageIndex};});
  const start=()=>page.evaluate(async()=>{const now=new Date().toISOString(),chat=await window.studio.invoke('conversations.get',{id:'c1'});chat.messages.push({role:'user',content:'Live question'},{id:'live',role:'assistant',provider:'claude',startedAt:now,content:'',activity:[]});window.__exominaPreviewSetRun('c1',now);window.__exominaPreviewReplaceChat(chat);window.__exominaPreviewEmit({type:'chat.started',conversationId:'c1',provider:'claude',messageId:'live',startedAt:now,text:'Live question'});
    let n=0;window.__streamed={text:'',steps:[]};window.__streamTimer=setInterval(()=>{n++;if(n%3){const text='Streamed words keep arriving here. '.repeat(3);window.__streamed.text+=text;window.__exominaPreviewEmit({type:'chat.delta',conversationId:'c1',text});}else{const step={id:'live-'+n,kind:'note',text:'Live work note. '.repeat(12)};window.__streamed.steps.push(step);window.__exominaPreviewEmit({type:'chat.activity',conversationId:'c1',step});}},60);});
  const clickVisible=async sel=>{const box=await page.locator('.chat-scroll').boundingBox();for(const item of await page.locator(sel).all()){const b=await item.boundingBox();if(!b)continue;const t=Math.max(b.y,box.y+40),bt=Math.min(b.y+b.height,box.y+box.height-40);if(bt-t>8){await page.mouse.click(b.x+Math.min(b.width/2,60),(t+bt)/2);return true;}}return false;};
  await start();await page.waitForTimeout(800);
  // A: at bottom while streaming, click inside last reply and work details
  for(const sel of ['.message.assistant:last-child .message-content','.message.assistant:last-child .activity-head','.message.user:nth-last-child(2) .user-bubble']){
    const b=await state();const ok=await clickVisible(sel);await page.waitForTimeout(700);const a=await state();log.push(`bottom click ${sel} clicked=${ok} top ${b.top}->${a.top} gap ${b.gap}->${a.gap} mid ${b.mid}->${a.mid}`);
  }
  // B: scrolled up while streaming
  await page.locator('.chat-scroll').hover();await page.mouse.wheel(0,-6000);await page.waitForTimeout(2000);
  for(const sel of ['.message.assistant .message-content','.message.user .user-bubble','.message.assistant .activity-head','.message.assistant .message-content']){
    const b=await state();const ok=await clickVisible(sel);await page.waitForTimeout(900);const a=await state();log.push(`upper click ${sel} clicked=${ok} top ${b.top}->${a.top} gap ${b.gap}->${a.gap} mid ${b.mid}->${a.mid}`);
  }
  // C: finish the run while reader is in the last reply's text
  await page.locator('.chat-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(300);
  await page.mouse.wheel(0,-300);await page.waitForTimeout(1500);
  const b=await state();
  await page.evaluate(async()=>{clearInterval(window.__streamTimer);const chat=await window.studio.invoke('conversations.get',{id:'c1'});const last=chat.messages[chat.messages.length-1];last.content=window.__streamed.text;last.activity=window.__streamed.steps;last.finishedAt=new Date().toISOString();window.__exominaPreviewReplaceChat(chat);await new Promise(r=>setTimeout(r,300));window.__exominaPreviewSetRun('c1',null);window.__heights=()=>[...document.querySelectorAll('[data-message-index]')].slice(-3).map(m=>m.offsetHeight);window.__before=window.__heights();window.__exominaPreviewEmit({type:'chat.complete',conversationId:'c1'});});
  await page.waitForTimeout(1200);const a=await state();log.push('last3 heights '+JSON.stringify(await page.evaluate(()=>[window.__before,window.__heights()])));log.push(`finish while near bottom top ${b.top}->${a.top} gap ${b.gap}->${a.gap} mid ${b.mid}->${a.mid}`);
  await page.screenshot({path:path.join(output,'end.png')});
}catch(e){log.push('ERROR '+e.stack);}finally{await app?.close();await server.close();await writeFile(path.join(output,'log.txt'),log.join('\n'));console.log(log.join('\n'));}
