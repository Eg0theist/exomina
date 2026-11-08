import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTlcOutput,compareResult,crosscheck,TLC_PIN} from '../scripts/crosscheck-protocols.mjs';

test('TLC crosscheck requires checker success and complete counts, not just a hopeful log line',()=>{
  const output='TLC2 Version 2.19 of 08 August 2024\nModel checking completed. No error has been found.\n207 states generated, 128 distinct states found, 0 states left on queue.';
  const result=parseTlcOutput(output,0);
  assert.equal(result.status,'satisfied_in_model');
  assert.equal(compareResult({model:'delivery',fault:null},{status:'satisfied_in_model',states:128,transitions:206},result,output),true);
  assert.equal(parseTlcOutput(output,1).status,'inconclusive');
  assert.equal(compareResult({fault:null},{status:'satisfied_in_model',states:127,transitions:206},result,output),false);
  const incomplete=parseTlcOutput('Model checking completed. No error has been found.',0);
  assert.equal(compareResult({fault:null},{status:'satisfied_in_model',states:128,transitions:206},incomplete,''),false);
});
test('a deliberately broken model must violate the intended predicate in both independent checkers',()=>{
  const output='Invariant Safety is violated.\nThe behavior up to this point is:\ns = [stage |-> "sending", badAuthorization |-> TRUE, replayedUnknown |-> FALSE]';
  const result=parseTlcOutput(output,12),native={status:'counterexample'};
  assert.equal(compareResult({fault:'skip-final-authorization',model:'delivery',flag:'badAuthorization'},native,result,output),true);
  assert.equal(compareResult({fault:'replay-unknown',model:'delivery',flag:'replayedUnknown'},native,result,output),false);
  assert.equal(compareResult({fault:'skip-final-authorization',model:'delivery',flag:'badAuthorization'},{status:'satisfied_in_model'},result,output),false);
});
test('staged-as-installed counterexample must show acceptance without a valid installation receipt',()=>{
  const output='Invariant Safety is violated.\nThe behavior up to this point is:\ns = [accepted |-> TRUE, valid |-> FALSE]';
  const result=parseTlcOutput(output,12),scenario={model:'installation',fault:'trust-staged-mark',flag:'accepted'};
  assert.equal(compareResult(scenario,{status:'counterexample'},result,output),true);
  assert.equal(compareResult(scenario,{status:'counterexample'},result,output.replace('valid |-> FALSE','valid |-> TRUE')),false);
  assert.equal(parseTlcOutput('Parsing or semantic analysis failed.',150).status,'inconclusive');
});
test('developer crosscheck requires an explicit reviewed local JAR and never downloads a checker',async()=>{
  await assert.rejects(crosscheck(),/Nothing is downloaded/);
  assert.equal(TLC_PIN.sha256,'936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88');
});
