// Real renderer, synthetic chats and notes only. No provider or account access.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve('../Workspace/chat-memory-delete-20261013'),server=await createServer({root,server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'ui-profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000}),report={passed:false,checks:[],errors:[],scope:'Synthetic Electron renderer. No real chats or memories deleted.'};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',err=>report.errors.push(err.message));await page.waitForFunction(()=>window.studio&&window.__exominaPreviewSetMemories);
 const original=await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).conversations);
 const notes=[{id:'exclusive',text:'Only chat A',chatOwned:true,sourceChatIds:['c1']},{id:'shared',text:'Shared between A and B',chatOwned:true,sourceChatIds:['c1','c2']},{id:'manual',text:'Manually saved independent note',chatOwned:false,sourceChatIds:['c1']},{id:'legacy',text:'Older unlinked memory'},{id:'unrelated',text:'Only chat B',chatOwned:true,sourceChatIds:['c2']}].map(note=>({...note,reviewed:true,date:new Date().toISOString()}));
 const reset=async()=>{await page.evaluate(({chats,notes})=>{window.__exominaPreviewSetChats(chats);window.__exominaPreviewSetMemories(notes);},{chats:original,notes});};
 const open=async()=>{await page.getByRole('button',{name:'More options for Exomina UI and permissions overhaul',exact:true}).click();await page.getByRole('menuitem',{name:'Delete',exact:true}).click();await page.getByRole('checkbox',{name:'Also delete memories associated with this chat',exact:true}).waitFor();await page.waitForFunction(()=>![...document.querySelectorAll('input[type=checkbox]')].find(el=>el.getAttribute('aria-label')==='Also delete memories associated with this chat').disabled);};
 await reset();await open();const checkbox=page.getByRole('checkbox',{name:'Also delete memories associated with this chat',exact:true});assert.equal(await checkbox.isChecked(),false);
 await page.getByText('1 memory saved only by this chat can be deleted. 2 shared or independently saved memories are kept.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.__exominaPreviewCalls.filter(c=>c.method==='conversations.delete').length),0);
 report.checks.push('Deletion starts unchecked, reports actual note counts, and cancelling deletes nothing.');
 await open();await page.getByRole('button',{name:'Delete conversation',exact:true}).click();
 await page.waitForFunction(async()=>(await window.studio.invoke('bootstrap')).conversations.every(chat=>chat.id!=='c1'));
 assert.equal(await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).memories.length),5);
 assert.equal(await page.evaluate(()=>window.__exominaPreviewCalls.find(c=>c.method==='conversations.delete').payload.deleteMemories),false);
 report.checks.push('The default deletion removes only the chat and retains all shared notes.');
 await reset();await open();assert.equal(await checkbox.isChecked(),false);await checkbox.check();await page.screenshot({path:path.join(output,'delete-linked-memories.png')});
 await page.getByRole('button',{name:'Delete conversation',exact:true}).click();await page.waitForFunction(async()=>(await window.studio.invoke('bootstrap')).memories.length===4);
 const remaining=await page.evaluate(async()=>(await window.studio.invoke('bootstrap')).memories);
 assert.deepEqual(remaining.map(note=>note.id).sort(),['legacy','manual','shared','unrelated']);assert.deepEqual(remaining.find(note=>note.id==='shared').sourceChatIds,['c2']);
 assert.equal(await page.evaluate(()=>window.__exominaPreviewCalls.filter(c=>c.method==='conversations.delete').at(-1).payload.deleteMemories),true);
 await page.getByRole('button',{name:'Memory',exact:true}).click();await page.getByText('Shared between A and B',{exact:true}).waitFor();assert.equal(await page.getByText('Only chat A',{exact:true}).count(),0);
 report.checks.push('Checked deletion sends explicit consent, removes exclusive notes, preserves shared/manual/unlinked notes, and refreshes the Memory view.');
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(err){report.failure=err.stack;await(await app.firstWindow()).screenshot({path:path.join(output,'ui-failure.png')}).catch(()=>{});throw err;}finally{await writeFile(path.join(output,'ui-result.json'),JSON.stringify(report,null,2));await app.close();await server.close();}
console.log(JSON.stringify(report,null,2));
