// Probe: open chats from the sidebar repeatedly under slow loading, rich content and a background reply.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-chat-switch-stress-'));
const server=await createServer({root,server:{port:5197,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const log=[];let app;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();page.on('pageerror',e=>log.push('pageerror '+e.message));
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
  const ids=await page.evaluate(async()=>{
    const list=(await window.studio.invoke('bootstrap')).conversations.map(c=>c.id);
    const md=i=>`## Section ${i}\n\nSome **bold** text with a [link](https://example.com/${i}) and \`inline code\`.\n\n- point one\n- point two with more words to wrap around the line\n\n\`\`\`js\nconst value${i} = compute(${i});\nconsole.log(value${i});\n\`\`\`\n\n| a | b |\n|---|---|\n| ${i} | ${i*2} |\n\n`+'Paragraph text that wraps across multiple lines in the chat view. '.repeat(25);
    for(const id of list.slice(0,3)){const chat=await window.studio.invoke('conversations.get',{id});
      chat.messages=Array.from({length:50},(_,i)=>({id:id+'m'+i,role:i%2?'assistant':'user',provider:'claude',content:i%2?md(i):'Question '+i+' '+'words '.repeat(30),
        ...(i%2?{startedAt:'2026-10-07T12:00:00Z',finishedAt:'2026-10-07T12:10:00Z',activity:Array.from({length:25},(_,n)=>({id:`${id}s${i}-${n}`,kind:n%3?'note':'tool',name:'Bash',title:'Running a command',status:'done',output:'out '.repeat(40),text:'Work note. '.repeat(10)})),
          followups:i%7===1?[{id:id+'f'+i,question:'Follow-up '+i,answer:'Answer text. '.repeat(30),status:'answered',taskStatus:'handled',summary:'Summary. '.repeat(20)}]:[]}:{})}));
      chat.messages.push({id:id+'END',role:'assistant',provider:'claude',content:'END MARKER '+id});
      window.__exominaPreviewReplaceChat(chat);}
    const original=window.studio.invoke.bind(window.studio);
    window.studio.invoke=async(method,payload)=>{if(method==='conversations.get')await new Promise(r=>setTimeout(r,200+Math.random()*600));return original(method,payload);};
    return list.slice(0,3);});
  log.push('chats '+ids.join(','));
  const gap=()=>page.locator('.chat-scroll').evaluate(el=>({gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),end:!!el.querySelector('.message:last-child')?.textContent.includes('END MARKER')}));
  let fails=0;
  for(let round=0;round<24;round++){
    const id=ids[round%ids.length];
    if(round===8)await page.evaluate(id=>{const now=new Date().toISOString();window.__exominaPreviewSetRun(id,now);window.__exominaPreviewEmit({type:'chat.started',conversationId:id,provider:'claude',messageId:'bg',startedAt:now,text:'bg'});window.__bg=setInterval(()=>window.__exominaPreviewEmit({type:'chat.delta',conversationId:id,text:'Background streamed text. '.repeat(4)}),80);},ids[1]);
    await page.locator(`[data-chat-id="${id}"] .chat-open`).click();
    const samples=[];for(const t of [100,400,900,1600]){await page.waitForTimeout(t-(samples.length?[100,400,900,1600][samples.length-1]:0));samples.push((await gap()).gap);}
    const bad=samples[samples.length-1]>3;if(bad)fails++;
    log.push(`round ${round} ${id} gaps ${samples.join(',')}${bad?'  <-- NOT AT BOTTOM':''}`);
  }
  log.push('fails '+fails);
}catch(e){log.push('ERROR '+e.stack);}finally{await app?.close();await server.close();await writeFile(path.join(output,'log.txt'),log.join('\n'));console.log(log.join('\n'));}
