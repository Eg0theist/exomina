import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreAnswer,visibleSourceIds} from '../scripts/evaluate-memory-blind.mjs';

test('held-out answer scorer rejects false certainty, wrong values and unseen citations',()=>{
  const sources=[{id:'s1',text:'A forecast of 80, not an observed result.'}],unknown={status:'unknown',answers:[],sources:[]};
  assert.equal(scoreAnswer({status:'answer',answer:'80',sourceIds:['s1']},unknown,sources).falseCertainty,true);
  assert.equal(scoreAnswer({status:'unknown',answer:'',sourceIds:[]},unknown,sources).correct,true);
  const known={status:'answer',answers:['42'],sources:['s1']};
  assert.equal(scoreAnswer({status:'answer',answer:'41',sourceIds:['s1']},known,sources).correct,false);
  assert.equal(scoreAnswer({status:'answer',answer:'42',sourceIds:['invented']},known,sources).fabricatedCitation,true);
  assert.equal(scoreAnswer({status:'answer',answer:'42',sourceIds:[]},known,sources).correct,false);
  assert.equal(scoreAnswer({status:'answer',answer:'42',sourceIds:['s1']},known,sources).correct,true);
});

test('correction source references are visible but absent follow-up links are not invented',()=>{
  const sources=[{id:'old',evidence:{supersededBy:{id:'new',text:'The corrected value is 9.'}}}];
  assert.deepEqual([...visibleSourceIds(sources)],['old','new']);
  assert.equal(scoreAnswer({status:'answer',answer:'9',sourceIds:['new']},{status:'answer',answers:['9'],sources:['new']},sources).correct,true);
  assert.equal(scoreAnswer({status:'answer',answer:'9',sourceIds:['newer']},{status:'answer',answers:['9'],sources:['newer']},sources).correct,false);
});

test('ambiguity, unresolved conflict and unknown are distinct outcomes',()=>{
  const sources=[{id:'a'},{id:'b'}],gold={status:'ambiguous',answers:[],sources:['a','b']};
  assert.equal(scoreAnswer({status:'unknown',answer:'',sourceIds:['a','b']},gold,sources).correct,false);
  assert.equal(scoreAnswer({status:'conflict',answer:'',sourceIds:['a','b']},gold,sources).correct,false);
  assert.equal(scoreAnswer({status:'ambiguous',answer:'',sourceIds:['a','b']},gold,sources).correct,true);
  assert.equal(scoreAnswer({status:'ambiguous',answer:'north',sourceIds:['a','b']},gold,sources).correct,false);
});
