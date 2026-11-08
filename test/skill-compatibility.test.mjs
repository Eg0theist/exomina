import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectSkillFiles,toolContracts} from '../desktop/skill-compatibility.mjs';
import {SkillLibrary,validateSkillLibraryState} from '../desktop/skill-library.mjs';

test('import compatibility parses simple inline tool lists and preserves raw source hashes',()=>{
  const text='---\nname: Review report\nallowed-tools: [workspace_read, "unavailable_tool"]\ndescription: Preserve the source.\n---\nUntrusted instructions.\n';
  const result=inspectSkillFiles([{name:'SKILL.md',text}],[{name:'workspace_read'}]);
  assert.deepEqual(result.requestedTools,[{name:'workspace_read',available:true},{name:'unavailable_tool',available:false}]);
  assert.deepEqual(result.unsupportedTools,['unavailable_tool']);
  assert.equal(result.files[0].sha256,createHash('sha256').update(text,'utf8').digest('hex'));
  assert.equal(result.candidate.instructions,text);
});

test('empty or complex frontmatter is flagged without consuming the next metadata line',()=>{
  for(const tools of ['allowed-tools:\n  - workspace_read','allowed-tools: &alias workspace_read','allowed-tools: [workspace_read, {unsafe: tool}]']){
    const result=inspectSkillFiles([{name:'SKILL.md',text:'---\nname:\ndescription: The description\n'+tools+'\n---\nBody'}]);
    assert.equal(result.candidate.name,'Imported skill');assert.deepEqual(result.requestedTools,[]);assert.match(result.flags.join(' '),/unsupported metadata syntax/);
  }
  const result=inspectSkillFiles([{name:'SKILL.md',text:'---\nallowed-tools: "workspace_read workspace_write"\n---\nBody'}],[{name:'workspace_read'}]);
  assert.equal(result.requestedTools.length,2);
});

test('catalog definitions and permission scope participate in deterministic contract pins',()=>{
  const first=[{name:'tool',description:'read',inputSchema:{type:'object',properties:{a:{type:'string'},b:{type:'number'}}}}],reordered=[{inputSchema:{properties:{b:{type:'number'},a:{type:'string'}},type:'object'},description:'read',name:'tool'}];
  const pin=toolContracts(['tool'],first,'scope1');
  assert.equal(pin.fingerprint,toolContracts(['tool'],reordered,'scope1').fingerprint);
  assert.notEqual(pin.fingerprint,toolContracts(['tool'],first,'scope2').fingerprint);
  assert.notEqual(pin.fingerprint,toolContracts(['tool'],[],'scope1').fingerprint);
});

async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-skill-compat-'));
  t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});});
  const chats=new Map([['a',{id:'a',projectId:'p'}],['b',{id:'b',projectId:'p'}]]),requests=[];
  const library=await new SkillLibrary({dir,getChat:id=>chats.get(id),getSettings:()=>({memoryEnabled:true}),approve:async request=>{requests.push(request);return true;}}).init();
  const create=async(args={})=>(await library.call({action:'create',name:'Synthetic',description:'Synthetic source',instructions:'Read the approved source.',...args},'a')).skill;
  const dep=skill=>({id:skill.id,revision:skill.revision,hash:skill.hash});
  return {dir,library,chats,requests,create,dep};
}

test('shared procedures cannot pin narrower scopes and transitive cycles are refused',async t=>{
  const f=await fixture(t),local=await f.create(),project=await f.create({scope:'project'}),all=await f.create({scope:'all'}),before=f.requests.length;
  await assert.rejects(f.create({scope:'all',dependencies:[f.dep(local)]}),/restricted sharing scope/);
  await assert.rejects(f.create({scope:'all',dependencies:[f.dep(project)]}),/restricted sharing scope/);
  await assert.rejects(f.create({scope:'project',dependencies:[f.dep(local)]}),/restricted sharing scope/);
  assert.equal(f.requests.length,before);
  await f.create({scope:'project',dependencies:[f.dep(all)]});
  const second=await f.create({dependencies:[f.dep(local)]});
  await assert.rejects(f.library.call({action:'revise',id:local.id,baseRevision:1,dependencies:[f.dep(second)]},'a'),/cycles/);
});

test('dependency scope is rechecked after approval and corrupt portable graphs are rejected',async t=>{
  const f=await fixture(t),base=await f.create({scope:'all'});
  f.library.approve=async()=>{f.library.state.skills.find(skill=>skill.id===base.id).scope={kind:'chat',id:'a'};return true;};
  await assert.rejects(f.create({scope:'all',dependencies:[f.dep(base)]}),/restricted sharing scope/);
  f.library.state.skills.find(skill=>skill.id===base.id).scope={kind:'all'};
  f.library.approve=async()=>true;
  await f.create({scope:'all',dependencies:[f.dep(base)]});
  const original=JSON.parse(await readFile(path.join(f.dir,'library.json'),'utf8'));
  original.skills.find(skill=>skill.id===base.id).scope={kind:'chat',id:'a'};
  assert.throws(()=>validateSkillLibraryState(original),/dependency sharing scope/);
  await writeFile(path.join(f.dir,'library.json'),JSON.stringify(original),'utf8');
  await assert.rejects(new SkillLibrary({dir:f.dir,getChat:id=>f.chats.get(id)}).init(),/dependency sharing scope/);
});

test('a new pinned-source revision requires review even when its text hash is identical',async t=>{
  const f=await fixture(t),source=await f.create(),consumer=await f.create({dependencies:[f.dep(source)]});
  const revised=(await f.library.call({action:'revise',id:source.id,baseRevision:1},'a')).skill;
  assert.equal(revised.hash,source.hash);
  const inspected=await f.library.call({action:'dependencies',id:consumer.id},'a');
  assert.equal(inspected.status,'needs-review');assert.equal(inspected.dependencies[0].status,'changed');
});
