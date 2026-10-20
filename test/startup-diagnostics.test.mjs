import test from 'node:test';
import assert from 'node:assert/strict';
import {startupDiagnostics} from '../desktop/startup-diagnostics.mjs';

test('startup phases are opt-in and never emit arbitrary labels or error details',()=>{
 const lines=[];
 const quiet=startupDiagnostics({write:line=>lines.push(line)});
 quiet.phase('locations.begin');quiet.failure(new Error('private path / token'));
 assert.deepEqual(lines,[]);
 const diagnostics=startupDiagnostics({enabled:true,write:line=>lines.push(line)});
 assert.equal(diagnostics.phase('api.begin'),true);
 assert.equal(diagnostics.phase('private arbitrary label'),false);
 const error=new TypeError('private path / token');error.stack='private stack';
 diagnostics.failure(error);
 error.name='private exception class';diagnostics.failure(error);
 assert.deepEqual(lines,['[exomina-startup] phase=api.begin','[exomina-startup] failure phase=api.begin errorClass=TypeError','[exomina-startup] failure phase=api.begin errorClass=Error']);
});

test('diagnostic output failures never change startup behavior',()=>{
 const diagnostics=startupDiagnostics({enabled:true,write(){throw Error('broken stderr');}});
 assert.equal(diagnostics.phase('window.load.begin'),false);
 assert.equal(diagnostics.failure(new Error('private')),false);
});
