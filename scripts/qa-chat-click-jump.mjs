// Probe: does clicking inside chat messages move the outer chat scroll position?
// Real production renderer, synthetic conversation, hidden Electron window. No personal stores.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-click-jump-'));
const server=await createServer({root,server:{port:5191,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const report={results:[],errors:[]};let app,page;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(async()=>{
    const chat=await window.studio.invoke('conversations.get',{id:'c1'});
    chat.messages=Array.from({length:40},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',provider:'claude',content:`Message ${i}. `+'Readable paragraph text for wrapping. '.repeat(i%2?40:4),
      ...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:30},(_,n)=>({id:`s-${i}-${n}`,kind:'note',text:'Work note. '.repeat(10)}))}:{})}));
    window.__exominaPreviewReplaceChat(chat);
  });
  await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(300);
  const state=()=>page.locator('.chat-scroll').evaluate(el=>{const box=el.getBoundingClientRect();const mid=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('[data-message-index]');return{top:Math.round(el.scrollTop),gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),midMessage:mid?.dataset.messageIndex,active:document.activeElement?.className||document.activeElement?.tagName};});
  const scrollTo=async(fraction)=>{await page.locator('.chat-scroll').hover();const total=await page.locator('.chat-scroll').evaluate(el=>el.scrollHeight-el.clientHeight);const now=(await state()).top;await page.mouse.wheel(0,Math.round(total*fraction)-now);await page.waitForTimeout(250);};
  const probe=async(name,locate,position)=>{
    for(const where of position){
      if(where==='bottom'){await page.locator('.chat-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(200);}else await scrollTo(where);
      const target=await locate();if(!target){report.results.push({name,where,skipped:'no visible target'});continue;}
      const before=await state();await page.mouse.click(target.x,target.y);await page.waitForTimeout(400);const after=await state();
      report.results.push({name,where,before,after,moved:after.top-before.top});
      if(await page.locator('.activity.is-open .activity-head').count())for(const h of await page.locator('.activity.is-open .activity-head').all())await h.evaluate(b=>b.click());
    }
  };
  const visible=async sel=>{const items=await page.locator(sel).all();const box=await page.locator('.chat-scroll').boundingBox();for(const item of items){const b=await item.boundingBox();if(!b)continue;const top=Math.max(b.y,box.y+40),bottom=Math.min(b.y+b.height,box.y+box.height-40);if(bottom-top>8)return{x:b.x+Math.min(b.width/2,60),y:(top+bottom)/2};}return null;};
  const positions=[0.45,'bottom'];
  await probe('assistant paragraph text',()=>visible('.message.assistant .message-content p'),positions);
  await probe('user bubble text',()=>visible('.message.user .user-bubble'),positions);
  await probe('Work details toggle',()=>visible('.activity-head'),positions);
  await probe('Copy reply button',()=>visible('.message.assistant .message-actions .copy-button'),positions);
  await probe('blank area of messages',()=>visible('.message.assistant .message-meta'),positions);
  // Window focus/refresh events that a click into an unfocused window can trigger.
  for(const where of [0.3,0.6,'bottom']){
    if(where==='bottom'){await page.locator('.chat-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.waitForTimeout(200);}else await scrollTo(where);
    for(const event of [{type:'window.changed',window:{focused:true}},{type:'state.changed'},{type:'usage',usage:{}}]){
      const before=await state();await page.evaluate(e=>window.__exominaPreviewEmit(e),event);await page.waitForTimeout(500);const after=await state();
      report.results.push({name:'event '+event.type,where,before,after,moved:after.top-before.top});
    }
  }
}catch(error){report.error=error.stack;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,1));}
