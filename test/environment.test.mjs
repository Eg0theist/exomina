import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceContext} from '../desktop/environment.mjs';
test('workspace context distinguishes non-repository from failed Git verification',async()=>{assert.equal((await workspaceContext('sample',{run:async()=>({stdout:'true\n'})})).gitRepository,true);assert.equal((await workspaceContext('sample',{run:async()=>{throw {code:128}}})).gitRepository,false);assert.equal((await workspaceContext('sample',{run:async()=>{throw {code:'ENOENT'}}})).gitRepository,null);});
