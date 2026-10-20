import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataExport,writeDataExportFile,dataExportInfo } from '../desktop/data-export.mjs';
import {constants as bufferConstants} from 'node:buffer';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';
import { clipToolHistory } from '../desktop/chat-memory-records.mjs';
import {mkdir,mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';

function fixture() {
  const chats = [
    { id: 'chat-a', title: 'Überblick 🌍', provider: 'claude', updatedAt: '2026-10-05T12:00:00Z', sessions: { claude: 'PRIVATE_SESSION_MARKER' }, codexToolFingerprint: 'PRIVATE_FINGERPRINT', workspace: 'PRIVATE_WORKSPACE', messages: [
      { id: 'message-a', role: 'user', content: 'Grüße — 中文 — مرحباً 🌿\nSecond line.', provider: 'claude', createdAt: '2026-10-05T12:00:00Z', apiKey: 'PRIVATE_MESSAGE_KEY', runtime: 'PRIVATE_RUNTIME' },
      { id: 'message-b', role: 'assistant', content: 'Exact answer\n```js\nconst café = "茶";\n```', provider: 'claude', error: 'Synthetic stopped run' },
    ] },
    { id: 'chat-b', title: 'Another conversation', provider: 'codex', messages: [{ role: 'user', content: 'Other conversation content.' }] },
  ];
  const notes = Array.from({ length: 503 }, (_, index) => ({ id: `note-${index}`, date: '2026-10-05T12:00:00Z', text: index ? `Synthetic note ${index}` : 'Préférence 中文 🌙' }));
  const documents = ['memory', 'instructions', 'conversation', 'project', 'artifact'].map(kind => ({ id: `doc-${kind}`, kind, title: `Synthetic ${kind}`, provider: 'claude', text: `Exact ${kind} text ✓`, sourceUrl: 'https://example.com/source' }));
  const calls = { list: [], documentKinds: [] };
  const store = { state: { settings: { apiKey: 'PRIVATE_SETTINGS_KEY', cloudToken: 'PRIVATE_CLOUD_TOKEN', externalMcpServers: [{ env: { SECRET: 'PRIVATE_MCP_SECRET' } }] }, auth: 'PRIVATE_AUTH', conversations: chats }, conversation: id => { const chat = chats.find(item => item.id === id); if (!chat) throw Error('Chat not found'); return chat; } };
  const memory = { list: async (query, limit) => { calls.list.push([query, limit]); return notes.slice(0, limit); } };
  const archive = { exportDocuments: kinds => { calls.documentKinds.push(kinds); return documents.filter(item => !kinds || kinds.includes(item.kind)); } };
  return { store, memory, archive, calls, chats, notes, documents };
}

test('all JSON export retains Unicode, complete note history, messages, and source context', async () => {
  const data = fixture(); const before = JSON.stringify(data.store.state);
  const result = await createDataExport(data, { scope: 'all', format: 'json' });
  const parsed = JSON.parse(result.content);
  assert.equal(result.mimeType, 'application/json'); assert.match(result.filename, /^Exomina-all-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(parsed.format, 'exomina-export'); assert.equal(parsed.version, 1);
  assert.equal(parsed.chats.length, 2); assert.equal(parsed.notes.length, 503); assert.equal(parsed.documents.length, 5);
  assert.equal(parsed.chats[0].messages[0].content, data.chats[0].messages[0].content);
  assert.equal(parsed.notes[0].text, 'Préférence 中文 🌙');
  assert.equal(parsed.documents[0].sourceUrl, 'https://example.com/source');
  assert.deepEqual(data.calls.list, [['', 10000000]]); assert.deepEqual(data.calls.documentKinds, [undefined]);
  assert.equal(JSON.stringify(data.store.state), before, 'Export must not alter stored data');
});

test('chat export contains only the selected conversation and no memory/archive reads', async () => {
  const data = fixture(); const parsed = JSON.parse((await createDataExport(data, { scope: 'chat', format: 'json', conversationId: 'chat-a' })).content);
  assert.equal(parsed.chats.length, 1); assert.equal(parsed.chats[0].id, 'chat-a');
  assert.equal(parsed.notes, undefined); assert.equal(parsed.documents, undefined);
  assert.deepEqual(data.calls.list, []); assert.deepEqual(data.calls.documentKinds, []);
});

test('chats and memory scopes separate transcripts from saved instructions', async () => {
  const first = fixture(); const chats = JSON.parse((await createDataExport(first, { scope: 'chats' })).content);
  assert.equal(chats.chats.length, 2); assert.equal(chats.notes, undefined); assert.equal(chats.documents, undefined);
  const second = fixture(); const memory = JSON.parse((await createDataExport(second, { scope: 'memory' })).content);
  assert.equal(memory.chats, undefined); assert.equal(memory.notes.length, 503);
  assert.deepEqual(memory.documents.map(item => item.kind), ['memory', 'instructions']);
  assert.deepEqual(second.calls.documentKinds, [['memory', 'instructions']]);
});

test('JSON and Markdown exclude application credentials, runtime sessions, and configuration', async () => {
  for (const format of ['json', 'markdown']) {
    const result = await createDataExport(fixture(), { scope: 'all', format });
    for (const marker of ['PRIVATE_SESSION_MARKER', 'PRIVATE_FINGERPRINT', 'PRIVATE_WORKSPACE', 'PRIVATE_MESSAGE_KEY', 'PRIVATE_RUNTIME', 'PRIVATE_SETTINGS_KEY', 'PRIVATE_CLOUD_TOKEN', 'PRIVATE_MCP_SECRET', 'PRIVATE_AUTH']) assert.ok(!result.content.includes(marker), `${format} exposed ${marker}`);
  }
});

test('Markdown retains verbatim Unicode, line breaks, code fences, source URLs, and run status', async () => {
  const data = fixture(); const result = await createDataExport(data, { scope: 'all', format: 'markdown' });
  assert.equal(result.mimeType, 'text/markdown'); assert.match(result.filename, /\.md$/);
  assert.ok(result.content.includes(data.chats[0].messages[0].content)); assert.ok(result.content.includes(data.chats[0].messages[1].content));
  assert.ok(result.content.includes('Préférence 中文 🌙')); assert.ok(result.content.includes('https://example.com/source'));
  assert.ok(result.content.includes('Run status: Synthetic stopped run')); assert.ok(result.content.endsWith('\n'));
});

test('invalid scopes, formats, and unknown conversation IDs reject before export', async () => {
  await assert.rejects(createDataExport(fixture(), { scope: 'credentials' }), /valid export/);
  await assert.rejects(createDataExport(fixture(), { format: 'html' }), /valid export/);
  await assert.rejects(createDataExport(fixture(), { scope: 'chat', conversationId: 'missing' }), /Chat not found/);
});

async function journalFixture(t){
  const root=path.resolve(import.meta.dirname,'..','.verification','data-export');
  await mkdir(root,{recursive:true,mode:0o700});
  const directory=await mkdtemp(path.join(root,'synthetic-'));
  const tree=new ChatMemoryTree(directory);await tree.init();
  t.after(async()=>{await tree.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(root+path.sep)&&path.basename(resolved).startsWith('synthetic-'));await rm(resolved,{recursive:true,force:true});});
  return tree;
}

test('streamed all-data export exceeds the JavaScript string limit with bounded writes',async()=>{
  const data=fixture(),text='x'.repeat(1024*1024);
  const document={id:'large-doc',kind:'conversation',title:'Repeated synthetic context',provider:'claude',text};
  data.archive.exportDocuments=()=>Array.from({length:Math.ceil(bufferConstants.MAX_STRING_LENGTH/text.length)+2},()=>document);
  let bytes=0,largest=0,writes=0;
  const result=await createDataExport(data,{scope:'all',format:'json'},{write:async chunk=>{bytes+=Buffer.byteLength(chunk);largest=Math.max(largest,chunk.length);writes++;}});
  assert.ok(bytes>bufferConstants.MAX_STRING_LENGTH);assert.ok(largest<2*1024*1024);assert.ok(writes>500);
  assert.equal(result.content,undefined,'The file path must never build one combined output string');
});

test('streamed JSON and Markdown save complete Unicode data through an atomic file',async t=>{
  const tree=await journalFixture(t),dir=tree.dir;
  await tree.append('chat-a',{key:'streamed-source',role:'tool',kind:'echo',text:'Complete original 😀\n'+'z'.repeat(9000)});
  for(const format of ['json','markdown']){
    const data={...fixture(),chatMemoryTree:tree},file=path.join(dir,'export.'+(format==='json'?'json':'md'));
    await writeFile(file,'OLD EXPORT','utf8');
    const saved=await writeDataExportFile(data,{scope:'all',format},file),text=await readFile(file,'utf8');
    assert.equal(saved.path,file);assert.ok(text.includes('Complete original 😀'));
    for(const marker of ['PRIVATE_SESSION_MARKER','PRIVATE_MESSAGE_KEY','PRIVATE_SETTINGS_KEY'])assert.ok(!text.includes(marker));
    if(format==='json'){const value=JSON.parse(text);assert.equal(value.chats.length,2);assert.equal(value.notes.length,503);assert.equal(value.chats[0].chatMemory.originals[0].text,'Complete original 😀\n'+'z'.repeat(9000));}
    else assert.ok(text.includes('## Shared memories'));
    assert.ok(!(await readdir(dir)).some(name=>name.startsWith('.exomina-export-')));
  }
});

test('failed streamed export retains the destination and removes its partial file',async t=>{
  const tree=await journalFixture(t),dir=tree.dir,file=path.join(dir,'existing.json');
  await writeFile(file,'KEEP THIS EXPORT','utf8');
  const data={...fixture(),chatMemoryTree:{stats:async()=>{throw Error('Synthetic source read failed');}}};
  await assert.rejects(writeDataExportFile(data,{scope:'all'},file),/Synthetic source read failed/);
  assert.equal(await readFile(file,'utf8'),'KEEP THIS EXPORT');
  assert.ok(!(await readdir(dir)).some(name=>name.startsWith('.exomina-export-')));
  assert.throws(()=>dataExportInfo({scope:'accounts'}),/valid export/);
});

test('chat JSON exports sanitized original sources and provenance without summary caches',async t=>{
  const data=fixture(),tree=await journalFixture(t);
  const echo=clipToolHistory('Tool start\n'+'a'.repeat(90000)+'\nTool tail');
  await tree.append('chat-a',{key:'host:call-1:input',role:'tool',kind:'tool',createdAt:null,text:'workspace_shell\n{"command":"echo synthetic"}',metadata:{sourceMessageId:'message-b'}});
  await tree.append('chat-a',{key:'host:call-1:output',role:'tool',kind:'echo',createdAt:'2026-10-05T12:01:00Z',text:echo,metadata:{tool:'workspace_shell'}});
  await tree.append('chat-a',{key:'source-private-fields',role:'assistant',kind:'assistant',text:'api_key=sk-syntheticcredential123 password=synthetic-password data:image/png;base64,YWJjZA==',metadata:{apiKey:'PRIVATE_JOURNAL_KEY',thinking:'PRIVATE_HIDDEN_REASONING',dataBase64:'PRIVATE_BINARY_DATA',provider:'codex'}});
  await tree.append('chat-a',{key:'never-export-thinking',role:'assistant',kind:'thinking',text:'PRIVATE_THINKING_RECORD'});
  await tree.append('chat-b',{key:'other-chat-original',role:'user',kind:'user',text:'OTHER_CHAT_JOURNAL'});
  const result=await createDataExport({...data,chatMemoryTree:tree},{scope:'chat',conversationId:'chat-a'});
  const parsed=JSON.parse(result.content),journal=parsed.chats[0].chatMemory;
  assert.equal(journal.format,'exomina-chat-memory-originals');assert.equal(journal.version,1);
  assert.equal(journal.originalCount,4);assert.equal(journal.exportedCount,3);
  assert.equal(journal.provenance.conversationId,'chat-a');assert.equal(journal.provenance.summaryCachesIncluded,false);
  assert.deepEqual(journal.originals.map(entry=>entry.id),[0,1,2]);
  assert.equal(journal.originals[0].date,null);assert.equal(journal.originals[1].date,'2026-10-05T12:01:00.000Z');
  assert.equal(journal.originals[1].text,echo);assert.ok(echo.length>4000);
  assert.match(journal.originals[1].text,/tool output clipped: middle omitted/);assert.ok(journal.originals[1].text.endsWith('Tool tail'));
  assert.match(journal.originals[1].sourceHash,/^[a-f0-9]{64}$/);
  for(const marker of ['PRIVATE_JOURNAL_KEY','PRIVATE_HIDDEN_REASONING','PRIVATE_BINARY_DATA','PRIVATE_THINKING_RECORD','OTHER_CHAT_JOURNAL','sk-syntheticcredential123','synthetic-password','YWJjZA=='])assert.ok(!result.content.includes(marker),`Export exposed ${marker}`);
  assert.ok(!Object.hasOwn(journal,'views'));assert.ok(!Object.hasOwn(journal,'nodes'));assert.ok(!Object.hasOwn(journal,'jobs'));
});

test('original source export uses indexed row batches and a fixed append boundary',async t=>{
  const data=fixture(),tree=await journalFixture(t),long='Unicode 😀 original\n'+'x'.repeat(100000);
  await tree.append('chat-a',{key:'long-original',role:'assistant',kind:'assistant',text:long});
  for(let index=1;index<259;index++)await tree.append('chat-a',{key:`original-${index}`,role:'user',kind:'user',text:`Original ${index}`});
  let statsCalls=0,batchCalls=0;
  const source={stats:async id=>{statsCalls++;const snapshot=await tree.stats(id);await tree.append(id,{key:'after-boundary',role:'user',kind:'user',text:'LATER_APPEND'});return snapshot;},originals:(...args)=>{batchCalls++;return tree.originals(...args);},zoom:()=>{throw Error('Export must read indexed rows rather than reread full long originals per text page');}};
  const journal=JSON.parse((await createDataExport({...data,chatMemoryTree:source},{scope:'chat',conversationId:'chat-a'})).content).chats[0].chatMemory;
  assert.equal(statsCalls,1);assert.equal(batchCalls,3,'Each original row is read once in batches of at most 128');
  assert.equal(journal.originalCount,259);assert.equal(journal.originals.length,259);assert.equal(journal.originals[0].text,long);
  assert.ok(!journal.originals.some(entry=>entry.text==='LATER_APPEND'));
});

test('Markdown exports complete visible journal work, dates and metadata',async t=>{
  const data=fixture(),tree=await journalFixture(t),text='Exact visible tool echo\n'+'z'.repeat(9000)+'\nLast echo line 😀';
  await tree.append('chat-a',{key:'native:tool-1:output',role:'tool',kind:'echo',text,metadata:{tool:'commandExecution',sourceMessageId:'message-b'}});
  const result=await createDataExport({...data,chatMemoryTree:tree},{scope:'chat',format:'markdown',conversationId:'chat-a'});
  assert.ok(result.content.includes(text));assert.ok(result.content.includes('Schema: exomina-chat-memory-originals version 1.'));
  assert.ok(result.content.includes('Source event: native:tool-1:output'));assert.ok(result.content.includes('Date: Unknown'));
  assert.ok(result.content.includes('"sourceMessageId":"message-b"'));
});

test('memory-only scope does not read chat journals and invalid source pagination fails',async()=>{
  const data=fixture(),source={stats:async()=>{throw Error('Must not read sources');},zoom:async()=>{throw Error('Must not read sources');}};
  const result=JSON.parse((await createDataExport({...data,chatMemoryTree:source},{scope:'memory'})).content);
  assert.equal(result.chats,undefined);
  const broken={stats:async()=>({total:1}),zoom:async()=>({id:0,count:1,text:'partial',offset:0,nextOffset:0})};
  await assert.rejects(createDataExport({...data,chatMemoryTree:broken},{scope:'chat',conversationId:'chat-a'}),/pagination did not advance/);
});

test('all and chats scopes export each selected journal without reading unrelated state',async t=>{
  for(const scope of ['all','chats']){
    const data=fixture(),tree=await journalFixture(t);
    await tree.append('chat-a',{key:'original-a',role:'user',kind:'user',text:'First journal'});
    await tree.append('chat-b',{key:'original-b',role:'user',kind:'user',text:'Second journal'});
    const result=JSON.parse((await createDataExport({...data,chatMemoryTree:tree},{scope})).content);
    assert.deepEqual(result.chats.map(chat=>chat.chatMemory.originals[0].text),['First journal','Second journal']);
  }
});
