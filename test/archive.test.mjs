import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArchiveStore } from '../desktop/archive.mjs';
import { createDataExport } from '../desktop/data-export.mjs';
import { ChatMemoryTree } from '../desktop/chat-memory-tree.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-archive-test-'));
  const archive = new ArchiveStore(dir);
  await archive.init();
  t.after(async () => { archive.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true }); });
  return { dir, archive, save: async (name, value) => { const file = path.join(dir, name); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); return file; } };
}

test('archive sync revisions detect primary metadata, provenance, imports and deletions without exporting text', async t => {
  const { archive } = await setup(t);
  const doc = { provider: 'claude', kind: 'conversation', sourceId: 'sync-source', title: 'Synthetic', text: 'Synthetic archive body.', sourceFile: 'first.json' };
  await archive.importDocuments([doc]); const first = archive.syncIndex()[0];
  assert.equal(archive.findDocumentForSync(doc), first.id);
  assert.deepEqual(archive.exportDocument(first.id), archive.exportDocuments()[0]);
  await archive.importDocuments([doc]); assert.deepEqual(archive.syncIndex()[0], first, 'duplicate imports leave revision stable');
  await archive.importDocuments([{ ...doc, sourceFile: 'second.json' }]);
  const second = archive.syncIndex()[0]; assert.ok(Number(second.version) > Number(first.version));
  archive.db.prepare('UPDATE documents SET title=? WHERE id=?').run('Updated metadata', first.id);
  assert.ok(Number(archive.syncIndex()[0].version) > Number(second.version));
  archive.removeDocument(first.id); assert.deepEqual(archive.syncIndex(), []);
  assert.equal(archive.findDocumentForSync(doc), null);
});

test('ChatGPT imports all message branches without exposing text in preview, and retains provenance', async t => {
  const { archive, save } = await setup(t);
  const file = await save('conversations.json', [{ id: 'synthetic-chat', title: 'A synthetic project', create_time: 1700000000, mapping: {
    root: { message: null },
    first: { message: { id: 'first', author: { role: 'user' }, create_time: 1700000001, content: { parts: ['SYNTHETIC_QUESTION'] } } },
    answer: { message: { id: 'answer', author: { role: 'assistant' }, create_time: 1700000002, content: { parts: ['SYNTHETIC_ANSWER'] } } },
    alternate: { message: { id: 'alternate', author: { role: 'assistant' }, create_time: 1700000003, content: { parts: ['SYNTHETIC_ALTERNATE', { text: 'Additional exported text' }] } } },
  } }]);
  const preview = await archive.previewFile(file);
  assert.equal(preview.documents, 1);
  assert.equal(preview.conversationCount, 1);
  assert.equal(preview.memoryCount, 0);
  assert.equal(preview.source, 'ChatGPT');
  assert.ok(preview.warnings.some(value => value.includes('branch')));
  assert.ok(!JSON.stringify(preview).includes('SYNTHETIC_QUESTION'));
  assert.equal(archive.summary().documents, 0);
  const result = await archive.commit(preview.token);
  assert.equal(result.added, 1);
  const found = archive.search('SYNTHETIC_ALTERNATE');
  assert.equal(found.total, 1);
  const record = archive.read(found.results[0].id);
  assert.match(record.text, /SYNTHETIC_QUESTION/);
  assert.match(record.text, /SYNTHETIC_ANSWER/);
  assert.match(record.text, /SYNTHETIC_ALTERNATE/);
  assert.match(record.text, /Additional exported text/);
  assert.equal(record.sourceFile, 'conversations.json');
  assert.equal(record.sourceId, 'synthetic-chat');
  assert.equal(record.sources.length, 1);
  assert.equal(archive.wakeContext(), '');
  await assert.rejects(archive.commit(preview.token), /preview expired/);
  assert.match(await readFile(file, 'utf8'), /SYNTHETIC_QUESTION/);
});

test('Claude text, content blocks, thinking, and attachment metadata are retained', async t => {
  const { archive, save } = await setup(t);
  const file = await save('claude.json', [{ uuid: 'synthetic-claude', name: 'Claude example', created_at: '2026-01-01T00:00:00Z', chat_messages: [
    { uuid: 'u1', sender: 'human', text: 'Unique question', content: [{ type: 'text', text: 'Block variant' }], attachments: [{ file_name: 'example.txt', extracted_content: 'Attachment text' }] },
    { uuid: 'a1', sender: 'assistant', text: '', content: [{ type: 'thinking', thinking: 'Exported reasoning' }, { type: 'text', text: 'Unique answer' }] },
  ] }]);
  const preview = await archive.previewFile(file);
  assert.equal(preview.source, 'Claude');
  await archive.commit(preview.token);
  const { results } = archive.search('Unique answer');
  const record = archive.read(results[0].id);
  for (const text of ['Unique question', 'Block variant', 'Attachment text', 'Exported reasoning', 'Unique answer']) assert.ok(record.text.includes(text));
  assert.equal(record.kind, 'conversation');
  assert.equal(record.provider, 'claude');
});

test('generic saved memory and instructions are exact, deduplicated, and eligible for bounded wake context', async t => {
  const { archive, save } = await setup(t);
  const original = '  Preserve whitespace\nAnd Unicode: Grüße 🐈\n';
  const documents = [
    { provider: 'chatgpt', kind: 'memory', title: 'Working preference', text: original, sourceUrl: 'https://chatgpt.com/#settings/Personalization' },
    { provider: 'claude', kind: 'instructions', title: 'A preference', text: 'Explain assumptions.' },
    { provider: 'claude', kind: 'conversation', title: 'Archive-only text', text: 'NEVER_AUTO_INJECT_THIS_HISTORY' },
  ];
  const first = await archive.previewFile(await save('context.json', { documents }));
  assert.deepEqual([first.memoryCount, first.instructionsCount, first.conversationCount], [1, 1, 1]);
  assert.equal((await archive.commit(first.token)).added, 3);
  const repeat = await archive.previewFile(await save('second-context.json', { documents }));
  const repeated = await archive.commit(repeat.token);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicates, 3);
  assert.equal(archive.summary().documents, 3);
  const memory = archive.search('Preserve whitespace').results[0];
  const read = archive.read(memory.id);
  assert.equal(read.text, original);
  assert.equal(read.sources.length, 2);
  const wake = archive.wakeContext();
  assert.ok(wake.includes(original));
  assert.ok(wake.includes('Explain assumptions.'));
  assert.ok(!wake.includes('NEVER_AUTO_INJECT_THIS_HISTORY'));
  assert.ok(archive.wakeContext(90).length <= 90);
  assert.equal(archive.wakeContext(0), '');
});

test('unknown JSON formats and records warn without guessing content', async t => {
  const { archive, save } = await setup(t);
  const unsupported = await archive.previewFile(await save('unknown.json', { secret: 'DO_NOT_LOG_THIS' }));
  assert.equal(unsupported.documents, 0);
  assert.ok(unsupported.warnings.some(warning => warning.includes('not supported')));
  assert.ok(unsupported.warnings.some(warning => warning.includes('unknown.json') && warning.includes('Other recognized files can still be imported')));
  assert.ok(!JSON.stringify(unsupported).includes('DO_NOT_LOG_THIS'));
  const mixed = await archive.previewFile(await save('mixed.json', { documents: [{ text: 'Valid', kind: 'memory' }, { text: 'Unrecognized', kind: 'magic' }, { mystery: 'No text' }] }));
  assert.equal(mixed.documents, 1);
  assert.ok(mixed.warnings.some(warning => warning.includes('2 unrecognized')));
  const result = await archive.commit(mixed.token);
  assert.equal(result.added, 1);
  assert.equal(archive.search('Unrecognized').total, 0);
});

test('Exomina export imports notes, documents, chats and sanitized original journals with provenance',async t=>{
  const {archive,save,dir}=await setup(t),tree=new ChatMemoryTree(path.join(dir,'synthetic-journal'));await tree.init();
  try{
  const echo='SYNTHETIC_FULL_WORK_ECHO\n'+'x'.repeat(12000)+'\nSYNTHETIC_ECHO_TAIL';
  await tree.append('export-chat',{key:'host:call-1:output',role:'tool',kind:'echo',text:echo,metadata:{sourceMessageId:'answer-1',tool:'workspace_shell'},createdAt:'2026-10-05T12:00:00Z'});
  const chats=[{id:'export-chat',title:'Exported synthetic chat',provider:'codex',updatedAt:'2026-10-05T12:01:00Z',sessions:{codex:'NEVER_RESTORE_SESSION'},messages:[{id:'question-1',role:'user',content:'SYNTHETIC_EXPORT_QUESTION',provider:'codex'},{id:'answer-1',role:'assistant',content:'SYNTHETIC_EXPORT_ANSWER',provider:'codex'}]}];
  const exported=await createDataExport({store:{state:{conversations:chats}},memory:{list:async()=>[{id:'note-1',date:'2026-10-05T12:00:00Z',text:'SYNTHETIC_EXPORTED_NOTE'}]},archive:{exportDocuments:()=>[{id:'document-1',provider:'claude',kind:'artifact',title:'Synthetic artifact',text:'SYNTHETIC_EXPORTED_DOCUMENT'}]},chatMemoryTree:tree});
  const file=await save('exomina-all.json',exported.content),preview=await archive.previewFile(file);
  assert.deepEqual([preview.documents,preview.memoryCount,preview.conversationCount,preview.artifactCount],[3,1,1,1]);
  assert.ok(preview.warnings.some(warning=>warning.includes('Active chats')&&warning.includes('not restored')));
  for(const marker of ['SYNTHETIC_FULL_WORK_ECHO','SYNTHETIC_EXPORT_QUESTION','SYNTHETIC_EXPORTED_NOTE'])assert.ok(!JSON.stringify(preview).includes(marker));
  assert.equal((await archive.commit(preview.token)).added,3);
  assert.equal(archive.search('SYNTHETIC_EXPORTED_NOTE').total,1);assert.equal(archive.search('SYNTHETIC_EXPORTED_DOCUMENT').total,1);
  const record=archive.read(archive.search('SYNTHETIC_ECHO_TAIL').results[0].id,0,32000);
  assert.ok(record.text.includes(echo));assert.ok(record.text.includes('SYNTHETIC_EXPORT_QUESTION'));assert.ok(record.text.includes('SYNTHETIC_EXPORT_ANSWER'));
  assert.equal(record.provider,'exomina');assert.equal(record.kind,'conversation');assert.equal(record.sourceId,'export-chat');assert.equal(record.sourceFile,'exomina-all.json');
  const document=archive.exportDocuments().find(document=>document.kind==='conversation'),raw=JSON.parse(document.rawJson);
  assert.equal(raw.provenance.activeChatRestored,false);assert.equal(raw.provenance.summaryCachesImported,false);
  assert.equal(raw.sourceChat.chatMemory.originals[0].text,echo);assert.match(raw.sourceChat.chatMemory.originals[0].sourceHash,/^[a-f0-9]{64}$/);
  assert.ok(!document.rawJson.includes('NEVER_RESTORE_SESSION'));
  const repeat=await archive.previewFile(file);assert.deepEqual([(await archive.commit(repeat.token)).added,archive.summary().documents],[0,3]);
  assert.ok(!archive.wakeContext().includes('SYNTHETIC_FULL_WORK_ECHO'));
  }finally{await tree.close();}
});

test('Exomina archive import excludes hidden journal reasoning, credentials, binary data and caches',async t=>{
  const {archive,save}=await setup(t);
  const input={format:'exomina-export',version:1,chats:[{id:'sanitized-chat',title:'Sanitized source',messages:[{id:'m-1',role:'user',content:'Visible message',attachments:[null,{name:'reference.png',dataBase64:'FORBIDDEN_ATTACHMENT_BINARY'}],thinking:'FORBIDDEN_MESSAGE_THINKING'}],sessions:{codex:'FORBIDDEN_NATIVE_SESSION'},chatMemory:{format:'exomina-chat-memory-originals',version:1,views:[{text:'FORBIDDEN_SUMMARY_CACHE'}],originals:[{id:0,eventKey:'source-0',role:'tool',kind:'echo',text:'Visible echo\npassword=FORBIDDEN_SECRET data:image/png;base64,Zm9yYmlkZGVu',metadata:{apiKey:'FORBIDDEN_KEY',thinking:'FORBIDDEN_METADATA_THINKING',blob:'FORBIDDEN_BINARY'}},{id:1,eventKey:'hidden-1',role:'assistant',kind:'thinking',text:'FORBIDDEN_REASONING_ORIGINAL'}]}}]};
  const preview=await archive.previewFile(await save('exomina-chat.json',input));assert.equal(preview.conversationCount,1);await archive.commit(preview.token);
  const record=archive.exportDocuments()[0],combined=record.text+record.rawJson;
  assert.ok(combined.includes('Visible message'));assert.ok(combined.includes('Visible echo'));
  for(const marker of ['FORBIDDEN_ATTACHMENT_BINARY','FORBIDDEN_MESSAGE_THINKING','FORBIDDEN_NATIVE_SESSION','FORBIDDEN_SUMMARY_CACHE','FORBIDDEN_SECRET','Zm9yYmlkZGVu','FORBIDDEN_KEY','FORBIDDEN_METADATA_THINKING','FORBIDDEN_BINARY','FORBIDDEN_REASONING_ORIGINAL'])assert.ok(!combined.includes(marker),`Archive exposed ${marker}`);
});

test('older Exomina chat-only and memory-only exports are recognized, and unsupported journal schemas warn',async t=>{
  const {archive,save}=await setup(t);
  const chatOnly=await archive.previewFile(await save('old-chat.json',{format:'exomina-export',version:1,chats:[{id:'old-chat',title:'Old chat',messages:[{role:'user',content:'OLD_EXOMINA_MESSAGE'}],chatMemory:{format:'unknown-journal',version:100,originals:[{text:'SKIPPED_UNKNOWN_JOURNAL'}]}}]}));
  assert.equal(chatOnly.conversationCount,1);assert.ok(chatOnly.warnings.some(warning=>warning.includes('unsupported schema')));await archive.commit(chatOnly.token);
  assert.equal(archive.search('OLD_EXOMINA_MESSAGE').total,1);assert.equal(archive.search('SKIPPED_UNKNOWN_JOURNAL').total,0);
  const memoryOnly=await archive.previewFile(await save('old-memory.json',{format:'exomina-export',version:1,notes:[{id:'old-note',text:'OLD_EXOMINA_NOTE'}],documents:[]}));
  assert.equal(memoryOnly.memoryCount,1);await archive.commit(memoryOnly.token);assert.equal(archive.search('OLD_EXOMINA_NOTE').total,1);
});

test('unsupported files in a ZIP do not obscure valid ChatGPT conversations or enter memory', async t => {
  const { archive, dir } = await setup(t);
  const python = process.platform === 'win32' ? fileURLToPath(new URL('../vendor/python/python.exe', import.meta.url)) : 'python3';
  const file = path.join(dir, 'mixed.zip');
  const entries = [
    { name: 'conversations-000.json', text: JSON.stringify([{ id: 'nested-one', title: 'Synthetic supported', mapping: { user: { message: { id: 'message-one', author: { role: 'user' }, content: { parts: ['VALID_SPLIT_EXPORT_MARKER'] } } } } }]) },
    { name: 'sites/projects/project-0001/project.json', text: JSON.stringify({ corpus: 'sites', metadata: { private: 'SKIPPED_SITES_METADATA' } }) },
    { name: 'memories.json', text: JSON.stringify({ unknown: 'SKIPPED_UNKNOWN_SCHEMA' }) },
  ];
  execFileSync(python, ['-I', '-c', 'import json,sys,zipfile\nv=json.load(sys.stdin)\nwith zipfile.ZipFile(v["path"],"w") as z:\n for item in v["entries"]: z.writestr(item["name"],item["text"])'], { input: JSON.stringify({ path: file, entries }), windowsHide: true });
  const preview = await archive.previewFile(file);
  assert.equal(preview.documents, 1);
  assert.equal(preview.conversationCount, 1);
  assert.equal(preview.memoryCount, 0);
  assert.equal(preview.warnings.filter(w => w.includes('not supported')).length, 1);
  assert.ok(preview.warnings.some(w => w.includes('Skipped memories.json:')));
  assert.ok(!JSON.stringify(preview).includes('SKIPPED_'));
  assert.equal((await archive.commit(preview.token)).added, 1);
  assert.equal(archive.search('VALID_SPLIT_EXPORT_MARKER').total, 1);
  assert.equal(archive.search('SKIPPED_').total, 0);
  assert.equal(archive.wakeContext(), '');
});

test('read pagination preserves Unicode pairs and search treats SQL/FTS syntax as data', async t => {
  const { archive } = await setup(t);
  const text = 'A🐈B\n' + 'a long example '.repeat(100);
  await archive.importDocuments([{ provider: 'unknown', kind: 'memory', title: 'Special text', text }]);
  const id = archive.search('').results[0].id;
  let combined = '';
  let offset = 0;
  do { const record = archive.read(id, offset, 2); combined += record.text; offset = record.nextOffset; } while (offset !== null);
  assert.equal(combined, text);
  assert.equal(archive.search("'; DROP TABLE documents; --").total, 0);
  assert.equal(archive.search('" OR *').total, 0);
  assert.equal(archive.summary().documents, 1);
  assert.throws(() => archive.read('missing-id'), /not found/);
  const tool = await archive.call('archive_search', { query: 'long example' });
  assert.equal(JSON.parse(tool.content[0].text).total, 1);
});

test('plain text remains exact and invalid JSON errors do not include private content', async t => {
  const { archive, save } = await setup(t);
  const original = '# User context\n\nA plain text note.\n';
  const preview = await archive.previewFile(await save('notes.md', original));
  assert.equal(preview.memoryCount, 1);
  await archive.commit(preview.token);
  assert.equal(archive.read(archive.search('').results[0].id).text, original);
  const file = await save('broken.json', '{"private":"DO_NOT_LOG_THIS", invalid}');
  await assert.rejects(archive.previewFile(file), error => error.message.includes('not valid JSON') && !error.message.includes('DO_NOT_LOG_THIS'));
  await assert.rejects(archive.previewFile(await save('archive.zip', 'not a zip')), /ZIP|archive|export/i);
});

test('direct batch validation is atomic and the archive persists across reopen', async t => {
  const { archive } = await setup(t);
  await assert.rejects(archive.importDocuments([{ text: 'Valid' }, { title: 'Invalid without text' }]), /include text/);
  assert.equal(archive.summary().documents, 0);
  await archive.importDocuments([{ text: 'Persistent note', provider: 'claude', kind: 'memory' }]);
  archive.close();
  await archive.init();
  assert.equal(archive.search('Persistent note').total, 1);
});

test('Claude projects preserve instructions and document text without entering global wake context', async t => {
  const { archive, save } = await setup(t);
  const preview = await archive.previewFile(await save('projects.json', [{ uuid: 'project-1', name: 'Synthetic project', description: 'Project description', prompt_template: 'PROJECT_ONLY_INSTRUCTIONS', docs: [{ filename: 'notes.txt', content: 'PROJECT_ONLY_DOCUMENT' }, { filename: 'image.png', uri: 'private-reference' }] }]));
  assert.equal(preview.projectCount, 1);
  assert.equal(preview.instructionsCount, 0);
  assert.ok(preview.warnings.some(warning => warning.includes('1 project attachment')));
  await archive.commit(preview.token);
  assert.equal(archive.summary().projectCount, 1);
  const record = archive.read(archive.search('PROJECT_ONLY_DOCUMENT').results[0].id);
  assert.ok(record.text.includes('PROJECT_ONLY_INSTRUCTIONS'));
  assert.ok(record.text.includes('PROJECT_ONLY_DOCUMENT'));
  assert.equal(archive.wakeContext(), '');
});

test('current Claude project singleton schema imports its embedded documents', async t => {
  const { archive, save } = await setup(t);
  const preview = await archive.previewFile(await save('project.json', { uuid: 'synthetic-project', name: 'Example project', description: 'An exported description', prompt_template: 'Project-specific instructions', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', docs: [{ uuid: 'synthetic-document', filename: 'example.txt', content: 'Exact embedded text\nwith a second line', created_at: '2026-01-01T00:00:00Z' }] }));
  assert.equal(preview.projectCount, 1);
  await archive.commit(preview.token);
  const record = archive.read(archive.search('Exact embedded text').results[0].id);
  assert.equal(record.kind, 'project');
  assert.ok(record.text.includes('Exact embedded text\nwith a second line'));
  assert.ok(record.text.includes('Project-specific instructions'));
  assert.equal(archive.wakeContext(), '');
});

test('exported Claude conversation summary is searchable without invented summarization', async t => {
  const { archive, save } = await setup(t);
  const preview = await archive.previewFile(await save('conversation.json', { uuid: 'synthetic-conversation', name: 'Example', summary: 'Existing exported summary marker', chat_messages: [{ uuid: 'synthetic-message', sender: 'human', text: 'A question', content: [{ type: 'text', text: 'A question' }], attachments: [], files: [], parent_message_uuid: 'parent' }] }));
  await archive.commit(preview.token);
  assert.equal(archive.search('exported summary marker').total, 1);
  assert.equal(archive.wakeContext(), '');
});

test('distinct conversations remain addressable when their exported text is identical', async t => {
  const { archive } = await setup(t);
  const common = { provider: 'claude', kind: 'conversation', title: 'A chat', text: 'Identical exported message text' };
  const docs = [{ ...common, sourceId: 'source-chat-one' }, { ...common, sourceId: 'source-chat-two' }];
  assert.equal((await archive.importDocuments(docs)).added, 2);
  assert.equal(archive.summary().conversationCount, 2);
  assert.equal(archive.search('Identical exported message text').total, 2);
  assert.equal((await archive.importDocuments(docs)).duplicates, 2);
});

test('Claude artifact exports are stored as inert source text and excluded from wake context', async t => {
  const { archive, dir } = await setup(t);
  const python = process.platform === 'win32' ? fileURLToPath(new URL('../vendor/python/python.exe', import.meta.url)) : 'python3';
  const file = path.join(dir, 'frames.zip');
  const prefix = 'artifacts/00000000-0000-4000-8000-000000000001/';
  const entries = [
    { name: prefix + 'artifact.json', text: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', kind: 'website', versions: [{ id: 'v1', title: 'Synthetic page', description: 'Exported description', created_at: '2026-01-01T00:00:00Z' }], active_version: 'v1' }) },
    { name: prefix + 'versions/v1/index.html', text: '<html><body>ARTIFACT_SOURCE_MARKER<script>throw new Error("MUST_NOT_RUN")</script></body></html>' },
    { name: prefix + 'comments.json', text: JSON.stringify([{ resolved: false, comments: [{ body: 'Synthetic comment', created_at: '2026-01-01T00:00:00Z' }], quoted_text: 'Synthetic quote' }]) },
    { name: prefix + 'versions/v1/image.png', text: 'synthetic binary placeholder' },
  ];
  execFileSync(python, ['-I', '-c', 'import json,sys,zipfile\nv=json.load(sys.stdin)\nwith zipfile.ZipFile(v["path"],"w") as z:\n for item in v["entries"]: z.writestr(item["name"],item["text"])'], { input: JSON.stringify({ path: file, entries }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const preview = await archive.previewFile(file);
  assert.equal(preview.artifactCount, 3);
  assert.equal(preview.memoryCount, 0);
  assert.ok(preview.warnings.some(warning => warning.includes('not executed')));
  await archive.commit(preview.token);
  const result = archive.search('ARTIFACT_SOURCE_MARKER');
  assert.equal(result.total, 1);
  const record = archive.read(result.results[0].id);
  assert.equal(record.kind, 'artifact');
  assert.ok(record.text.includes('<script>throw new Error("MUST_NOT_RUN")</script>'));
  assert.equal(archive.search('Synthetic comment').total, 1);
  assert.equal(archive.wakeContext(), '');
});
