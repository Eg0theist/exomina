import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingUpdateReceipt,updateCompletionContext,settleUpdateReceipts,cancelUpdateReceipt} from '../desktop/update-completion.mjs';

test('restart receipt survives JSON save and compares exact fresh running identity',()=>{
  const receipt=pendingUpdateReceipt({id:'new-build',version:'0.7.14'},new Date('2026-11-07T22:00:00Z'));
  const messages=JSON.parse(JSON.stringify([{id:'reply',pendingUpdate:receipt}]));
  const before=updateCompletionContext(messages,{id:'old-build'});
  assert.match(before,/installation-unverified/);assert.doesNotMatch(before,/running-approved-build/);
  const after=updateCompletionContext(messages,{id:'new-build'});
  assert.match(after,/running-approved-build/);assert.match(after,/verify the installed outcome/);
  assert.equal(messages[0].pendingUpdate.status,'restart-approved');
  assert.match(updateCompletionContext(messages,{id:'new-build-other'}),/installation-unverified/);
});

test('missing stamp stays unverified and ordinary chat has no checkpoint',()=>{
  assert.equal(updateCompletionContext([{content:'installed new-build'}],{id:'new-build'}),'');
  assert.match(updateCompletionContext([{pendingUpdate:{buildId:'new-build',status:'restart-approved'}}],null),/installation-unverified/);
});

test('only a matching host installed mark closes the saved checkpoint',()=>{
  const messages=[{pendingUpdate:pendingUpdateReceipt({id:'new-build'})}];
  const mark={id:'mark',checkedBy:'exomina',kind:'update_installed',status:'verified',observed:{buildId:'new-build'},at:'2026-11-07'};
  assert.equal(settleUpdateReceipts(messages,{...mark,status:'contradicted'}),false);
  assert.equal(settleUpdateReceipts(messages,{...mark,kind:'update_staged'}),false);
  assert.equal(settleUpdateReceipts(messages,{...mark,observed:{buildId:'other-build'}}),false);
  assert.equal(settleUpdateReceipts(messages,mark),true);
  assert.equal(messages[0].pendingUpdate.markId,'mark');
  assert.equal(updateCompletionContext(messages,{id:'new-build'}),'');
});

test('stopped or failed reply withdraws its pending update checkpoint',()=>{
  for(const reason of ['Stopped','Reply failed','Handover failed']){
    const message={pendingUpdate:pendingUpdateReceipt({id:'new-build'})};
    assert.equal(cancelUpdateReceipt(message,reason),true);
    assert.equal(updateCompletionContext([message],{id:'old-build'}),'');
    assert.equal(message.pendingUpdate.reason,reason);
  }
});
