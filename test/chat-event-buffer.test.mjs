import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatEventBuffer} from '../src/chat-event-buffer.js';
const fixture=()=>{const delivered=[],timers=new Map();let next=0;const buffer=createChatEventBuffer(event=>delivered.push(event),{setTimer:callback=>{timers.set(++next,callback);return next;},clearTimer:id=>timers.delete(id)});return {buffer,delivered,timers,tick(){for(const fn of [...timers.values()])fn();}};};
test('short stream batches retain all text and tool output in conversation order',()=>{
 const f=fixture();for(const text of ['A','B','C'])f.buffer.accept({type:'chat.delta',conversationId:'a',text});
 f.buffer.accept({type:'chat.activity',conversationId:'a',step:{id:'tool'},append:'result'});f.buffer.accept({type:'chat.delta',conversationId:'b',text:'D'});
 assert.equal(f.delivered.length,0);assert.equal(f.timers.size,1);f.tick();
 assert.deepEqual(f.delivered.map(event=>event.text||event.append),['ABC','result','D']);assert.equal(f.timers.size,0);
});
test('question and completion events are immediate and follow pending text without loss',()=>{
 const f=fixture();f.buffer.accept({type:'chat.delta',conversationId:'a',text:'Before'});f.buffer.accept({type:'chat.question',conversationId:'a',question:{id:'q'}});
 assert.deepEqual(f.delivered.map(event=>event.type),['chat.delta','chat.question']);
 f.buffer.accept({type:'chat.delta',conversationId:'a',text:'After'});f.buffer.accept({type:'chat.complete',conversationId:'a'});f.tick();
 assert.deepEqual(f.delivered.map(event=>event.type),['chat.delta','chat.question','chat.delta','chat.complete']);
});
test('closing a renderer subscription discards timers and admits no obsolete events',()=>{
 const f=fixture();f.buffer.accept({type:'chat.delta',conversationId:'a',text:'old'});f.buffer.close();f.tick();f.buffer.accept({type:'approval'});assert.equal(f.delivered.length,0);assert.equal(f.timers.size,0);
});
