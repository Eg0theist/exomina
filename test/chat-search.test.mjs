import test from 'node:test';
import assert from 'node:assert/strict';
import { findTextMatches, findChatMatches, searchChats, MAX_FIND_MATCHES } from '../src/chat-search.js';

test('literal Unicode search preserves original text positions and treats regex characters as text', () => {
  const text = '🌙 café CAFÉ a+b [draft]';
  assert.deepEqual([...findTextMatches(text, 'café')], [{start:3,end:7},{start:8,end:12}]);
  assert.equal(text.slice(findTextMatches(text, 'a+b')[0].start, findTextMatches(text, 'a+b')[0].end), 'a+b');
  assert.equal(findTextMatches(text, '[draft]').length, 1);
  assert.equal(findTextMatches(text, '   ').length, 0);
});

test('in-chat find uses visible message indices and reports a bounded result', () => {
  const chat = {messages:[{role:'system',content:'hidden needle'},{id:'a',role:'user',content:'needle and needle'},{id:'b',role:'assistant',content:'Needle'}]};
  assert.deepEqual([...findChatMatches(chat,'needle')], [{messageIndex:0,start:0,end:6,messageId:'a'},{messageIndex:0,start:11,end:17,messageId:'a'},{messageIndex:1,start:0,end:6,messageId:'b'}]);
  const many=findChatMatches({messages:[{role:'user',content:'a '.repeat(MAX_FIND_MATCHES+1)}]},'a');
  assert.equal(many.length,MAX_FIND_MATCHES);assert.equal(many.truncated,true);
  const across=findChatMatches({messages:[{role:'user',content:'a '.repeat(MAX_FIND_MATCHES)},{role:'assistant',content:'a'}]},'a');assert.equal(across.truncated,true);assert.equal(across.length,MAX_FIND_MATCHES);
});

test('chat suggestions search titles and message contents within the chosen archive scope', () => {
  const chats=[{id:'one',title:'Design notes',messages:[{role:'system',content:'private needle'},{role:'user',content:'A café in Berlin'}]},{id:'two',title:'Café plans',archived:true,messages:[]},{id:'three',title:'Other',messages:[{role:'assistant',content:'CAFÉ menu'}]}];
  const active=searchChats(chats,{query:'café'});assert.deepEqual(active.map(row=>row.chat.id),['one','three']);assert.equal(active[0].messageIndex,0);assert.match(active[0].snippet,/café/);
  assert.deepEqual(searchChats(chats,{query:'café',scope:'archived'}).map(row=>row.chat.id),['two']);
  const all=searchChats(chats,{query:'café',scope:'all',limit:2});assert.equal(all.length,2);assert.equal(all.truncated,true);
  assert.equal(searchChats(chats,{query:'private needle',scope:'all'}).length,0);
});

test('title matches open the chat at its latest message even when older content also matches',()=>{
  const chat={id:'setup',title:'Exomina Setup',messages:[{role:'user',content:'Old Exomina setup question'},{role:'assistant',content:'Historical answer about taskbar colours'}]};
  const title=searchChats([chat],{query:'exomina setup'})[0];assert.equal(title.titleMatch,true);assert.equal(title.messageIndex,null);assert.equal(title.snippet,'Matches the chat title');
  const content=searchChats([chat],{query:'taskbar'})[0];assert.equal(content.titleMatch,false);assert.equal(content.messageIndex,1);assert.match(content.snippet,/taskbar/);
});
