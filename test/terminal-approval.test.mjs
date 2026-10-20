import test from 'node:test';
import assert from 'node:assert/strict';
import {approveTerminalCommand} from '../desktop/terminal-approval.mjs';
const base = () => ({conversationId:'chat', request:{conversationId:'chat',detail:'preview',input:{command:'Get-Date'}}, getContext:async()=>({workspace:'C:/work'}), evaluate:()=>({decision:'ask'}), ask:async()=>true});

test('manual terminal obeys a deny without creating an approval and uses exact chat command policy', async()=>{
  const input=base();input.evaluate=(action,id)=>{assert.equal(id,'chat');assert.deepEqual(action,{kind:'execute',tool:'workspace_shell',target:'Get-Date'});return {decision:'deny',reason:'Read-only access blocks commands.'};};input.ask=()=>{throw Error('Must not ask around a denial');};
  await assert.rejects(approveTerminalCommand(input), error=>error.code==='TERMINAL_DENIED'&&error.message==='Read-only access blocks commands.');
});
test('manual terminal keeps user confirmation outside the agent activity and cannot turn it into a permanent grant', async()=>{
  const input=base();input.ask=async request=>{assert.equal(request.conversationId,undefined);assert.equal(request.requireConfirmation,true);assert.equal(request.allowSession,undefined);assert.equal(request.input.command,'Get-Date');return true;};
  assert.equal(await approveTerminalCommand(input),true);
});
test('manual terminal rechecks changed policy, workspace and cancelled confirmation', async()=>{
  let mode='ask';const denied=base();denied.evaluate=()=>({decision:mode,reason:'New deny rule'});denied.ask=async()=>{mode='deny';return true;};await assert.rejects(approveTerminalCommand(denied),/New deny rule/);
  let workspace='C:/before';const moved=base();moved.getContext=async()=>({workspace});moved.ask=async()=>{workspace='C:/after';return true;};await assert.rejects(approveTerminalCommand(moved),/workspace changed/);
  const controller=new AbortController(),cancelled=base();cancelled.signal=controller.signal;cancelled.ask=async()=>{controller.abort();return true;};assert.equal(await approveTerminalCommand(cancelled),false);
});
test('manual terminal honors existing allow rules but refuses lost chat context after confirmation', async()=>{
  const allowed=base();allowed.evaluate=()=>({decision:'allow'});allowed.ask=()=>{throw Error('Existing grant should not ask');};assert.equal(await approveTerminalCommand(allowed),true);
  let exists=true;const gone=base();gone.getContext=async()=>{if(!exists)throw Error('Chat removed');return {workspace:'C:/work'};};gone.ask=async()=>{exists=false;return true;};await assert.rejects(approveTerminalCommand(gone),/Chat removed/);
});
