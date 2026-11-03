import test from 'node:test';
import assert from 'node:assert/strict';
import {startupDiagnostics,stopUnsafeStartup} from '../desktop/startup-diagnostics.mjs';

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

test('early protection failure explains the blocked startup and exits nonzero even if its dialog fails',()=>{
 for(const broken of [false,true]){
  const calls=[],app={exit:code=>calls.push(['exit',code])},dialog={showErrorBox:(title,detail)=>{calls.push(['dialog',title,detail]);if(broken)throw Error('Dialog unavailable');}};
  if(broken)assert.throws(()=>stopUnsafeStartup({app,dialog}),/Dialog unavailable/);else stopUnsafeStartup({app,dialog});
  assert.match(calls[0][1],/could not start safely/);assert.match(calls[0][2],/library has not been opened/);assert.match(calls[0][2],/protection has not been disabled/);assert.deepEqual(calls.at(-1),['exit',1]);
 }
});
