import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {memoryInstructions,memoryApproval,recentConversation,conversationTitleInstructions,habitInstructions} from '../desktop/context.mjs';

test('only the normal first reply is asked to name a new chat', () => {
  const chat={title:'New chat',titleSource:'pending',messages:[{role:'user',content:'Task'}]};
  assert.match(conversationTitleInstructions(chat),/conversation_set_title once/);
  assert.match(conversationTitleInstructions(chat),/normal reply/);
  assert.equal(conversationTitleInstructions({...chat,titleSource:'manual'}),'');
  assert.equal(conversationTitleInstructions({...chat,messages:[...chat.messages,{role:'user'}]}),'');
});

test('automatic capture is the default, ask-first remains explicit, and memory off restricts shared context', async () => {
  let approvals = 0;
  const approve = async () => { approvals++; return false; };
  assert.equal(await memoryApproval({memoryEnabled:true}, approve)({}), true);
  assert.equal(approvals, 0);
  assert.equal(await memoryApproval({memoryCapture:'ask'}, approve)({}), false);
  assert.equal(approvals, 1);
  assert.match(memoryInstructions({memoryEnabled:true}), /automatically/);
  assert.match(memoryInstructions({memoryEnabled:true}), /Do not save passwords/);
  assert.match(memoryInstructions({memoryEnabled:true,memoryCapture:'ask'}), /approve each note/);
  assert.match(memoryInstructions({memoryEnabled:false}), /current conversation remains available/);
});

test('bounded recent handoff remains valid JSON with message identity and provider', () => {
  const messages = Array.from({length:60}, (_, n) => ({id:String(n),role:n%2?'assistant':'user',provider:n%2?'claude':'codex',content:'\\"\n'.repeat(15000)}));
  const text = recentConversation(messages);
  assert.ok(text.length <= 100000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.at(-1).id, '59');
  assert.equal(parsed.at(-1).provider, 'claude');
  assert.ok(parsed.length > 0 && parsed.length < 24);
});

test('usage habits are suggested sparingly and never replace the task', async () => {
  assert.match(habitInstructions, /one chat per project/);
  assert.match(habitInstructions, /rarely, at most once per topic, never instead of the task/);
  // Both the desktop and the private-server context carry the same guidance.
  for (const file of ['desktop/main.mjs','cloud/service.mjs']) assert.match(await readFile(file,'utf8'), /conversationInstructions\+habitInstructions/, file);
});
