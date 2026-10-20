import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalPtySessions,terminalEnvironment} from '../desktop/terminal-pty.mjs';
import {approveTerminalSession,interactiveTerminalRestriction} from '../desktop/terminal-approval.mjs';
import {ProviderTerminals} from '../desktop/provider-terminals.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){let workspace='C:/synthetic',denied=false;const writes=[],sizes=[],events=[],startFolders=[];let data,exit,spawns=0,kills=0;const fake={pid:999,onData:callback=>{data=callback;return {dispose(){}};},onExit:callback=>{exit=callback;return {dispose(){}};},write:text=>writes.push(text),resize:(cols,rows)=>sizes.push({cols,rows}),kill:()=>{kills++;exit?.({exitCode:0});}};const terminal=new TerminalPtySessions({getContext:async id=>{if(id==='private')throw Error('Private chat');return {workspace};},getHomeDirectory:async()=> 'C:/Users/synthetic',approve:async()=>!denied,check:()=>{if(denied)throw Error('Permission revoked');},load:async()=>({spawn:(_shell,_args,options)=>{spawns++;startFolders.push(options.cwd);return fake;}}),killTree:async pty=>pty.kill(),emit:event=>events.push(event)});return {terminal,writes,sizes,events,startFolders,data:text=>data(text),setWorkspace:value=>workspace=value,deny:()=>denied=true,get spawns(){return spawns;},get kills(){return kills;}};}
async function open(f,owner='agent'){const session=await f.terminal.open({conversationId:'chat'},{owner});await f.terminal.sessions.get(session.id).ready;return session.id;}

test('update closure waits for exact owned PTYs to exit and leaves new sessions alone',async()=>{
  const f=fixture();try{
    const approved=await open(f,'user');const ids=f.terminal.openIds();assert.deepEqual(ids,[approved]);
    await f.terminal.stopForUpdate(ids,{timeoutMs:500});assert.equal(f.terminal.busy,false);assert.equal(f.kills,1);
    const later=await open(f,'user');await f.terminal.stopForUpdate(ids,{timeoutMs:500});assert.deepEqual(f.terminal.openIds(),[later]);assert.equal(f.kills,1);
  }finally{f.terminal.close();}
});

test('an unconfirmed PTY exit or failed kill prevents update handoff',async()=>{
  for(const failed of [false,true]){const f=fixture();try{
    const id=await open(f,'user');f.terminal.killTree=async()=>{if(failed)throw Error('kill failed');};
    await assert.rejects(f.terminal.stopForUpdate([id],{timeoutMs:20}),failed?/could not close/:/still closing/);
    assert.ok(f.terminal.sessions.get(id).pty);assert.equal(f.terminal.busy,true);assert.deepEqual(f.terminal.openIds(),[id]);
  }finally{f.terminal.close();}}
});

test('personal shells start in user home, explicit workspace and agent shells start in task folder',async()=>{
  const f=fixture();try{
    const personal=await open(f,'user');
    const project=await f.terminal.open({conversationId:'chat',startIn:'workspace'});await f.terminal.sessions.get(project.id).ready;
    const agentSession=await f.terminal.open({conversationId:'chat',startIn:'home'},{owner:'agent'});await f.terminal.sessions.get(agentSession.id).ready;const agent=agentSession.id;
    assert.deepEqual(f.startFolders,['C:/Users/synthetic','C:/synthetic','C:/synthetic']);
    const sessions=await f.terminal.list('chat');
    assert.equal(sessions.find(item=>item.id===personal).startDirectory,'C:/Users/synthetic');
    assert.equal(sessions.find(item=>item.id===personal).workspace,'C:/synthetic');
    assert.equal(sessions.find(item=>item.id===agent).startDirectory,'C:/synthetic');
    await f.terminal.input({conversationId:'chat',id:personal,text:'existing-session\r'});
    assert.deepEqual(f.writes,['existing-session\r']);assert.equal(f.spawns,3);
  }finally{f.terminal.close();}
});

test('terminal start folders are restricted choices and validate the resolved user home',async()=>{
  const f=fixture();try{
    await assert.rejects(f.terminal.open({conversationId:'chat',startIn:'C:/arbitrary'}),/user folder or the current workspace/);
    f.terminal.validateWorkspace=async directory=>{if(directory==='C:/Users/synthetic')throw Error('Protected start folder');};
    await assert.rejects(f.terminal.open({conversationId:'chat'}),/Protected start folder/);assert.equal(f.spawns,0);
    const id=await open(f);assert.equal((await f.terminal.list('chat')).find(item=>item.id===id).startDirectory,'C:/synthetic');
  }finally{f.terminal.close();}
});

test('session approval displays its actual start folder while binding permission to the chat workspace',async()=>{
  let asks=0;const value=await approveTerminalSession({conversationId:'chat',workspace:'C:/project',startDirectory:'C:/Users/synthetic',owner:'user',getContext:async()=>({workspace:'C:/project'}),evaluate:()=>({decision:'allow'}),ask:async request=>{asks++;assert.match(request.detail,/Starting folder: C:\/Users\/synthetic/);return true;}});
  assert.equal(asks,1);assert.equal(value.approved,true);
});

test('interactive PTY ownership, output cursor and input/resize controls are exact per chat and owner',async()=>{
  const f=fixture(),id=await open(f);f.data('hello\x1b[31m red');assert.equal((await f.terminal.read({conversationId:'chat',id})).text,'hello\x1b[31m red');
  await f.terminal.input({conversationId:'chat',id,text:'echo hi\r'});await f.terminal.resize({conversationId:'chat',id,cols:80,rows:24});assert.deepEqual(f.writes,['echo hi\r']);assert.deepEqual(f.sizes,[{cols:80,rows:24}]);
  await assert.rejects(f.terminal.read({conversationId:'other',id}),/owned/);await assert.rejects(f.terminal.input({conversationId:'other',id,text:'bad'}),/owned/);
  const user=await open(f,'user');await assert.rejects(f.terminal.call('terminal_read',{id:user},'chat'),/owned/);await assert.rejects(f.terminal.call('terminal_input',{id:user,text:'bad'},'chat'),/owned/);
  assert.doesNotMatch(JSON.stringify(f.events),/echo hi|hello|synthetic/);f.terminal.close();
});

test('raw input stays ordered through asynchronous context validation and is bounded',async()=>{
  const f=fixture(),id=await open(f);await Promise.all(['a','b','c','\r'].map(text=>f.terminal.input({conversationId:'chat',id,text})));assert.equal(f.writes.join(''),'abc\r');
  await assert.rejects(f.terminal.input({conversationId:'chat',id,text:'a'.repeat(65537)}),/65,536/);await assert.rejects(f.terminal.resize({conversationId:'chat',id,cols:2,rows:24}),/dimensions/);f.terminal.close();
});

test('output ring reports truncation and advances UTF-16 cursors without emitting content',async()=>{
  const f=fixture(),id=await open(f);f.data('x'.repeat(600000));const part=await f.terminal.read({conversationId:'chat',id,limit:10});assert.equal(part.truncated,true);assert.equal(part.text.length,10);assert.equal(part.cursor,600000-512*1024);assert.equal(part.nextCursor,part.cursor+10);assert.equal(part.hasMore,true);f.terminal.close();
});

test('workspace and policy revocation stop the owned PTY and block further input',async()=>{
  for(const revoke of [f=>f.setWorkspace('C:/changed'),f=>f.deny()]){const f=fixture(),id=await open(f);revoke(f);await f.terminal.revalidate('chat');await tick();assert.equal(f.kills,1);await assert.rejects(f.terminal.input({conversationId:'chat',id,text:'bad'}));assert.equal((await f.terminal.list('chat'))[0].status,'stopped');f.terminal.close();}
});

test('cancelled session approval and shutdown never spawn a late PTY',async()=>{
  const f=fixture();let release;f.terminal.approve=()=>new Promise(resolve=>release=resolve);const opened=await f.terminal.open({conversationId:'chat'});await tick();await f.terminal.stop({conversationId:'chat',id:opened.id});release(true);await f.terminal.sessions.get(opened.id).ready;assert.equal(f.spawns,0);f.terminal.close();
});

test('interactive approval always asks for a full-shell grant, even when a command allow rule exists',async()=>{
  let asks=0;const approved=await approveTerminalSession({conversationId:'chat',workspace:'C:/synthetic',owner:'agent',getContext:async()=>({workspace:'C:/synthetic'}),evaluate:()=>({decision:'allow'}),ask:async request=>{asks++;assert.equal(request.requireConfirmation,true);assert.equal(request.conversationId,'chat');assert.match(request.detail,/all input|full shell|individual commands/i);return true;}});assert.deepEqual(approved,{approved:true,source:'explicitSession'});assert.equal(asks,1);
  assert.match(interactiveTerminalRestriction({mode:'read-only'}),/Read only/);
  for(const tool of ['workspace_shell','claude.Bash','claude.PowerShell','*.Bash','*.execute','gemini.execute','codex.command','exec_command'])assert.match(interactiveTerminalRestriction({rules:[{effect:'deny',tool,match:'Remove-Item'}]}),/deny rules/,tool);
  assert.equal(interactiveTerminalRestriction({rules:[{effect:'allow',tool:'workspace_shell',match:'Get-ChildItem'}]}),null);
});

test('Full access reuses existing authority while Ask cannot inherit it from an allow prefix',async()=>{
  const base={conversationId:'chat',workspace:'C:/synthetic',owner:'user',getContext:async()=>({workspace:'C:/synthetic'}),evaluate:()=>({decision:'allow'})};
  assert.deepEqual(await approveTerminalSession({...base,getMode:()=> 'full',ask:()=>{throw Error('Full access should not ask again');}}),{approved:true,source:'implicitFull'});
  let asks=0;assert.deepEqual(await approveTerminalSession({...base,getMode:()=> 'ask',ask:async()=>{asks++;return true;}}),{approved:true,source:'explicitSession'});assert.equal(asks,1);
});

test('a Full-to-Ask downgrade during native module load prevents a late process spawn',async()=>{
  const f=fixture();let mode='full',release,importing=false;const original=f.terminal.load;f.terminal.approve=async()=>({approved:true,source:'implicitFull'});f.terminal.getContext=async()=>({workspace:'C:/synthetic',permissionMode:mode});f.terminal.load=async()=>{importing=true;await new Promise(resolve=>release=resolve);return original();};
  const opened=await f.terminal.open({conversationId:'chat'});for(let i=0;i<10&&!importing;i++)await tick();assert.equal(importing,true);mode='ask';release();await f.terminal.sessions.get(opened.id).ready;assert.equal(f.spawns,0);assert.equal((await f.terminal.list('chat'))[0].status,'error');f.terminal.close();
});

test('actual implicit Full grant origin survives an initial Ask context then revokes on downgrade',async()=>{
  const f=fixture();let mode='ask';f.terminal.getContext=async()=>({workspace:'C:/synthetic',permissionMode:mode});f.terminal.approve=async()=>{mode='full';return {approved:true,source:'implicitFull'};};const opened=await f.terminal.open({conversationId:'chat'});await f.terminal.sessions.get(opened.id).ready;assert.equal((await f.terminal.list('chat'))[0].authorization,'implicitFull');mode='ask';await f.terminal.revalidate('chat');await tick();assert.equal(f.kills,1);f.terminal.close();
});

test('PTY environment inherits only the platform allowlist and never shell hooks or credential variables',()=>{
  const env=terminalEnvironment({PATH:'bin',SystemRoot:'C:/Windows',TOKEN:'private',CUSTOM_CREDENTIAL:'private',SHELL_STARTUP:'private',BASH_ENV:'private',ENV:'private',NODE_OPTIONS:'private',ELECTRON_RUN_AS_NODE:'1',EXOMINA_TOOL_TOKEN:'private'});assert.deepEqual(env,{PATH:'bin',SystemRoot:'C:/Windows',TERM:'xterm-256color',COLORTERM:'truecolor'});
});

test('native terminal inventory/stop only uses the current owned Codex thread and refuses stale/foreign handles',async()=>{
  let state={provider:'codex',sessionId:'owned-thread'},live=true;const requests=[];const rpc={request:async(method,args)=>{requests.push({method,args});return method.endsWith('/list')?{data:live?[{processId:'owned-process',command:'synthetic',cwd:'C:/synthetic',itemId:'item'}]:[]}:{};}};
  const terminal=new ProviderTerminals({getContext:async()=>({}),getState:id=>id==='chat'?state:null,getRpc:()=>rpc});const list=await terminal.list('chat');assert.equal(list.entries[0].inputAvailable,false);assert.equal(list.entries[0].canStop,true);const id=list.entries[0].id;
  await assert.rejects(terminal.stop({conversationId:'other',id}),/owned/);await terminal.stop({conversationId:'chat',id});assert.deepEqual(requests.at(-1),{method:'thread/backgroundTerminals/terminate',args:{threadId:'owned-thread',processId:'owned-process'}});
  const fresh=(await terminal.list('chat')).entries[0].id;state={provider:'codex',sessionId:'replacement'};await assert.rejects(terminal.stop({conversationId:'chat',id:fresh}),/owned/);state=null;assert.equal((await terminal.list('chat')).available,false);
});

test('native terminal handles cannot survive a mutable state adopting another thread',async()=>{
  const state={provider:'codex',sessionId:'original'},rpc={request:async()=>({data:[{processId:'reused-process',command:'synthetic',cwd:'C:/synthetic',itemId:'item'}]})},terminal=new ProviderTerminals({getContext:async()=>({}),getState:()=>state,getRpc:()=>rpc});
  const before=(await terminal.list('chat')).entries[0].id;state.sessionId='replacement';const after=(await terminal.list('chat')).entries[0].id;assert.notEqual(before,after);await assert.rejects(terminal.stop({conversationId:'chat',id:before}),/owned/);
});
