import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {CloudService,serverEncryption} from '../cloud/service.mjs';
function provider(options){return {status:async()=>[{id:'codex',connected:true,installed:true}],subscriptionModels:async()=>({codex:[]}),cancel(){},close(){},async run(input){options.emit({type:'chat.delta',conversationId:input.conversationId,text:'Synthetic café reply'});return {text:'Synthetic café reply',sessionId:'secret-native-session'};}};}
async function fixture(t,providerFactory=provider){const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-cloud-service-'));const service=new CloudService({dataDir,vaultKey:randomBytes(32).toString('base64'),providerFactory});await service.init();t.after(async()=>{await service.close();await rm(dataDir,{recursive:true,force:true})});return service;}
test('vault credential encryption authenticates content and rejects a wrong key',()=>{const enc=serverEncryption(randomBytes(32).toString('base64')),value=enc.encryptString('synthetic-key');assert.equal(enc.decryptString(value),'synthetic-key');assert.ok(!value.includes(Buffer.from('synthetic-key')));const tampered=Buffer.from(value);tampered[14]^=1;assert.throws(()=>enc.decryptString(tampered));assert.throws(()=>serverEncryption('invalid'));});

test('memory context IPC follows bounded pages from the same snapshot',async t=>{
 const service=await fixture(t),ids=[];
 for(let n=1;n<=83;n++)ids.push((await service.memory.note(`Saved original ${n}: café 🌙.`)).id);
 const first=JSON.parse((await service.invoke('memory.wake')).text),pages=[first];
 assert.equal(first.total,83);assert.ok(first.nextPart);
 await service.memory.note('Arrived after the preview opened.');
 while(pages.at(-1).nextPart){const last=pages.at(-1);pages.push(JSON.parse((await service.invoke('memory.wake',{part:last.nextPart,snapshot:first.snapshot,cursor:last.nextCursor})).text));}
 assert.deepEqual(pages.flatMap(page=>page.notes.map(note=>note.id)),ids.toReversed());
 assert.ok(pages.every(page=>page.snapshot===83&&page.total===83));
 assert.equal((await service.invoke('memory.wake',{part:2,snapshot:first.snapshot,cursor:0})).error,true);
});

test('private-server API configuration, guarded replies and disconnect use encrypted credentials with no native fallback',async t=>{
  let nativeRuns=0,fetches=0;
  const s=await fixture(t,options=>({...provider(options),run:async()=>{nativeRuns++;throw Error('Unexpected subscription fallback');}}));
  await s.invoke('provider.configure',{provider:'openai-api',model:'synthetic-model',apiKey:'sk-synthetic-server-key',allowPaidApi:true});
  const boot=await s.invoke('bootstrap');assert.equal(boot.connections.find(item=>item.id==='openai-api').connected,true);assert.equal(JSON.stringify(boot).includes('sk-synthetic-server-key'),false);
  s.apiAgent.fetchImpl=async()=>{fetches++;return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Synthetic API reply'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});};
  const sent=await s.invoke('chat.send',{provider:'openai-api',text:'Synthetic request'},{requestId:randomUUID()});await Promise.all([...s.active.values()].map(run=>run.promise));
  assert.equal((await s.invoke('conversations.get',{id:sent.conversationId})).messages.at(-1).content,'Synthetic API reply');
  assert.equal(nativeRuns,0);assert.equal(fetches,1);assert.ok((await s.invoke('guard.view')).tokens['openai-api'].hour>=8192);
  await s.invoke('settings.save',{requestLimits:{tokens:{hour:1,day:1}}});
  await s.invoke('chat.send',{provider:'openai-api',text:'Must be refused'},{requestId:randomUUID()});await Promise.all([...s.active.values()].map(run=>run.promise));
  assert.equal(fetches,1);await s.invoke('provider.disconnect',{provider:'openai-api'});assert.equal(s.connections.find(item=>item.id==='openai-api').connected,false);
});

test('a normal provider reply can name the current chat with no extra inference call; manual names persist',async t=>{
 let runs=0;
 const s=await fixture(t,options=>({...provider(options),async run(input){runs++;assert.match(input.prompt,/conversation_set_title once/);const result=await options.callTool('conversation_set_title',{title:'A fitting synthetic title'},input.conversationId);assert.equal(JSON.parse(result.content[0].text).updated,true);return {text:'Synthetic answer'};}}));
 const sent=await s.invoke('chat.send',{provider:'codex',text:'This whole long prompt must not become the title'},{requestId:randomUUID()});
 await Promise.all([...s.active.values()].map(r=>r.promise));let chat=await s.invoke('conversations.get',{id:sent.conversationId});
 assert.equal(runs,1);assert.equal(chat.title,'A fitting synthetic title');assert.equal(chat.titleSource,'model');
 chat=await s.invoke('conversations.rename',{id:chat.id,title:'My manual title'});assert.equal(chat.titleSource,'manual');
 assert.equal(s.syncStore.get('chat',chat.id).payload.titleSource,'manual');assert.equal(s.syncStore.get('chat',chat.id).payload.title,'My manual title');
});

test('chat organization survives sync/export, archive blocks active runs and restores intact history',async t=>{
 const s=await fixture(t),sent=await s.invoke('chat.send',{provider:'codex',text:'A synthetic request that remains private in the chat'},{requestId:randomUUID()});
 await Promise.all([...s.active.values()].map(r=>r.promise));const chat=s.store.conversation(sent.conversationId);
 assert.equal(chat.title,'New chat','No title tool means a neutral fallback, not the prompt');
 s.active.set(chat.id,{chat,message:chat.messages.at(-1)});
 await s.invoke('conversations.rename',{id:chat.id,title:'Manual during reply'});await s.invoke('conversations.pin',{id:chat.id,pinned:true});
 await assert.rejects(s.invoke('conversations.archive',{id:chat.id,archived:true}),/Stop this chat/);await assert.rejects(s.invoke('conversations.delete',{id:chat.id}),/running/);
 s.active.delete(chat.id);await s.invoke('conversations.archive',{id:chat.id,archived:true});
 assert.equal((await s.invoke('bootstrap')).conversations.find(c=>c.id===chat.id).archived,true);
 await assert.rejects(s.invoke('chat.send',{conversationId:chat.id,provider:'codex',text:'Blocked until restored'},{requestId:randomUUID()}),/Restore this chat/);
 const exported=JSON.parse((await s.invoke('data.export',{scope:'chat',conversationId:chat.id})).content).chats[0];
 assert.equal(exported.archived,true);assert.equal(exported.pinned,true);assert.equal(exported.titleSource,'manual');assert.equal(exported.messages.length,2);
 const payload=s.syncStore.get('chat',chat.id).payload;assert.equal(payload.archived,true);assert.equal(payload.pinned,true);assert.equal(payload.titleSource,'manual');
 await s.invoke('conversations.archive',{id:chat.id,archived:false});assert.equal(chat.archived,false);assert.equal(chat.messages.length,2);
});

test('memory review IPC returns unread counts and validates the new-only filter',async t=>{
 const s=await fixture(t);await s.invoke('memory.add',{text:'Synthetic reviewable note'});
 const boot=await s.invoke('bootstrap');assert.equal(boot.memoryReview.unreviewedCount,1);
 const notes=await s.invoke('memory.search',{newOnly:true});assert.equal(notes.length,1);
 const reviewed=await s.invoke('memory.review',{ids:[notes[0].id]});assert.equal(reviewed.unreviewedCount,0);
 assert.equal((await s.invoke('memory.search',{newOnly:true})).length,0);
 await assert.rejects(s.invoke('memory.search',{newOnly:'yes'}),/Invalid memory filter/);
});
test('server chat persists independently of subscribers and duplicate request IDs never run twice',async t=>{const s=await fixture(t),requestId=randomUUID(),input={provider:'codex',text:'Synthetic only'};const one=await s.invoke('chat.send',input,{requestId});const twice=await s.invoke('chat.send',input,{requestId});assert.equal(one.conversationId,twice.conversationId);await Promise.all([...s.active.values()].map(r=>r.promise));const chat=await s.invoke('conversations.get',{id:one.conversationId});assert.equal(chat.messages.length,2);assert.equal(chat.messages[1].content,'Synthetic café reply');assert.ok(!JSON.stringify(chat).includes('secret-native-session'));const entity=s.syncStore.get('chat',chat.id);assert.equal(entity.payload.messages[1].content,'Synthetic café reply');assert.ok(!JSON.stringify(entity).includes('secret-native-session'));await assert.rejects(()=>s.invoke('chat.send',{...input,text:'changed'},{requestId}),/reused/);});
test('synced notes and archived memories are available to phone context; deletion removes copies',async t=>{const s=await fixture(t),id=randomUUID();const apply=(kind,id,payload,type='put')=>s.syncStore.apply({deviceId:'test',operationId:randomUUID(),expectedRevision:s.syncStore.get(kind,id)?.revision||0,type,entity:{kind,id,...(type==='put'?{payload}:{})}});let ack=apply('note',id,{text:'Synthetic shared memory',createdAt:'2026-10-05T00:00:00Z'});await s.syncChanged(ack.entity);assert.equal((await s.invoke('memory.search'))[0].id,id);ack=apply('note',id,{text:'Revised memory',createdAt:'2026-10-05T00:00:00Z'});await s.syncChanged(ack.entity);assert.equal((await s.invoke('memory.search'))[0].text,'Revised memory');ack=apply('note',id,null,'delete');await s.syncChanged(ack.entity);assert.deepEqual(await s.invoke('memory.search'),[]);
 const archiveId=randomUUID();ack=apply('archive',archiveId,{provider:'claude',kind:'memory',title:'Synthetic context',text:'A teal bicycle',sourceId:'source-1'});await s.syncChanged(ack.entity);assert.match(s.archive.wakeContext(),/teal bicycle/);ack=apply('archive',archiveId,null,'delete');await s.syncChanged(ack.entity);assert.equal(s.archive.summary().documents,0);
 const boot=await s.invoke('bootstrap');assert.equal(boot.runtime.capabilities.desktopControl,false);assert.ok(!('workspace'in boot.settings));await assert.rejects(()=>s.invoke('app.openData'),/unavailable/);
});

test('automatic notes reach sync without approval; ask-first and current-chat retrieval stay enforced',async t=>{
 const s=await fixture(t),chat=s.store.create('codex');
 chat.messages=Array.from({length:60},(_,n)=>({id:`message-${n}`,role:n%2?'assistant':'user',content:n===0?'Earliest synthetic decision':'Later context',provider:n%2?'claude':'codex'}));
 await s.store.save();s.active.set(chat.id,{chat,message:chat.messages.at(-1)});
 assert.equal((await s.invoke('bootstrap')).settings.memoryCapture,'automatic');
 const saved=await s.callTool('memory_note',{text:'Synthetic automatic decision'},chat.id);
 assert.ok(!saved.isError);assert.equal(s.approvals.size,0);
 const note=(await s.memory.list())[0];assert.equal(s.syncStore.get('note',note.id).payload.text,note.text);
 await s.invoke('settings.save',{memoryCapture:'ask'});
 const pending=s.callTool('memory_note',{text:'Declined synthetic note'},chat.id);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(s.approvals.size,1);
 await s.invoke('approval.respond',{id:[...s.approvals.keys()][0],approved:false});
 assert.equal((await pending).isError,true);assert.equal((await s.memory.list()).length,1);
 await s.invoke('settings.save',{memoryEnabled:false});
 const retrieved=await s.callTool('conversation_read',{messageId:'message-0'},chat.id);
 assert.match(retrieved.content[0].text,/Earliest synthetic decision/);
 assert.equal((await s.callTool('memory_note',{text:'Blocked'},chat.id)).isError,true);
 s.active.delete(chat.id);await s.invoke('memory.delete',{id:note.id});
 assert.equal((await s.memory.list()).length,0);assert.equal(s.syncStore.get('note',note.id).deleted,true);
});

test('native image events persist before chat completion and expose metadata-only bootstrap plus authenticated download data',async t=>{
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
 const s=await fixture(t,options=>({...provider(options),async run(input){options.emit({type:'chat.image.generated',conversationId:input.conversationId,dataBase64:png,mimeType:'image/png'});return {text:'Created the synthetic image'};}}));
 const response=await s.invoke('chat.send',{provider:'codex',text:'Create synthetic image'},{requestId:randomUUID()});await Promise.all([...s.active.values()].map(r=>r.promise));
 const boot=await s.invoke('bootstrap'),chat=boot.conversations.find(c=>c.id===response.conversationId),attachment=chat.messages.at(-1).attachments[0];
 assert.equal(attachment.kind,'image');assert.ok(!JSON.stringify(boot).includes(png));assert.equal(s.syncStore.get('asset',attachment.id).payload.dataBase64,png);
 const saved=await s.invoke('asset.save',{id:attachment.id});assert.equal(saved.dataBase64,png);assert.equal(saved.filename,'Exomina-image.png');
 s.active.set(chat.id,{chat,message:chat.messages.at(-1)});await s.invoke('settings.save',{memoryEnabled:false});
 const viewed=await s.callTool('image_read',{id:attachment.id},chat.id);assert.equal(viewed.content[0].data,png);s.active.delete(chat.id);
});

test('native video events survive chat publication, sync, export and authenticated downloads', async t => {
  const box = (name, data = Buffer.alloc(0)) => { const value = Buffer.alloc(data.length + 8); value.writeUInt32BE(value.length); value.write(name, 4); data.copy(value, 8); return value; };
  const video = Buffer.concat([box('ftyp', Buffer.from('isom0000isom')), box('moov'), box('mdat', Buffer.from('synthetic video container'))]).toString('base64');
  const s = await fixture(t, options => ({ ...provider(options), status: async () => [{ id: 'grok', connected: true, installed: true }], async run(input) {
    options.emit({ type: 'chat.media.generated', conversationId: input.conversationId, dataBase64: video, mimeType: 'video/mp4' });
    return { text: 'Synthetic video ready' };
  } }));
  const sent = await s.invoke('chat.send', { provider: 'grok', text: 'Synthetic video request' }, { requestId: randomUUID() });
  await Promise.all([...s.active.values()].map(run => run.promise));
  const chat = await s.invoke('conversations.get', { id: sent.conversationId }), attachment = chat.messages.at(-1).attachments[0];
  assert.equal(attachment.kind, 'video');
  assert.equal(s.syncStore.get('chat', chat.id).payload.messages.at(-1).attachments[0].kind, 'video');
  assert.equal(s.syncStore.get('asset', attachment.id).payload.mimeType, 'video/mp4');
  const saved = await s.invoke('asset.save', { id: attachment.id });
  assert.equal(saved.filename, 'Exomina-video.mp4');
  assert.equal(saved.dataBase64, video);
  const exported = await s.invoke('data.export', { scope: 'chat', conversationId: chat.id, format: 'json' });
  assert.equal(JSON.parse(exported.content).chats[0].messages.at(-1).attachments[0].kind, 'video');
});
