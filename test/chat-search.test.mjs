import test from 'node:test';
import assert from 'node:assert/strict';
import { findTextMatches, findChatMatches, searchChats, chatSearchExcerpt, MAX_FIND_MATCHES } from '../src/chat-search.js';

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

test('both chat searches find progress updates in replies with no final text', () => {
  const chat = {id:'modding',title:'Game Modding',messages:[
    {role:'system',content:'Gray Zone Warfare hidden system text'},
    {id:'work',role:'assistant',content:'',activity:[
      {id:'thinking',kind:'thinking',text:'Private reasoning needle'},
      {id:'progress',kind:'note',text:"I'll start by checking what's on disk: the Gray Zone Warfare install, the REA tools, and the TLOU2 setup from earlier work."},
    ]},
  ]};
  const hits = findChatMatches(chat, 'Gray Zone Warfare');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageIndex, 0);
  assert.equal(hits[0].messageId, 'work');
  assert.ok(hits[0].source);
  const result = searchChats([chat], {query:'Gray Zone Warfare',scope:'all'})[0];
  assert.equal(result?.chat.id, 'modding');
  assert.equal(result.messageIndex, 0);
  assert.equal(result.source, hits[0].source);
  assert.match(result.snippet, /Gray Zone Warfare/);
  assert.equal(findChatMatches(chat, 'Private reasoning needle').length, 0);
});

test('both chat searches include follow-up questions, answers and task resolutions', () => {
  const chat = {id:'modding',messages:[{id:'reply',role:'assistant',content:'The work is complete.',
    followups:[{id:'request',text:'Find the hideout tracker',answer:'Use GZW Quartermaster.',summary:'Loot list added.'}],
    activity:[{kind:'followup',followupId:'request'}],
  }]};
  for (const query of ['hideout tracker','GZW Quartermaster','Loot list']) {
    const matches = findChatMatches(chat,query);
    assert.equal(matches.length,1);
    assert.equal(searchChats([chat],{query})[0]?.source,matches[0].source);
  }
});

test('find distinguishes equal offsets in different progress updates and bounds all sources', () => {
  const chat = {messages:[{role:'assistant',content:'',activity:[
    {kind:'note',text:'🌙 café one'}, {kind:'note',text:'🌙 CAFÉ two'},
  ]}]};
  const matches = findChatMatches(chat,'café');
  assert.equal(matches.length,2);
  assert.notEqual(matches[0].source,matches[1].source);
  assert.deepEqual(matches.map(({start,end})=>({start,end})),[{start:3,end:7},{start:3,end:7}]);
  const many = findChatMatches({messages:[{role:'assistant',content:'a '.repeat(MAX_FIND_MATCHES),followups:[{text:'a'}]}]},'a');
  assert.equal(many.length,MAX_FIND_MATCHES);
  assert.equal(many.truncated,true);
});

test('search reveals exact nested text as bounded plain text and includes submitted question answers', () => {
  const message = {role:'assistant',content:'Final reply',questions:[{id:'group',status:'answered',questions:[{id:'choice',question:'Which hideout upgrade?'}],answers:{choice:{answers:['🌙 café <script>selected</script>']}}}]};
  const chat = {id:'answers',messages:[message]};
  const hit = findChatMatches(chat,'café <script>')[0];
  assert.ok(hit);
  assert.equal(searchChats([chat],{query:'café <script>'})[0]?.source,hit.source);
  assert.deepEqual(chatSearchExcerpt(message,hit),{label:'Your answer',before:'🌙 ',match:'café <script>',after:'selected</script>'});
  assert.equal(findChatMatches(chat,'hideout upgrade').length,1);
  assert.equal(chatSearchExcerpt(message,{...hit,end:10000}),null);
  assert.equal(chatSearchExcerpt(message,{...hit,source:'missing'}),null);
  assert.equal(chatSearchExcerpt(message,{start:0,end:5}),null);
  const long = {role:'assistant',activity:[{kind:'note',text:'before '.repeat(500)+'needle'+' after'.repeat(500)}]};
  const excerpt = chatSearchExcerpt(long,findChatMatches({messages:[long]},'needle')[0]);
  assert.ok(excerpt.before.length+excerpt.match.length+excerpt.after.length<200);
  assert.ok(excerpt.before.startsWith('…'));assert.ok(excerpt.after.endsWith('…'));
});
