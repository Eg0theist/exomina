import test from 'node:test';
import assert from 'node:assert/strict';
import {wordErrorRate,protectedAccuracy,percentile,evaluateDictation} from '../scripts/dictation-evaluation.mjs';

test('WER counts substitutions deletions and insertions, preserving German lexical words',()=>{
 assert.deepEqual(wordErrorRate('one two three','one four three five'),{referenceWords:3,hypothesisWords:4,substitutions:1,deletions:0,insertions:1,errors:2,wer:2/3});assert.equal(wordErrorRate('nicht ohne fünf','ohne fünf').deletions,1);assert.equal(wordErrorRate('Hamburg, Straße','hamburg straße!').wer,0);assert.equal(wordErrorRate('','extra').wer,null);
});
test('protected categories require declared targets and exact command syntax',()=>{
 const result=protectedAccuracy('Mara must not run npm test for five files.','Mara must run npm Test for 5 files.',{names:['Mara'],negations:['not'],commands:['npm test'],numbers:[{label:'five',variants:['five','5']}]});assert.equal(result.names.preserved,1);assert.equal(result.negations.preserved,0);assert.equal(result.commands.preserved,0);assert.equal(result.numbers.preserved,1);assert.throws(()=>protectedAccuracy('hello','hello',{names:['missing']}),/occur in its reference/);
});
test('nearest-rank p50/p95 include only finite measured observations',()=>{
 assert.equal(percentile([9,1,3,NaN,5],.5),3);assert.equal(percentile([9,1,3,5],.95),9);assert.equal(percentile([],0.5),null);
});
test('corpus-declared decimal representations preserve quantities without accepting wrong amounts',()=>{
 const protection={numbers:[{label:'42.17 EUR',variants:['zweiundvierzig Euro und siebzehn Cent','42,17','42.17']}]},reference='Die Rechnung beträgt zweiundvierzig Euro und siebzehn Cent.';
 assert.equal(protectedAccuracy(reference,'Die Rechnung beträgt 42,17 €',protection).numbers.preserved,1);assert.equal(protectedAccuracy(reference,'Die Rechnung beträgt 442,17 €',protection).numbers.preserved,0);
});
test('mode/engine/corpus reports separate unavailable cases from recognition errors and cleanup',()=>{
 const corpus={id:'synthetic',kind:'test',cases:[{id:'a',language:'de-DE',reference:'Exomina darf nicht senden.',protected:{names:['Exomina'],negations:['nicht']}},{id:'b',language:'en-GB',reference:'unknown',protected:{}}]},recordings=[{id:'a',text:'exomina  darf senden.',recognitionProcessingMs:100,coldLoadMs:50,audioDurationMs:1000}];
 const raw=evaluateDictation(corpus,recordings,{engine:{name:'synthetic'},mode:'raw'}),clean=evaluateDictation(corpus,recordings,{engine:{name:'synthetic'},mode:'minimal',vocabulary:['Exomina']});assert.equal(raw.summary.cases,1);assert.equal(raw.summary.skipped,1);assert.equal(raw.summary.protected.negations.accuracy,0);assert.equal(clean.cases[0].output,'Exomina darf senden.');assert.equal(clean.summary.cleanupIntroducedErrors,0);assert.equal(raw.summary.realTimeFactor.p50,.1);assert.equal(raw.corpus.sha256,clean.corpus.sha256);assert.throws(()=>evaluateDictation(corpus,[...recordings,...recordings],{engine:{name:'x'}}),/Duplicate/);
});
