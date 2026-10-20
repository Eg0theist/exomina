import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MessagingHub,chunk,CHANNEL_TOOLS} from '../desktop/messaging.mjs';

function setup(t){
  const sent=[],chats=[];let settings={};
  class FakeBridge{constructor(options){this.options=options;FakeBridge.last=this;}async start(){return {name:'@exo_bot'};}stop(){}async send(chatKey,text){sent.push({chatKey,text});}typing(){}}
  return mkdtemp(path.join(tmpdir(),'exomina-msg-')).then(dataDir=>{
    t.after(()=>rm(dataDir,{recursive:true,force:true}));
    const hub=new MessagingHub({dataDir,encryption:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('enc:'+value),decryptString:buffer=>buffer.toString().slice(4)},getSettings:()=>settings,saveSettings:async patch=>{settings={...settings,...patch};},
      chat:async request=>{chats.push(request);return {conversationId:request.conversationId||'chat-1',text:'Reply to '+request.text};},usageText:()=>'Claude · 5-hour session: 40% left',providerFor:name=>name==='claude'?{id:'claude',name:'Claude'}:null,Bridges:{telegram:FakeBridge,discord:FakeBridge}});
    return {hub,sent,chats,dataDir,bridge:()=>FakeBridge.last,settings:()=>settings};
  });
}
const from=(text,userId='42')=>({channel:'telegram',chatKey:'100',userId,name:'Alex',text});

test('unavailable secret protection refuses new bot credentials while retaining existing bytes and settings',async t=>{
 const f=await setup(t);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');
 const before=await readFile(f.hub.file,'utf8'),settings=structuredClone(f.settings());let cryptoCalls=0;
 for(const blocked of [{isEncryptionAvailable:()=>false},{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text',encryptString:()=>{cryptoCalls++;throw Error('must not encrypt');},decryptString:()=>{cryptoCalls++;throw Error('must not decrypt');}}]){
  f.hub.encryption=blocked;
  await assert.rejects(f.hub.connect('telegram','123456789:AAreplacementTokenValue_x'),error=>error.code==='SECRET_STORAGE_UNAVAILABLE');
  await assert.rejects(f.hub.token('telegram'),error=>error.code==='SECRET_STORAGE_UNAVAILABLE');
  assert.equal(await readFile(f.hub.file,'utf8'),before);assert.deepEqual(f.settings(),settings);
 }
 assert.equal(cryptoCalls,0);
 // Disconnect remains available without unlocking credentials.
 await f.hub.disconnect('telegram');assert.deepEqual(JSON.parse(await readFile(f.hub.file,'utf8')),{});
});
test('scheduled delivery only reaches a paired recipient and unpairing revokes it',async t=>{const f=await setup(t);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');const code=f.hub.newCode('telegram');await f.hub.receive(from('/pair '+code));assert.deepEqual(f.hub.recipients('telegram'),[{chatKey:'100',name:'Alex'}]);await f.hub.sendScheduled('telegram','100','Scheduled result');assert.equal(f.sent.at(-1).text,'Scheduled result');await assert.rejects(f.hub.sendScheduled('telegram','999','Never send this'),/no longer paired/);await f.hub.unpair('telegram','42');await assert.rejects(f.hub.sendScheduled('telegram','100','Never send this'),/no longer paired/);});

test('only paired accounts reach Exomina; strangers get one notice', async t=>{
  const {hub,sent,chats,dataDir,settings}=await setup(t);
  await hub.connect('telegram','123456789:AAexampleTokenValue_x');
  assert.match(await readFile(path.join(dataDir,'messaging-tokens.json'),'utf8'),/telegram/);
  assert.doesNotMatch(await readFile(path.join(dataDir,'messaging-tokens.json'),'utf8'),/AAexampleTokenValue/);
  await hub.receive(from('hello','666'));await hub.receive(from('hello again','666'));
  assert.equal(sent.length,1);assert.match(sent[0].text,/private Exomina bot/);assert.equal(chats.length,0);
  await hub.receive(from('/pair 000000'));assert.equal(settings().messaging.telegram.paired.length,0);
  const code=hub.view().telegram.code;assert.match(code,/^\d{6}$/);
  await hub.receive(from(`/pair ${code}`));
  assert.equal(settings().messaging.telegram.paired[0].id,'42');assert.match(sent.at(-1).text,/^Paired\./);
  assert.equal(hub.view().telegram.code,null,'a pairing code works once');
});

test('paired messages run in a linked chat; commands switch AI, show usage and start over', async t=>{
  const {hub,sent,chats,settings}=await setup(t);
  await hub.connect('telegram','123456789:AAexampleTokenValue_x');
  await hub.receive(from(`/pair ${hub.view().telegram.code}`));
  await hub.receive(from('What is on my list?'));
  const {signal,...request}=chats[0];assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(request,{channel:'telegram',chatKey:'100',name:'Alex',text:'What is on my list?',conversationId:undefined,provider:undefined});
  assert.equal(sent.at(-1).text,'Reply to What is on my list?');
  assert.equal(settings().messaging.telegram.links['100'],'chat-1');
  await hub.receive(from('And tomorrow?'));assert.equal(chats[1].conversationId,'chat-1');
  await hub.receive(from('/ai claude'));assert.equal(settings().messaging.telegram.provider,'claude');
  await hub.receive(from('/ai nonsense'));assert.match(sent.at(-1).text,/don’t know that AI/);
  await hub.receive(from('/usage'));assert.match(sent.at(-1).text,/40% left/);
  await hub.receive(from('/new'));assert.equal(settings().messaging.telegram.links['100'],undefined);
});

test('long replies split at natural breaks within the platform limit', ()=>{
  const text=Array.from({length:30},(_, index)=>`Paragraph ${index} `+'word '.repeat(40)).join('\n\n');
  const parts=chunk(text,1900);
  assert.ok(parts.length>1);assert.ok(parts.every(part=>part.length<=1900));
  assert.ok(parts.every(part=>part.startsWith('Paragraph')));
});

test('channel chats keep to memory, archive and chat tools', ()=>{
  for(const name of ['memory_note','archive_search','conversation_read','personalization_update'])assert.ok(CHANNEL_TOOLS.test(name),name);
  for(const name of ['workspace_shell','browser_open','desktop_click','external_cua_click_1','image_generate','conversation_set_title'])assert.ok(!CHANNEL_TOOLS.test(name),name);
});

test('Telegram bridge: getMe, long polling with offsets, chunked plain-text replies', async ()=>{
  const {TelegramBridge}=await import('../desktop/messaging.mjs');
  const calls=[];let polls=0;const received=[];
  const fetchImpl=async(url,options)=>{const method=url.split('/').pop();const body=JSON.parse(options.body);calls.push({method,body});
    const reply=result=>({json:async()=>({ok:true,result}),status:200});
    if(method==='getMe')return reply({username:'exo_bot'});
    if(method==='getUpdates'){polls++;if(polls===1)return reply([{update_id:7,message:{chat:{id:100,type:'private'},from:{id:42,first_name:'Alex'},text:'hi'}},{update_id:8,message:{chat:{id:100,type:'private'},from:{id:9,is_bot:true},text:'bot'}},{update_id:9,message:{chat:{id:-100,type:'group'},from:{id:42,first_name:'Alex'},text:'group'}}]);await new Promise(resolve=>options.signal.addEventListener('abort',resolve));throw new Error('aborted');}
    return reply(true);};
  const bridge=new TelegramBridge({token:'t',fetchImpl,onMessage:message=>received.push(message)});
  assert.deepEqual(await bridge.start(),{name:'@exo_bot'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(received,[{channel:'telegram',chatKey:'100',userId:'42',name:'Alex',text:'hi'}]);
  assert.equal(calls.filter(call=>call.method==='getUpdates')[1].body.offset,10,'next poll starts after private, bot and ignored group updates');
  await bridge.send('100','x'.repeat(5000));
  assert.equal(calls.filter(call=>call.method==='sendMessage').length,2);
  bridge.stop();
});

test('Discord bridge: identifies for direct messages and ignores servers and bots', async ()=>{
  const {DiscordBridge}=await import('../desktop/messaging.mjs');
  const sockets=[];class FakeSocket{constructor(url){this.url=url;this.sent=[];this.readyState=1;sockets.push(this);}send(value){this.sent.push(JSON.parse(value));}close(){}}
  const received=[];
  const fetchImpl=async url=>({ok:true,status:200,json:async()=>url.endsWith('/users/@me')?{id:'555',username:'exo'}:{}});
  const bridge=new DiscordBridge({token:'d',fetchImpl,WebSocketImpl:FakeSocket,onMessage:message=>received.push(message)});
  const info=await bridge.start();assert.match(info.inviteUrl,/client_id=555/);
  const socket=sockets[0];const deliver=packet=>socket.onmessage({data:JSON.stringify(packet)});
  deliver({op:10,d:{heartbeat_interval:45000}});
  assert.equal(socket.sent[0].op,2);assert.equal(socket.sent[0].d.intents,1<<12);
  deliver({op:0,s:2,t:'MESSAGE_CREATE',d:{channel_id:'c1',author:{id:'42',username:'alex'},content:'hello'}});
  deliver({op:0,s:3,t:'MESSAGE_CREATE',d:{guild_id:'g',channel_id:'c2',author:{id:'42'},content:'in a server'}});
  deliver({op:0,s:4,t:'MESSAGE_CREATE',d:{channel_id:'c1',author:{id:'1',bot:true},content:'echo'}});
  assert.deepEqual(received,[{channel:'discord',chatKey:'c1',userId:'42',name:'alex',text:'hello'}]);
  bridge.stop();
});

test('both channels can save encrypted tokens and settings concurrently',async t=>{
  const f=await setup(t);
  await Promise.all([f.hub.connect('telegram','123456789:AAexampleTokenValue_x'),f.hub.connect('discord','Discord_exampleTokenValue_x')]);
  assert.equal(f.settings().messaging.telegram.enabled,true);assert.equal(f.settings().messaging.discord.enabled,true);
  const saved=JSON.parse(await readFile(path.join(f.dataDir,'messaging-tokens.json'),'utf8'));
  assert.deepEqual(Object.keys(saved).sort(),['discord','telegram']);
  assert.equal(await f.hub.token('discord'),'Discord_exampleTokenValue_x');
  f.hub.stopAll();
});

test('rejected bot credentials do not replace a saved token or enable a new bot',async t=>{
  const f=await setup(t);const Real=f.hub.Bridges.telegram;
  f.hub.Bridges={...f.hub.Bridges,telegram:class extends Real{async start(){throw Object.assign(new Error('Unauthorized'),{status:401});}}};
  await assert.rejects(f.hub.connect('telegram','123456789:invalidTokenValue_x'),/rejected/);
  assert.equal(f.hub.config('telegram').enabled,false);assert.equal(await f.hub.token('telegram'),null);
  assert.equal(f.hub.view().telegram.state,'error');assert.equal(f.hub.bridges.size,0);
});

test('disconnect while a bot is starting cannot resurrect its connection',async t=>{
  const f=await setup(t);let release;const Real=f.hub.Bridges.telegram;
  f.hub.Bridges={...f.hub.Bridges,telegram:class extends Real{async start(){await new Promise(resolve=>release=resolve);return {name:'late bot'};}}};
  const starting=f.hub.connect('telegram','123456789:AAexampleTokenValue_x'),rejected=assert.rejects(starting,/stopped/);
  await f.hub.disconnect('telegram');release();await rejected;
  assert.equal(f.hub.config('telegram').enabled,false);assert.equal(await f.hub.token('telegram'),null);assert.equal(f.hub.view().telegram.state,'off');
});

test('unpairing revokes an unfinished reply and clears its linked remote chat',async t=>{
  const f=await setup(t);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');await f.hub.receive(from('/pair '+f.hub.view().telegram.code));
  await f.hub.receive(from('first'));assert.equal(f.hub.config('telegram').links['100'],'chat-1');
  let finish,signal;f.hub.chat=async request=>{signal=request.signal;return new Promise(resolve=>finish=resolve);};
  const pending=f.hub.receive(from('private work'));await new Promise(resolve=>setImmediate(resolve));
  await f.hub.unpair('telegram','42');assert.equal(signal.aborted,true);finish({conversationId:'chat-1',text:'DO_NOT_DELIVER'});await pending;
  assert.equal(f.sent.some(item=>item.text==='DO_NOT_DELIVER'),false);assert.equal(f.hub.config('telegram').links['100'],undefined);assert.equal(f.hub.chains.size,0);
});

test('Discord becomes connected at READY and detects a missing heartbeat acknowledgement',async()=>{
  const {DiscordBridge}=await import('../desktop/messaging.mjs');const statuses=[],sockets=[];
  class Socket{constructor(){this.readyState=1;this.sent=[];sockets.push(this);}send(value){this.sent.push(JSON.parse(value));}close(code){this.readyState=3;this.code=code;this.onclose?.({code});}}
  const bridge=new DiscordBridge({token:'synthetic',WebSocketImpl:Socket,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:'555',username:'exo'})}),onStatus:value=>statuses.push(value),reconnectDelay:1000});
  assert.equal((await bridge.start()).state,'connecting');assert.equal(statuses.some(s=>s.state==='connected'),false);
  const socket=sockets[0];socket.onmessage({data:JSON.stringify({op:10,d:{heartbeat_interval:8}})});
  socket.onmessage({data:JSON.stringify({op:0,t:'READY',s:1,d:{}})});assert.equal(statuses.at(-1).state,'connected');
  const deadline=Date.now()+2000;while(socket.code!==4000&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(socket.code,4000);assert.equal(statuses.at(-1).state,'retrying');bridge.stop();
});

test('Discord rate limits have a bounded retry and stopping aborts pending waits',async()=>{
  const {DiscordBridge}=await import('../desktop/messaging.mjs');let attempts=0,waits=0;
  const bridge=new DiscordBridge({token:'synthetic',fetchImpl:async()=>{attempts++;return {ok:false,status:429,json:async()=>({message:'Too many requests',retry_after:0.01})};},delayImpl:async()=>{waits++;}});
  await assert.rejects(bridge.rest('/users/@me'),/Too many requests/);assert.equal(attempts,3);assert.equal(waits,2);bridge.stop();
});

test('network failures redact a bot token before it reaches status or the caller',async()=>{
  const {TelegramBridge}=await import('../desktop/messaging.mjs'),token='synthetic-sensitive-token';
  const bridge=new TelegramBridge({token,fetchImpl:async()=>{throw Error('Request failed https://api.telegram.org/bot'+token+'/getMe');}});
  await assert.rejects(bridge.start(),error=>!error.message.includes(token)&&error.message.includes('[bot token]'));bridge.stop();
});

test('Discord resumes its session after reconnect and ignores replayed message IDs',async()=>{
  const {DiscordBridge}=await import('../desktop/messaging.mjs');const sockets=[],received=[];
  class Socket{constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this);}send(raw){this.sent.push(JSON.parse(raw));}close(code){this.readyState=3;this.onclose?.({code});}}
  const bridge=new DiscordBridge({token:'synthetic',WebSocketImpl:Socket,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:'555',username:'exo'})}),onMessage:m=>received.push(m),reconnectDelay:1});await bridge.start();
  const deliver=(socket,p)=>socket.onmessage({data:JSON.stringify(p)}),hello={op:10,d:{heartbeat_interval:45000}};
  deliver(sockets[0],hello);deliver(sockets[0],{op:0,t:'READY',s:2,d:{session_id:'session-1',resume_gateway_url:'wss://gateway.discord.gg/'}});
  const message={op:0,t:'MESSAGE_CREATE',s:3,d:{id:'same-message',channel_id:'dm',author:{id:'42',username:'owner'},content:'hello'}};deliver(sockets[0],message);deliver(sockets[0],message);assert.equal(received.length,1);
  sockets[0].close(1006);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(sockets.length,2);deliver(sockets[1],hello);assert.deepEqual(sockets[1].sent[0],{op:6,d:{token:'synthetic',session_id:'session-1',seq:3}});bridge.stop();
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(sockets.length,2);
});

test('wrong pairing codes expire after five attempts and real expiry emits updated status',async t=>{
  const f=await setup(t),events=[];f.hub.emit=value=>events.push(value);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');
  for(let n=0;n<5;n++)await f.hub.receive(from('/pair 000000','stranger'));
  assert.equal(f.hub.view().telegram.code,null);assert.equal(f.hub.config('telegram').paired.length,0);
  f.hub.pairingTtl=20;f.hub.newCode('telegram');await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events.at(-1).status.telegram.code,null);assert.equal(f.hub.codeTimers.size,0);f.hub.stopAll();
});

test('disconnect forgets paired accounts and chat links as well as the token',async t=>{
  const f=await setup(t);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');await f.hub.receive(from('/pair '+f.hub.view().telegram.code));await f.hub.receive(from('hello'));
  await f.hub.disconnect('telegram');assert.deepEqual(f.hub.config('telegram').paired,[]);assert.deepEqual(f.hub.config('telegram').links,{});assert.equal(await f.hub.token('telegram'),null);
});

test('a rejected replacement automatically restores the previous saved bot',async t=>{
  const f=await setup(t),Real=f.hub.Bridges.telegram;
  f.hub.Bridges={...f.hub.Bridges,telegram:class extends Real{async start(){if(this.options.token.includes('invalid'))throw Object.assign(Error('Unauthorized'),{status:401});return {name:'working bot'};}}};
  await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');
  await assert.rejects(f.hub.connect('telegram','123456789:invalidTokenValue_x'),/saved token is still in use/);
  assert.equal(f.hub.view().telegram.state,'connected');assert.equal(await f.hub.token('telegram'),'123456789:AAexampleTokenValue_x');f.hub.stopAll();
});

test('queued chat-key migration cannot restore an account being unpaired',async t=>{
  const f=await setup(t);await f.hub.connect('telegram','123456789:AAexampleTokenValue_x');await f.hub.receive(from('/pair '+f.hub.view().telegram.code));
  let release;f.hub.configWrites=new Promise(resolve=>release=resolve);
  const removed=f.hub.unpair('telegram','42'),received=f.hub.receive({...from('old message'),chatKey:'new-key'});release();await Promise.all([removed,received]);
  assert.deepEqual(f.hub.config('telegram').paired,[]);assert.equal(f.chats.length,0);f.hub.stopAll();
});
