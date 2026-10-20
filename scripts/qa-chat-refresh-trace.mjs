// Trace: per-message heights and scrollTop across a background state refresh while scrolled up.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-refresh-trace-'));
const server=await createServer({root,server:{port:5193,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  await page.evaluate(async()=>{const chat=await window.studio.invoke('conversations.get',{id:'c1'});
    chat.messages=Array.from({length:40},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',provider:'claude',content:`Message ${i}. `+'Readable paragraph text for wrapping. '.repeat(i%2?40:4),...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:30},(_,n)=>({id:`s-${i}-${n}`,kind:'note',text:'Work note. '.repeat(10)}))}:{})}));
    window.__exominaPreviewReplaceChat(chat);});
  await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(300);
  await page.locator('.chat-scroll').hover();await page.mouse.wheel(0,-8000);await page.waitForTimeout(2000);console.log("settled",await page.locator(".chat-scroll").evaluate(el=>el.scrollTop));await page.waitForTimeout(500);console.log("settled2",await page.locator(".chat-scroll").evaluate(el=>el.scrollTop));
  const trace=await page.evaluate(()=>new Promise(resolve=>{
    const el=document.querySelector('.chat-scroll'),snap=label=>({label,top:Math.round(el.scrollTop),height:el.scrollHeight,stick:undefined,msgs:[...el.querySelectorAll('[data-message-index]')].map(m=>Math.round(m.offsetHeight))});
    const out=[snap('before')];const tops=[];el.addEventListener('scroll',()=>tops.push(Math.round(el.scrollTop)));
    window.__exominaPreviewEmit({type:'state.changed'});
    let n=0;const tick=()=>{out.push(snap('frame'+n));if(++n<20)requestAnimationFrame(tick);else resolve({out,tops});};requestAnimationFrame(tick);
  }));
  const base=trace.out[0];console.log('before top',base.top,'height',base.height,'count',base.msgs.length);
  for(const s of trace.out.slice(1)){const diff=s.msgs.map((h,i)=>h!==base.msgs[i]?`#${i}:${base.msgs[i]}->${h}`:null).filter(Boolean);if(s.top!==base.top||diff.length||s.height!==base.height)console.log(s.label,'top',s.top,'height',s.height,'count',s.msgs.length,diff.slice(0,8).join(' '));}
  console.log('scroll events',trace.tops.join(','));
}finally{await app?.close();await server.close();}
