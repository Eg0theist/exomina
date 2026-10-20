import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTaskRequest,normalizeTaskGuide} from '../desktop/task-guide.mjs';
test('manual rewriting preserves intent, scope and review; voice reference is never treated as facts',()=>{
 const base={sourceKind:'text',goal:'Keep the irony',purpose:'rewrite',material:'Original sentence.'};
 const light=buildTaskRequest({...base,voiceSample:'A separate style example.'});assert.match(light,/Keep close to my phrasing/);assert.match(light,/style only/);assert.match(light,/Original sentence/);assert.match(light,/Keep the irony/);assert.match(light,/Do not send, publish, overwrite/);
 assert.match(buildTaskRequest({...base,rewriteLevel:'full'}),/restructure and rewrite freely/);
 assert.deepEqual(normalizeTaskGuide(base),{sourceKind:'text',goal:'Keep the irony',purpose:'rewrite'});
 assert.throws(()=>buildTaskRequest({...base,sourceKind:'website'}),/Paste/);assert.throws(()=>buildTaskRequest({...base,voiceSample:'x'.repeat(5001)}),/voice sample/);
});
