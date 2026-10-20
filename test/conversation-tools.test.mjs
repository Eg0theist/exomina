import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationTools } from '../desktop/conversation-tools.mjs';
import { updateConversation } from '../desktop/chat-management.mjs';

const unpack = response => JSON.parse(response.content[0].text);
const message = (id, content, provider = 'codex', role = 'user') => ({ id, content, provider, role });

test('a receiving model can page through earlier visible work without exposing reasoning or weakening chat access', async () => {
  const current = { id: 'current', messages: [{ id: 'work', role: 'assistant', content: 'Partial answer', activity: [
    { kind: 'thinking', text: 'SECRET_REASONING' }, { kind: 'reasoning', text: 'SECRET_UNKNOWN_REASONING' },
    { id: 'write', kind: 'tool', name: 'workspace_write', target: 'report.txt', status: 'done', output: 'Verified file output 😀 '.repeat(200), session: 'SECRET_NATIVE_SESSION' },
    { kind: 'note', text: 'Created the report; continue with its verification.' },
  ] }] };
  const tools = new ConversationTools({ getConversations: () => [current, { id: 'other', messages: current.messages }], getMemoryEnabled: () => false });
  const ordinary = unpack(await tools.call('conversation_read', { messageId: 'work' }, 'current'));
  assert.equal(ordinary.text, 'Partial answer'); assert.equal(ordinary.message.visibleActivitySteps, 2);
  let text = '', offset = 0;
  do { const page = unpack(await tools.call('conversation_read', { messageId: 'work', includeActivity: true, offset, limit: 201 }, 'current')); text += page.text; offset = page.nextOffset; assert.equal(page.includesActivity, true); } while (offset !== null);
  assert.match(text, /Verified file output/); assert.match(text, /Created the report/); assert.ok(!text.includes('SECRET'));
  const list = unpack(await tools.call('conversation_read', { includeActivity: true }, 'current'));
  assert.ok(list.messages[0].characters > ordinary.totalCharacters);
  await assert.rejects(tools.call('conversation_read', { includeActivity: 'yes' }, 'current'), /true or false/);
  await assert.rejects(tools.call('conversation_read', { includeActivity: true, conversationId: 'other' }, 'current'), /memory|current chat/i);
});

test('the model names only its current new chat once, even with shared memory off', async () => {
  const current={id:'current',title:'New chat',titleSource:'pending',messages:[message('m','Synthetic first task')]},other={id:'other',title:'Existing private name',messages:[]};let saves=0;
  const tools=new ConversationTools({getConversations:()=>[current,other],getMemoryEnabled:()=>false,onTitleChanged:async chat=>{assert.equal(chat,current);saves++;}});
  assert.ok(tools.definitions.some(tool=>tool.name==='conversation_set_title'));
  await assert.rejects(tools.call('conversation_set_title',{title:'Other name',conversationId:'other'},'current'),/Only a title/);
  assert.equal(unpack(await tools.call('conversation_set_title',{title:'Plan the synthetic project'},'current')).updated,true);
  assert.equal(current.title,'Plan the synthetic project');assert.equal(current.titleSource,'model');assert.equal(saves,1);assert.equal(other.title,'Existing private name');
  assert.equal(unpack(await tools.call('conversation_set_title',{title:'Overwrite attempt'},'current')).updated,false);assert.equal(saves,1);
});

test('manual titles, later turns, and archived chats are never renamed by the title tool', async () => {
  for(const overrides of [{title:'My own title',titleSource:'manual'},{title:'Legacy name',titleSource:undefined},{messages:[message('a','First'),message('b','Second')]},{archived:true}]) {
    const chat={id:'current',title:'New chat',titleSource:'pending',messages:[message('m','Task')],...overrides};const before=JSON.stringify(chat);
    const tools=new ConversationTools({getConversations:()=>[chat],onTitleChanged:async()=>{throw Error('Must not save');}});
    assert.equal(unpack(await tools.call('conversation_set_title',{title:'Unexpected rename'},'current')).updated,false);assert.equal(JSON.stringify(chat),before);
  }
});

test('failed title persistence restores pending state, but a concurrent manual rename wins', async () => {
  const chat={id:'current',title:'New chat',titleSource:'pending',messages:[message('m','Task')]};let rename=false;
  const tools=new ConversationTools({getConversations:()=>[chat],onTitleChanged:async()=>{if(rename)updateConversation(chat,'rename',{title:'Manual wins'},{active:true});throw Error('Synthetic disk failure');}});
  await assert.rejects(tools.call('conversation_set_title',{title:'Model proposal'},'current'),/disk failure/);assert.equal(chat.title,'New chat');assert.equal(chat.titleSource,'pending');
  rename=true;await assert.rejects(tools.call('conversation_set_title',{title:'Model proposal'},'current'),/disk failure/);assert.equal(chat.title,'Manual wins');assert.equal(chat.titleSource,'manual');
});
function fixture(conversations, initialMemory = true) {
  let memory = initialMemory;
  return { tools: new ConversationTools({ getConversations: () => conversations, getMemoryEnabled: () => memory }), memory: value => { memory = value; } };
}

test('a switched provider can retrieve the earliest message beyond the 24-message handoff', async () => {
  const history = Array.from({ length: 60 }, (_, index) => message(`m-${index}`, index === 0 ? 'Early requirement: the codename is Synthetic Nightglass.' : `Later turn ${index}`, index < 30 ? 'codex' : 'claude', index % 2 ? 'assistant' : 'user'));
  const { tools } = fixture([{ id: 'current', title: 'One continuous chat', provider: 'claude', model: 'opus', messages: history, sessions: { codex: 'HIDDEN_NATIVE_SESSION', claude: 'HIDDEN_OTHER_SESSION' } }]);
  assert.equal(history.slice(-24).some(item => item.content.includes('Nightglass')), false);
  const found = unpack(await tools.call('conversation_search', { query: 'synthetic nightglass' }, 'current'));
  assert.equal(found.results[0].message.id, 'm-0'); assert.equal(found.results[0].message.messageIndex, 0); assert.equal(found.results[0].message.provider, 'codex');
  const read = unpack(await tools.call('conversation_read', { messageId: 'm-0' }, 'current'));
  assert.equal(read.text, history[0].content); assert.match(read.notice, /untrusted/); assert.equal(JSON.stringify(read).includes('HIDDEN'), false);
});

test('shared memory off permits complete current-chat history and denies all other chat contents and metadata', async () => {
  const f = fixture([{ id: 'current', title: 'Current', messages: [message('m1', 'Synthetic shared keyword current')] }, { id: 'private-other', title: 'SECRET_OTHER_TITLE', sessions: { token: 'SECRET_TOKEN' }, messages: [message('m2', 'Synthetic shared keyword SECRET_OTHER_TEXT')] }], false);
  const found = unpack(await f.tools.call('conversation_search', { query: 'keyword' }, 'current'));
  assert.equal(found.results.length, 1); assert.equal(found.totalMessages, 1); assert.equal(JSON.stringify(found).includes('SECRET'), false);
  for (const name of ['conversation_search', 'conversation_read']) await assert.rejects(f.tools.call(name, { conversationId: 'private-other', query: 'keyword' }, 'current'), /Only the current chat/);
  assert.equal(unpack(await f.tools.call('conversation_read', {}, 'current')).messages[0].id, 'm1');
  f.memory(true); assert.equal(unpack(await f.tools.call('conversation_search', { query: 'keyword' }, 'current')).results.length, 2);
  const other = unpack(await f.tools.call('conversation_read', { conversationId: 'private-other', messageId: 'm2' }, 'current'));
  assert.match(other.text, /SECRET_OTHER_TEXT/); assert.equal(JSON.stringify(other).includes('SECRET_TOKEN'), false);
  f.memory(false); await assert.rejects(f.tools.call('conversation_read', { conversationId: 'private-other', messageId: 'm2' }, 'current'), /Only the current chat/);
});

test('long messages are completely recoverable with bounded Unicode-safe text pages', async () => {
  const content = '🌙' + 'Synthetic history. '.repeat(9000) + '🧬';
  const { tools } = fixture([{ id: 'current', messages: [message('long', content)] }]);
  const header = unpack(await tools.call('conversation_read', {}, 'current')).messages[0];
  assert.equal(header.characters, content.length); assert.ok(header.nextTextOffset);
  let offset = 0, reconstructed = '', pages = 0;
  do { const page = unpack(await tools.call('conversation_read', { messageId: 'long', offset, limit: 32000 }, 'current')); reconstructed += page.text; assert.ok(page.text.length <= 32001); assert.ok(page.nextOffset === null || page.nextOffset > offset); offset = page.nextOffset; pages++; } while (offset !== null);
  assert.ok(pages > 4); assert.equal(reconstructed, content);
  const tiny = unpack(await tools.call('conversation_read', { messageId: 'long', limit: 1 }, 'current'));
  assert.equal(tiny.text, '🌙'); assert.equal(tiny.nextOffset, 2);
});

test('message-list and literal-search pagination keep stable IDs and accurate source positions', async () => {
  const messages = Array.from({ length: 42 }, (_, index) => message(`m${index}`, `İ 🌙 line ${index}: literal [a.*] marker`));
  const { tools } = fixture([{ id: 'current', messages }]);
  const first = unpack(await tools.call('conversation_read', { offset: 20, limit: 20 }, 'current'));
  assert.equal(first.messages.length, 20); assert.equal(first.messages[0].messageIndex, 20); assert.equal(first.nextOffset, 40);
  const seen = []; let offset = 0;
  do { const page = unpack(await tools.call('conversation_search', { query: '[a.*]', offset, limit: 7 }, 'current')); for (const hit of page.results) { seen.push(hit.message.id); assert.equal(messages[hit.message.messageIndex].content.slice(hit.matchOffset, hit.matchOffset + 5), '[a.*]'); } offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(seen, messages.map(item => item.id));
});

test('bounded scanning provides continuation even when the first search page has no matches', async () => {
  const messages = Array.from({ length: 1005 }, (_, index) => message(`m${index}`, index === 1004 ? 'Needle on final page' : 'Synthetic filler'));
  const { tools } = fixture([{ id: 'current', messages }]);
  const first = unpack(await tools.call('conversation_search', { query: 'Needle' }, 'current'));
  assert.equal(first.results.length, 0); assert.equal(first.scannedMessages, 1000); assert.equal(first.nextOffset, 1000);
  const last = unpack(await tools.call('conversation_search', { query: 'Needle', offset: first.nextOffset }, 'current'));
  assert.equal(last.results[0].message.id, 'm1004'); assert.equal(last.nextOffset, null);
});

test('tools require a valid active chat and never serialize native state, hidden reasoning, configuration or arbitrary message fields', async () => {
  const f = fixture([{ id: 'current', title: 'Synthetic', apiKey: 'SECRET_KEY', sessions: 'SECRET_SESSION', messages: [{ ...message('m1', 'Visible transcript'), thinking: 'SECRET_REASONING', auth: 'SECRET_AUTH', toolResult: { token: 'SECRET_TOKEN' } }] }]);
  for (const name of ['conversation_search', 'conversation_read']) {
    await assert.rejects(f.tools.call(name, { query: 'Visible' }, 'missing'), /No active conversation/);
    const response = await f.tools.call(name, { query: 'Visible' }, 'current'); assert.equal(JSON.stringify(response).includes('SECRET'), false);
  }
  for (const args of [{ limit: 21 }, { offset: -1 }, { offset: 0.5 }, { messageId: 'm1', limit: 32001 }]) await assert.rejects(f.tools.call('conversation_read', args, 'current'), /valid/);
  await assert.rejects(f.tools.call('conversation_search', { query: ' ' }, 'current'), /literal text/);
  await assert.rejects(f.tools.call('conversation_search', { query: 'x'.repeat(2001) }, 'current'), /literal text/);
  await assert.rejects(f.tools.call('conversation_delete', {}, 'current'), /Unknown/);
});
