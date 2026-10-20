import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceTools} from '../desktop/workspace-tools.mjs';

const unix=['linux','darwin'].includes(process.platform);
async function fixture(t){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-native-portability-'));
  const workspace=path.join(dataDir,'workspace');await mkdir(workspace);
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  return {dataDir,workspace,tools:new WorkspaceTools({dataDir,getSettings:()=>({workspace}),approve:async()=>true})};
}

test('native Unix workspace terminal executes after approval and preserves its selected directory',{skip:!unix},async t=>{
  const {tools,workspace}=await fixture(t);
  const result=JSON.parse((await tools.call('workspace_shell',{command:"printf 'native-shell-synthetic\\n'; pwd",timeoutSeconds:5},'native-shell')).content[0].text);
  assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);
  assert.ok(result.output.includes('native-shell-synthetic\n'));assert.ok(result.output.split(/\r?\n/).includes(await realpath(workspace)));
});

test('native Unix timeout terminates the owned shell and sleeping descendant process group',{skip:!unix},async t=>{
  const {tools}=await fixture(t),start=performance.now();
  const result=JSON.parse((await tools.call('workspace_shell',{command:'sleep 30 & wait',timeoutSeconds:1},'native-timeout')).content[0].text);
  assert.equal(result.timedOut,true);assert.ok(performance.now()-start<5000);
  assert.equal(tools.processes.size,0);
});

test('native Unix timeout terminates descendants after their shell leader exits',{skip:!unix},async t=>{
  const {tools}=await fixture(t),start=performance.now();
  const result=JSON.parse((await tools.call('workspace_shell',{command:'sleep 30 &',timeoutSeconds:1},'native-background')).content[0].text);
  assert.equal(result.timedOut,true);assert.ok(performance.now()-start<5000);
});

test('native Unix timeout remains bounded for TERM-ignoring commands',{skip:!unix},async t=>{
  const {tools}=await fixture(t),start=performance.now();
  const result=JSON.parse((await tools.call('workspace_shell',{command:"trap '' TERM; sleep 30 & wait",timeoutSeconds:1},'native-ignore-term')).content[0].text);
  assert.equal(result.timedOut,true);assert.ok(performance.now()-start<5000);
});

test('native Linux file boundary rejects a differently cased sibling workspace',{skip:process.platform!=='linux'},async t=>{
  const {dataDir,workspace,tools}=await fixture(t);
  const sibling=path.join(dataDir,'WORKSPACE');await mkdir(sibling);await writeFile(path.join(sibling,'synthetic.txt'),'outside selected workspace');
  await assert.rejects(tools.target('../WORKSPACE/synthetic.txt'),/outside the chosen workspace/);
  assert.equal(await tools.target('new.txt',true),path.join(workspace,'new.txt'));
});
