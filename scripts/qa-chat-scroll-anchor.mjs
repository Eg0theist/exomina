// Probe: after opening a chat and scrolling up, does content above the reading position move what you read?
// Real production renderer, synthetic conversation, hidden Electron window. No personal stores.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-scroll-anchor-'));
const server=await createServer({root,server:{port:5193,strictPort:false,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const report={results:[],errors:[]};let app,page;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  const load=grow=>page.evaluate(async grow=>{
    const chat=await window.studio.invoke('conversations.get',{id:'c1'});
    chat.messages=Array.from({length:40},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',provider:'claude',content:`Message ${i}. `+'Readable paragraph text for wrapping. '.repeat(i%2?(grow&&i<15?80:40):4),
      ...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:30},(_,n)=>({id:`s-${i}-${n}`,kind:'note',text:'Work note. '.repeat(10)}))}:{})}));
    window.__exominaPreviewReplaceChat(chat);
  },grow);
  // The text at the top of the visible chat and its position on screen.
  const reading=()=>page.locator('.chat-scroll').evaluate(el=>{const box=el.getBoundingClientRect();const node=document.elementFromPoint(box.left+box.width/2,box.top+3);const message=node?.closest('[data-message-index]');return{top:Math.round(el.scrollTop),gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),message:message?.dataset.messageIndex,text:(node?.textContent||'').slice(0,40),y:Math.round(node?.getBoundingClientRect().top||0)};});
  const cases={
    'earlier message grows (DOM)':()=>page.locator('.chat-scroll').evaluate(el=>{const m=el.querySelector('[data-message-index="3"]');const pad=document.createElement('div');pad.style.height='900px';m.appendChild(pad);}),
    'earlier work details open':()=>page.locator('.chat-scroll').evaluate(el=>{const h=el.querySelector('[data-message-index="5"] .activity-head');h?.click();}),
    'background refresh with longer earlier replies':()=>load(true),
    'state.changed refresh':()=>page.evaluate(()=>window.__exominaPreviewEmit({type:'state.changed'})),
    'window focus + usage events':()=>page.evaluate(()=>{window.__exominaPreviewEmit({type:'window.changed',window:{focused:true}});window.__exominaPreviewEmit({type:'usage',usage:{}});}),
    'image loads above':()=>page.locator('.chat-scroll').evaluate(el=>new Promise(r=>{const m=el.querySelector('[data-message-index="7"]');const img=document.createElement('img');img.onload=img.onerror=()=>setTimeout(r,50);img.src='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"/>');m.appendChild(img);})),
  };
  for(const [name,change] of Object.entries(cases)){
    await load(false);
    await page.locator('[data-chat-id="c2"] .chat-open').click().catch(()=>{});await page.waitForTimeout(200);
    await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(400);
    await page.locator('.chat-scroll').hover();
    const total=await page.locator('.chat-scroll').evaluate(el=>el.scrollHeight-el.clientHeight);
    await page.mouse.wheel(0,-Math.round(total*0.45));
    // Wheel scrolling animates; wait until the position has moved and settled.
    for(let last=-1,i=0;i<60;i++){await page.waitForTimeout(100);const now=await page.locator('.chat-scroll').evaluate(el=>Math.round(el.scrollTop));if(now===last&&now<total-50)break;last=now;}
    await page.waitForTimeout(300);
    const before=await reading();await change();await page.waitForTimeout(600);const after=await reading();
    const kept=before.message===after.message&&before.text===after.text&&Math.abs(before.y-after.y)<=2;
    report.results.push({name,kept,before,after});
    // Your own scrolling afterwards must not be pulled back to the kept position.
    const settle=async from=>{let last=-1,moved=from===undefined;for(let i=0;i<60;i++){await page.waitForTimeout(100);const now=await page.locator('.chat-scroll').evaluate(el=>Math.round(el.scrollTop));if(!moved&&now!==from)moved=true;if(moved&&now===last)return now;last=now;}return last;};
    const start=await settle();await page.mouse.wheel(0,-600);const up=await settle(start);const under=await page.locator('.chat-scroll').evaluate(el=>{const b=el.getBoundingClientRect();let n=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);const chain=[];for(;n&&n!==el;n=n.parentElement)if(n.scrollHeight>n.clientHeight+1&&/auto|scroll/.test(getComputedStyle(n).overflowY))chain.push(n.className);return chain;});const edge=await page.locator('.chat-scroll').boundingBox();await page.mouse.move(edge.x+6,edge.y+edge.height/2);await page.mouse.wheel(0,900);const down=await settle(up);
    report.results.push({name:`${name}: free scrolling afterwards`,kept:up<start-300&&down>up+500,start,up,down,under});
  }
  // Still pinned at the bottom when you haven't scrolled.
  await load(false);await page.locator('[data-chat-id="c1"] .chat-open').click();await page.waitForTimeout(400);
  await page.locator('.chat-scroll').evaluate(el=>{const m=el.querySelector('[data-message-index="3"]');const pad=document.createElement('div');pad.style.height='900px';m.appendChild(pad);});await page.waitForTimeout(400);
  report.results.push({name:'unscrolled chat stays at newest',kept:(await reading()).gap<=2,state:await reading()});
}catch(error){report.error=error.stack;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report.results.map(r=>({name:r.name,kept:r.kept,before:r.before&&`${r.before.message}@${r.before.y}`,after:r.after&&`${r.after.message}@${r.after.y}`})),null,1));if(report.error)console.log(report.error);if(report.errors.length)console.log('page errors',report.errors);}
