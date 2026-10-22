import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryConversations,conversationSummary} from '../desktop/library-view.mjs';
import {searchChats} from '../desktop/chat-search.mjs';
import {mergeChatSnapshot} from '../src/chat-snapshot.js';

const chat=(id,content)=>({id,title:id,provider:'codex',messages:[{id:id+'-m',role:'assistant',content}]});
test('compact bootstrap sends the selected history and metadata for every other chat',()=>{
  const all=[chat('open','Complete history'),chat('old','HIDDEN_LIBRARY_BODY')];
  const compact=libraryConversations(all,{compact:true,conversationId:'open'});
  assert.equal(compact[0],all[0]);assert.deepEqual(compact[1].messages,[]);assert.equal(compact[1].messageCount,1);
  assert.doesNotMatch(JSON.stringify(compact),/HIDDEN_LIBRARY_BODY/);assert.equal(all[1].messages[0].content,'HIDDEN_LIBRARY_BODY');
  assert.equal(libraryConversations(all),all);assert.equal(conversationSummary(compact[1]).messageCount,1);
  assert.equal(libraryConversations(all,{compact:'false'}),all);
  assert.equal(conversationSummary({...all[1],messages:[{role:'user',content:'Earlier work'}]}).hasUserMessages,true);
});
test('library search returns a historical target without retaining the result body',()=>{
  const all=[chat('old','A needle in historical content')],hits=searchChats(all,{query:'needle',scope:'all'});
  const result=hits.map(hit=>({...hit,chat:conversationSummary(hit.chat)}));
  assert.equal(result[0].messageIndex,0);assert.match(result[0].snippet,/needle/);assert.deepEqual(result[0].chat.messages,[]);
});
test('compact refresh evicts closed histories even while they stream',()=>{
  const old=chat('old','large history'),open=chat('open','current stream');
  const result=mergeChatSnapshot([old,open],libraryConversations([old,open],{compact:true,conversationId:'open'}),{old:true,open:true},'open');
  assert.deepEqual(result[0].messages,[]);assert.equal(result[1],open);
});
test('a delayed bootstrap does not blank the newly opened chat or retain the previous one',()=>{
  const old=chat('old','old body'),open=chat('open','new body');
  const delayed=libraryConversations([old,open],{compact:true,conversationId:'old'});
  const result=mergeChatSnapshot([conversationSummary(old),open],delayed,{},'open');
  assert.deepEqual(result[0].messages,[]);assert.equal(result[1].messages,open.messages);assert.equal(result[1].messagesLoaded,true);
});
test('opening a running summary accepts its full history instead of preserving an empty stream',()=>{
  const open=chat('open','Full running history'),other=chat('other','body');
  const result=mergeChatSnapshot([conversationSummary(open),conversationSummary(other)],libraryConversations([open,other],{compact:true,conversationId:'open'}),{open:true},'open');
  assert.equal(result[0],open);
});
