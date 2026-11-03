import test from 'node:test';
import assert from 'node:assert/strict';
import {MessagingHub} from '../desktop/messaging.mjs';
import {DiscordTasks} from '../desktop/discord-tasks.mjs';

function fixture(){
  let settings={messaging:{discord:{enabled:true,paired:[{id:'owner',chatKey:'dm',name:'Owner'},{id:'other',chatKey:'other-dm'}],links:{}}}};
  const chats=new Map(),approvals=new Map(),runs=new Map(),sent=[],responses=[],answers=[],timers=new Map();let clock=Date.now(),sequence=0;
  const tasks=new DiscordTasks({getChat:id=>chats.get(id),getApproval:id=>approvals.get(id),listApprovals:()=>[...approvals.values()],respondApproval:async payload=>{responses.push(payload);approvals.delete(payload.id);return {approved:payload.decision==='once'};},answerQuestion:async(id,payload)=>{answers.push({conversationId:id,...payload});const group=chats.get(id).messages.flatMap(m=>m.questions||[]).find(q=>q.id===payload.id);group.status='answered';return {status:'answered',deliveryState:'delivered'};},getRun:id=>runs.get(id),projects:()=>[],workspace:()=>'',setMode:async()=>{},stop:id=>runs.delete(id),now:()=>clock});
  const hub=new MessagingHub({dataDir:'.',encryption:{},getSettings:()=>settings,saveSettings:async patch=>{settings={...settings,...patch};},chat:async()=>({text:''}),usageText:()=>'',providerFor:()=>null,tasks});
  tasks.listChats=()=>[...chats.values()];tasks.desktopInbox.listChats=tasks.listChats;
  hub.bridges.set('discord',{send:async(chatKey,text)=>sent.push({chatKey,text}),typing(){},stop(){}});hub.generations.set('discord',1);
  Object.assign(tasks.desktopInbox,{now:()=>clock,setTimer:(fn,delay)=>{const timer={id:++sequence,at:clock+delay,fn,unref(){}};timers.set(timer.id,timer);return timer;},clearTimer:timer=>timers.delete(timer.id)});
  const chat={id:'desktop',title:'Build a useful app',messages:[]};chats.set(chat.id,chat);runs.set(chat.id,{});
  const approval=(extra={})=>{const value={id:'a1',conversationId:chat.id,title:'Run exact command?',tool:'workspace_shell',kind:'execute',target:'Write-Output ok',detail:'Exact folder and operation',expiresAt:new Date(clock+300_000).toISOString(),...extra};approvals.set(value.id,value);tasks.event({type:'approval',...value});return value;};
  const question=(extra={})=>{const value={id:'q1',status:'waiting',questions:[{id:'format',question:'Which format?',options:[{label:'CSV'},{label:'JSON'}]}],...extra};chat.messages.push({questions:[value]});tasks.event({type:'chat.question',conversationId:chat.id,question:value});return value;};
  const identity=()=>hub.taskIdentity({type:'discord',userId:'owner',chatKey:'dm'});
  const command=body=>tasks.command(identity(),body);
  const advance=async milliseconds=>{clock+=milliseconds;for(const timer of [...timers.values()])if(timer.at<=clock){timers.delete(timer.id);await timer.fn();}};
  return {hub,tasks,chats,chat,approvals,runs,sent,responses,answers,timers,approval,question,advance,command,identity,settings:()=>settings};
}

test('desktop forwarding defaults off and delays new unanswered requests for a full minute',async()=>{
  const f=fixture();f.approval();f.question();assert.equal(f.timers.size,0);assert.equal(f.sent.length,0);
  await f.hub.setDesktopInbox('owner');f.approval();f.question();await f.advance(59_999);assert.equal(f.sent.length,0);
  await f.advance(1);assert.ok(f.sent.some(item=>item.text.includes('/desktop approve a1')));assert.ok(f.sent.some(item=>item.text.includes('/desktop answer q1')));assert.ok(f.sent.every(item=>item.chatKey==='dm'));
});

test('questions and approvals resolved on desktop are never forwarded',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();const q=f.question();f.approvals.delete('a1');q.status='answered';
  f.tasks.event({type:'approval.resolved',id:'a1'});f.tasks.event({type:'chat.question',conversationId:'desktop',question:q});await f.advance(60_000);assert.equal(f.sent.length,0);assert.equal(f.timers.size,0);
});

test('private, archived and channel chats cannot enter the desktop inbox, including after scheduling',async()=>{
  for(const change of [chat=>chat.private=true,chat=>chat.archived=true,chat=>chat.channel={type:'discord',userId:'owner',chatKey:'dm'}]){
    const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();f.question();change(f.chat);await f.advance(60_000);assert.equal(f.sent.length,0);
  }
});

test('desktop approval requires full delivery, current operation, live task and the selected account',async()=>{
  for(const condition of ['changed','expired','stopped','other','undelivered']){
    const f=fixture();await f.hub.setDesktopInbox('owner');const a=f.approval();await f.advance(60_000);
    if(condition==='changed')a.target='Different command';if(condition==='expired')a.expiresAt=new Date(0).toISOString();if(condition==='stopped')f.runs.delete('desktop');if(condition==='undelivered')f.tasks.desktopInbox.tickets.get('approval:a1').delivered=false;
    const identity=condition==='other'?f.hub.taskIdentity({type:'discord',userId:'other',chatKey:'other-dm'}):f.identity();
    await assert.rejects(f.tasks.command(identity,'/desktop approve a1'));assert.equal(f.responses.length,0,condition);
  }
});

test('one explicit desktop approval is consumed once and permissions are rechecked by the host',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();await f.advance(60_000);
  assert.equal(await f.command('/desktop approve a1'),'Approved once for the desktop task.');await assert.rejects(f.command('/desktop approve a1'));assert.equal(f.responses.length,1);assert.equal(f.responses[0].decision,'once');
  f.approval({id:'a2'});await f.advance(60_000);f.tasks.desktopInbox.respondApproval=async()=>({approved:false,message:'New deny rule'});assert.equal(await f.command('/desktop approve a2'),'Blocked: New deny rule');
});

test('security previews omit sensitive details and stay desktop-only',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval({tool:'provider.connect',title:'Connect account',detail:'NEVER_FORWARD'});await f.advance(60_000);
  assert.ok(!f.sent.some(item=>item.text.includes('NEVER_FORWARD')));assert.ok(!f.sent.some(item=>item.text.includes('/desktop approve')));await assert.rejects(f.command('/desktop approve a1'),/computer/);
  await f.command('/desktop deny a1');assert.equal(f.responses[0].decision,'deny');
});

test('a delivered question accepts an explicit option and changed questions require a fresh preview',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');const q=f.question();await f.advance(60_000);q.questions[0].question='Changed question';await assert.rejects(f.command('/desktop answer q1 2'),/changed/);assert.equal(f.answers.length,0);
  await f.command('/desktop');await f.command('/desktop answer q1 2');assert.deepEqual(f.answers[0],{conversationId:'desktop',id:'q1',answers:{format:'JSON'}});await assert.rejects(f.command('/desktop answer q1 2'));
});

test('unpairing, changing recipient, disconnecting and disabling execution revoke pending and delivered requests',async()=>{
  for(const action of ['unpair','recipient','disconnect','disable','off']){
    const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();f.question();await f.advance(60_000);
    if(action==='unpair')await f.hub.unpair('discord','owner');if(action==='recipient')await f.hub.setDesktopInbox('other');if(action==='disconnect')f.hub.stop('discord');if(action==='disable')await f.hub.setTaskExecution(false);if(action==='off')await f.hub.setDesktopInbox('');
    await assert.rejects(f.command('/desktop approve a1'));assert.equal(f.responses.length,0,action);
  }
});

test('resolution during multipart delivery stops later chunks and never creates an actionable ticket',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval({detail:'Long exact operation '.repeat(200)});let count=0;
  f.hub.bridges.get('discord').send=async(chatKey,text)=>{f.sent.push({chatKey,text});if(++count===1){f.approvals.delete('a1');f.tasks.event({type:'approval.resolved',id:'a1'});}};
  await f.advance(60_000);assert.equal(count,1);assert.equal(f.tasks.desktopInbox.tickets.size,0);
});

test('uncertain delivery is not retried automatically and explicit resend cancels the old timer',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();await f.command('/desktop');assert.equal(f.timers.size,0);const count=f.sent.length;await f.advance(60_000);assert.equal(f.sent.length,count);
  f.approval({id:'a2'});f.hub.bridges.get('discord').send=async()=>{throw Error('Network timeout after dispatch');};await f.advance(60_000);assert.equal(f.tasks.desktopInbox.tickets.has('approval:a2'),false);await f.advance(120_000);assert.equal(f.tasks.desktopInbox.tickets.has('approval:a2'),false);
});

test('explicit refresh discovers waiting requests after enabling and after a reconnect',async()=>{
  const f=fixture();f.approval();f.question();await f.hub.setDesktopInbox('owner');assert.equal(f.timers.size,2);await f.advance(60_000);assert.equal(f.tasks.desktopInbox.tickets.size,2);
  f.hub.stop('discord');f.hub.bridges.set('discord',{send:async(chatKey,text)=>f.sent.push({chatKey,text})});await f.command('/desktop');assert.equal(f.tasks.desktopInbox.tickets.size,2);
});

test('ambiguous Unicode, secret-like data and large previews stay desktop-only',async()=>{
  for(const detail of ['echo \u202Ehidden','echo \u200Bhidden','token=sk-12345678901234567890','x'.repeat(6500)]){
    const f=fixture();await f.hub.setDesktopInbox('owner');f.approval({detail});await f.advance(60_000);assert.equal(f.sent.length,2);assert.ok(!f.sent.some(item=>item.text.includes(detail)));assert.ok(!f.sent.some(item=>item.text.includes('/desktop approve')));await assert.rejects(f.command('/desktop approve a1'),/computer/);
  }
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval({detail:'echo <t:0:R> @everyone'});await f.advance(60_000);assert.ok(f.sent.some(item=>item.text.includes('```text\n')&&item.text.includes('<t:0:R>')));
});

test('failed identical resend retains the delivered ticket and disabling cannot re-arm it',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.approval();await f.advance(60_000);f.hub.bridges.get('discord').send=async()=>{throw Error('Uncertain delivery');};await f.command('/desktop');assert.equal(f.tasks.desktopInbox.tickets.get('approval:a1')?.delivered,true);
  await f.hub.setTaskExecution(false);await f.hub.setTaskExecution(true);assert.equal(f.settings().messaging.discord.desktopInboxUserId,'');await assert.rejects(f.command('/desktop approve a1'));
});

test('grouped answers validate shapes and map per-question options',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.question({questions:[{id:'format',question:'Format?',options:[{label:'CSV'},{label:'JSON'}]},{id:'scope',question:'Scope?'}]});await f.advance(60_000);
  for(const value of ['null','{"format":null,"scope":"x"}','{"format":"CSV"}','{"extra":"x","scope":"x"}'])await assert.rejects(f.command('/desktop answer q1 '+value));assert.equal(f.answers.length,0);
  await f.command('/desktop answer q1 format=2; scope=Only src');assert.deepEqual(f.answers[0].answers,{format:'JSON',scope:'Only src'});
});

test('question response is rejected after recipient revocation and sensitive question text is withheld',async()=>{
  const f=fixture();await f.hub.setDesktopInbox('owner');f.question();await f.advance(60_000);await f.hub.setDesktopInbox('');await assert.rejects(f.command('/desktop answer q1 CSV'));assert.equal(f.answers.length,0);
  await f.hub.setDesktopInbox('owner');f.question({id:'q2',questions:[{id:'key',question:'Use token=sk-12345678901234567890?'}]});await f.advance(60_000);assert.ok(!f.sent.some(item=>item.text.includes('sk-12345678901234567890')));await assert.rejects(f.command('/desktop answer q2 yes'),/computer/);
});
