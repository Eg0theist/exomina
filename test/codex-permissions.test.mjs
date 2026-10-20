import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {codexPermissions, permissionDifferences, nativeRecoveryContext} from '../desktop/codex-permissions.mjs';
import {codexPolicy} from '../desktop/permissions.mjs';

test('effective sandbox validation checks network, extra roots and temp exclusions, including missing fields', () => {
  const requested=codexPermissions(path.resolve('synthetic-workspace'),codexPolicy('ask'));
  const effective={...requested,sandbox:{type:'workspaceWrite'}};
  assert.deepEqual(permissionDifferences(effective,requested),[]);
  for(const sandbox of [undefined,{type:'readOnly'},{type:'workspaceWrite',networkAccess:true},{type:'workspaceWrite',writableRoots:[path.resolve('other-workspace')]},{type:'workspaceWrite',excludeTmpdirEnvVar:true}]) {
    assert.ok(permissionDifferences({...effective,sandbox},requested).includes('sandbox'));
  }
  assert.ok(permissionDifferences({...effective,approvalPolicy:'never'},requested).includes('approval policy'));
  assert.ok(permissionDifferences({...effective,approvalsReviewer:'guardian_subagent'},requested).includes('approval reviewer'));
  assert.ok(permissionDifferences({...effective,cwd:undefined},requested).includes('workspace'));
});

test('native recovery uses visible completed actions and conversation without hidden reasoning', () => {
  const thread={id:'old',turns:[{id:'t1',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'Build the original feature.'}]},{type:'commandExecution',command:'synthetic build',status:'completed',exitCode:0,aggregatedOutput:'Already published.'},{type:'reasoning',text:'HIDDEN'},{type:'agentMessage',text:'The build is complete.'}]}]};
  const context=nativeRecoveryContext(thread);
  assert.match(context,/Build the original feature/);assert.match(context,/Already published/);assert.match(context,/The build is complete/);assert.doesNotMatch(context,/HIDDEN/);
  assert.match(context,/do not repeat successful side effects/i);
  assert.throws(()=>nativeRecoveryContext({...thread,status:{type:'active'}}),/still running/);
  assert.throws(()=>nativeRecoveryContext({id:'old'}),/history could not be read/);
});
