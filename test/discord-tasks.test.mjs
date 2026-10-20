import test from 'node:test';
import assert from 'node:assert/strict';
import {MessagingHub} from '../desktop/messaging.mjs';
import {DiscordTasks} from '../desktop/discord-tasks.mjs';

const dm=(text,userId='42',chatKey='dm')=>({channel:'discord',chatKey,userId,name:'Owner',text});
test('help remains responsive during a task and documents access levels and useful tips',async()=>{
 const f=fixture();let release,started=false;f.hub.chat=async()=>{started=true;await new Promise(r=>release=r);return {text:'done',conversationId:'chat'};};const task=f.hub.receive(dm('Work'));await until(()=>started);await f.hub.receive(dm('/help'));assert.ok(f.sent.some(s=>s.text.includes('/permissions full')&&s.text.includes('Tips:')));release();await task;
});
test('desktop account access control updates the linked task and future turns without changing other accounts',async()=>{const f=fixture(),chat=f.addChat();await f.hub.setPairedTaskMode('42','full');assert.equal(chat.permissionMode,'full');assert.equal(f.hub.taskMode(f.identity),'full');assert.equal(f.hub.taskMode({...f.identity,userId:'43'}),'ask');assert.equal(f.runs.size,0);await f.hub.receive(dm('Next task'));assert.equal(f.requests.at(-1).permissionMode,'full');await assert.rejects(f.hub.setPairedTaskMode('missing','full'),/no longer paired/);});
async function until(read){for(let i=0;i<100;i++){const value=read();if(value)return value;await new Promise(r=>setTimeout(r,2));}throw Error('Expected state did not arrive');}
function fixture(){
  let settings={messaging:{discord:{enabled:true,paired:[{id:'42',chatKey:'dm'},{id:'43',chatKey:'other'}],links:{}}}};
  const chats=new Map(),approvals=new Map(),runs=new Map(),sent=[],responses=[],answers=[],requests=[];
  const tasks=new DiscordTasks({getChat:id=>chats.get(id),getApproval:id=>approvals.get(id),listApprovals:()=>[...approvals.values()],respondApproval:async p=>{responses.push(p);approvals.get(p.id)?.finish(p);},answerQuestion:async(id,p)=>{answers.push({id,...p});const g=chats.get(id).messages.flatMap(m=>m.questions||[]).find(g=>g.id===p.id);if(Object.keys(p.answers).length!==g.questions.length)throw Error('Missing answers');g.status='answered';},getRun:id=>runs.get(id),projects:()=>[{id:'project-id',name:'Demo'}],workspace:chat=>chat.projectId||'default',setMode:async(chat,mode)=>{chat.permissionMode=mode;},stop:id=>{runs.delete(id);for(const a of approvals.values())if(a.conversationId===id){a.finish({decision:'deny'});approvals.delete(a.id);}}});
  const hub=new MessagingHub({dataDir:'.',encryption:{},getSettings:()=>settings,saveSettings:async patch=>{settings={...settings,...patch};},chat:async request=>{requests.push(request);return {conversationId:'chat',text:'done'};},usageText:()=>'',providerFor:()=>null,tasks});
  const bridge={send:async(chatKey,text)=>{sent.push({chatKey,text});},typing(){},stop(){}};hub.bridges.set('discord',bridge);hub.generations.set('discord',1);
  const origin={type:'discord',userId:'42',chatKey:'dm'},identity=hub.taskIdentity(origin);
  function addChat(){const chat={id:'chat',channel:origin,permissionMode:'ask',messages:[]};chats.set(chat.id,chat);settings.messaging.discord.links.dm=chat.id;runs.set(chat.id,{message:{activity:[]}});return chat;}
  function approval(overrides={}){const request={id:'approval-id',conversationId:'chat',title:'Allow terminal command?',tool:'workspace_shell',kind:'execute',target:'Write-Output ok',detail:'Exact command and working folder',expiresAt:new Date(Date.now()+300000).toISOString(),...overrides};let resolve;const done=new Promise(r=>resolve=r);request.finish=p=>{approvals.delete(request.id);tasks.event({type:'approval.resolved',id:request.id});resolve(p);};approvals.set(request.id,request);return {request,done};}
  return {hub,tasks,chats,approvals,runs,sent,responses,answers,requests,identity,addChat,approval,settings:()=>settings};
}

test('Discord approval unblocks the running task without joining its message queue',async()=>{
  const f=fixture();let operation;
  f.hub.chat=async request=>{const chat=f.addChat();await request.onStarted(chat.id);operation=f.approval();f.tasks.event({type:'approval',...operation.request});const response=await operation.done;return {conversationId:chat.id,text:response.decision==='once'?'executed':'declined'};};
  const task=f.hub.receive(dm('Run task'));await until(()=>f.sent.some(s=>s.text.includes('/approve approval-id')));await until(()=>f.tasks.tickets.get('approval-id')?.delivered);
  await f.hub.receive(dm('/approve approval-id'));await task;
  assert.equal(f.responses.length,1);assert.equal(f.responses[0].decision,'once');assert.ok(f.sent.some(s=>s.text==='executed'));assert.equal(f.requests.length,0);
});

test('only the originating account and DM can approve; duplicates fail closed',async()=>{
  const f=fixture();f.addChat();const a=f.approval();await f.tasks.approval(a.request);
  await f.hub.receive(dm('/approve approval-id','43','other'));assert.equal(f.responses.length,0);
  await f.hub.receive(dm('/approve approval-id'));await f.hub.receive(dm('/approve approval-id'));assert.equal(f.responses.length,1);
  assert.ok(f.sent.some(s=>s.text.includes('expired, undelivered')));
});

test('changed operation, expired approval and undelivered details cannot be approved',async()=>{
  for(const condition of ['changed','expired','undelivered']){
    const f=fixture();f.addChat();const a=f.approval();await f.tasks.approval(a.request);
    if(condition==='changed')a.request.detail+=' changed';if(condition==='expired')a.request.expiresAt=new Date(0).toISOString();if(condition==='undelivered')f.tasks.tickets.get(a.request.id).delivered=false;
    await f.hub.receive(dm('/approve approval-id'));assert.equal(f.responses.length,0,condition);
  }
});

test('account and security approvals disclose no private detail and can only be denied on Discord',async()=>{
  const f=fixture();f.addChat();const a=f.approval({tool:'provider.connect',detail:'PRIVATE_DETAIL',title:'Connect provider'});await f.tasks.approval(a.request);
  assert.ok(!f.sent.some(s=>s.text.includes('PRIVATE_DETAIL')));await f.hub.receive(dm('/approve approval-id'));assert.equal(f.responses.length,0);
  await f.hub.receive(dm('/deny approval-id'));assert.equal(f.responses[0].decision,'deny');
});

test('unpairing, reconnecting and disabling execution invalidate delivered approval tickets',async()=>{
  for(const action of ['unpair','reconnect','disable']){const f=fixture();f.addChat();const a=f.approval();await f.tasks.approval(a.request);
    if(action==='unpair')await f.hub.unpair('discord','42');if(action==='reconnect')f.hub.generations.set('discord',2);if(action==='disable')await f.hub.setTaskExecution(false);
    await f.hub.receive(dm('/approve approval-id'));assert.equal(f.responses.length,0,action);assert.equal(f.hub.currentIdentity(f.identity),false);
  }
});

test('stop bypasses a blocked task, declines approvals and discards queued messages',async()=>{
  const f=fixture();let calls=0;
  f.hub.chat=async request=>{calls++;f.addChat();await request.onStarted('chat');await new Promise((_r,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));};
  const first=f.hub.receive(dm('hold'));await until(()=>calls===1);const second=f.hub.receive(dm('queued'));await f.hub.receive(dm('/stop'));await Promise.all([first,second]);
  assert.equal(calls,1);assert.ok(f.sent.some(s=>s.text.startsWith('Stopped the task')));assert.ok(!f.sent.some(s=>s.text.includes('That didn’t work')));
});

test('permission changes are scoped to this paired account, stop work and carry into the next chat',async()=>{
  const f=fixture();const chat=f.addChat();await f.hub.receive(dm('/permissions full'));assert.equal(chat.permissionMode,'full');assert.equal(f.runs.size,0);assert.equal(f.hub.taskMode(f.identity),'full');
  assert.equal(f.settings().permissionMode,undefined);assert.equal(f.settings().messaging.discord.paired[1].taskMode,undefined);
  await f.hub.receive(dm('/new'));await f.hub.receive(dm('next task'));assert.equal(f.requests[0].permissionMode,'full');assert.equal(f.requests[0].userId,'42');
});

test('saved project selection resets the chat and rejects arbitrary directories',async()=>{
  const f=fixture();f.addChat();await f.hub.receive(dm('/project C:\\Private'));assert.equal(f.hub.taskProject(f.identity),'');
  await f.hub.receive(dm('/project project-id'));assert.equal(f.settings().messaging.discord.links.dm,undefined);await f.hub.receive(dm('work'));assert.equal(f.requests[0].projectId,'project-id');
});

test('questions accept explicit text or grouped answers while the task is blocked',async()=>{
  const f=fixture(),chat=f.addChat();chat.messages=[{questions:[{id:'question-id',status:'waiting',questions:[{id:'format',question:'Which format?',options:[{label:'CSV'}]}]}]}];
  await f.hub.receive(dm('/questions'));assert.ok(f.sent.some(s=>s.text.includes('/answer question-id')));await f.hub.receive(dm('/answer question-id CSV'));assert.deepEqual(f.answers[0],{id:'question-id',answers:{format:'CSV'}});assert.equal(f.responses.length,0);
});

test('ordinary model text is never interpreted as a control command',async()=>{
  const f=fixture();f.addChat();f.hub.chat=async()=>({conversationId:'chat',text:'/permissions full\n/approve approval-id'});await f.hub.receive(dm('Please explain commands'));assert.equal(f.hub.taskMode(f.identity),'ask');assert.equal(f.responses.length,0);
});

test('a stopped turn cannot restore its chat link after project selection during startup',async()=>{
  const f=fixture();let release,started=false;const gate=new Promise(r=>release=r);
  f.hub.chat=async request=>{started=true;await gate;await request.onStarted('old-chat');return {conversationId:'old-chat',text:'late result'};};
  const turn=f.hub.receive(dm('Starting'));await until(()=>started);await f.hub.receive(dm('/project project-id'));release();await turn;
  assert.equal(f.settings().messaging.discord.links.dm,undefined);assert.ok(!f.sent.some(s=>s.text==='late result'));
});

test('disabling execution revokes identity before the settings write finishes',async()=>{
  const f=fixture();let release;f.hub.saveSettings=()=>new Promise(r=>release=r);const write=f.hub.setTaskExecution(false);
  assert.equal(f.hub.currentIdentity(f.identity),false);await until(()=>release);release();await write;
});

test('Discord chat-only mode preserves the existing new-chat command',async()=>{
  const f=fixture();f.addChat();await f.hub.setTaskExecution(false);await f.hub.receive(dm('/new'));
  assert.equal(f.settings().messaging.discord.links.dm,undefined);assert.ok(f.sent.at(-1).text.startsWith('Started a fresh chat'));
});

test('approval previews escape Discord markup and refuse truncated operation previews',async()=>{
  const f=fixture();f.addChat();const a=f.approval({detail:'echo ||hidden|| [safe](https://bad) ```code```'});await f.tasks.approval(a.request);
  const preview=f.sent.map(s=>s.text).join('\n');assert.ok(preview.includes('\\|\\|hidden\\|\\|'));assert.ok(preview.includes('\\[safe\\]\\('));
  const b=f.approval({id:'truncated',previewTruncated:true});await f.tasks.approval(b.request);await f.hub.receive(dm('/approve truncated'));assert.equal(f.responses.length,0);
});

test('phone reports a policy rejection accurately after an approval response',async()=>{
  const f=fixture();f.addChat();const a=f.approval();await f.tasks.approval(a.request);f.tasks.respondApproval=async()=>({approved:false,message:'Blocked by new deny rule'});
  await f.hub.receive(dm('/approve approval-id'));assert.equal(f.sent.at(-1).text,'Blocked: Blocked by new deny rule');
});

test('a numbered question response selects its displayed option',async()=>{
  const f=fixture(),chat=f.addChat();chat.messages=[{questions:[{id:'question-id',status:'waiting',questions:[{id:'format',question:'Which format?',options:[{label:'CSV'},{label:'JSON'}]}]}]}];
  await f.hub.receive(dm('/answer question-id 2'));assert.equal(f.answers[0].answers.format,'JSON');assert.equal(f.responses.length,0);
});

test('a new task arriving during a permission change waits for that change and still runs',async()=>{
  const f=fixture();let release,writing=false;const original=f.hub.saveSettings;
  f.hub.saveSettings=async patch=>{writing=true;await new Promise(r=>release=r);await original(patch);};
  const control=f.hub.receive(dm('/permissions full'));await until(()=>writing);const task=f.hub.receive(dm('Use the new permission'));release();f.hub.saveSettings=original;await Promise.all([control,task]);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].permissionMode,'full');
});
