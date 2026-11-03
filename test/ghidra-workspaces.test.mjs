import test from 'node:test';
import assert from 'node:assert/strict';
import {GhidraWorkspaces,validateGhidraArguments} from '../desktop/ghidra-workspaces.mjs';
import {hostAction,PermissionPolicy} from '../desktop/permissions.mjs';

test('Ghidra bounded arguments reject arbitrary operations, paths, address expressions and oversized requests',()=>{
 for(const [operation,args,edit] of [['run',{},false],['functions',{path:'../private'},false],['decompile',{address:'0x401000; execute'},false],['read_memory',{address:'401000',length:4097},false],['strings',{limit:101},false],['rename_function',{address:'401000'},true],['set_comment',{address:'401000',comment:'x'.repeat(8001)},true]])assert.throws(()=>validateGhidraArguments(operation,args,edit));
 assert.deepEqual(validateGhidraArguments('functions',{limit:2,offset:4}),{limit:2,offset:4});assert.deepEqual(validateGhidraArguments('set_comment',{address:'0x401000',comment:''},true),{address:'0x401000',comment:''});
});
test('Ghidra reads and edits have distinct permission classifications',()=>{
 assert.equal(hostAction('ghidra_query').kind,'read');assert.equal(hostAction('ghidra_edit').kind,'write');
 const policy=new PermissionPolicy({getSettings:()=>({permissionMode:'read-only'}),getChat:()=>({})});
 assert.equal(policy.evaluate(hostAction('ghidra_edit'),'test').decision,'deny');
 const full=new PermissionPolicy({getSettings:()=>({permissionMode:'full'}),getChat:()=>({})});assert.equal(full.evaluate(hostAction('ghidra_edit'),'test',{requireConfirmation:true}).decision,'ask');
});
test('Ghidra selects available installed tools only for missing setup values and preserves explicit choices',async()=>{
 let config={ghidraPath:'user-selected-ghidra',javaPath:null},configured;
 const analysis={nativeConfiguration:async()=>config,checkPath:async value=>{assert.equal(value,'installed-jdk');},configureNative:async patch=>{configured=patch;return {...config,...patch};}};
 const workspace=new GhidraWorkspaces({analysis,installedSetup:{ghidraPath:'installed-ghidra',javaPath:'installed-jdk'}});
 assert.deepEqual(await workspace.nativeSetup(),{ghidraPath:'user-selected-ghidra',javaPath:'installed-jdk'});assert.deepEqual(configured,{javaPath:'installed-jdk'});
 config={ghidraPath:'user-selected-ghidra',javaPath:'user-selected-jdk'};configured=null;assert.deepEqual(await workspace.nativeSetup(),config);assert.equal(configured,null);
 config={ghidraPath:null,javaPath:null};analysis.checkPath=async()=>{throw Object.assign(Error('Missing installation'),{code:'ENOENT'});};assert.deepEqual(await workspace.nativeSetup(),config);assert.equal(configured,null);
});
test('Ghidra edit is never dispatched when the user turns edits off during approval or changes target',async()=>{
 const target={path:'synthetic.exe',selectionId:'one'},chat={ghidraEditing:true},session={target,folder:'synthetic-project',hash:'synthetic-hash',dead:false};let dispatched=false;
 const analysis={confirmTarget:async(id,expected)=>{if(expected.selectionId!==target.selectionId)throw Error('Target changed');return target;}};
 const workspace=new GhidraWorkspaces({dataDir:'synthetic',analysis,getChat:()=>chat,approve:async()=>{chat.ghidraEditing=false;return true;}});
 workspace.start=async()=>{};workspace.sessions.set('test',session);workspace.request=async()=>{dispatched=true;};
 await assert.rejects(workspace.call('ghidra_edit',{operation:'rename_function',arguments:{address:'401000',new_name:'allowed_name'}},'test'),/scope changed/);assert.equal(dispatched,false);
 chat.ghidraEditing=true;workspace.approve=async()=>{target.selectionId='two';return true;};session.target={...target,selectionId:'one'};
 await assert.rejects(workspace.call('ghidra_edit',{operation:'rename_function',arguments:{address:'401000',new_name:'allowed_name'}},'test'),/Target changed/);assert.equal(dispatched,false);
});
test('Long Ghidra start is reported as a background job, wakes the model once when done and ignores cancellation',async()=>{
 const notices=[],chat={};let finish;
 const workspace=new GhidraWorkspaces({dataDir:'synthetic',analysis:{},getChat:()=>chat,notify:async(id,text)=>{notices.push([id,text]);},limits:{callWaitSeconds:0.05}});
 workspace.startNow=()=>new Promise(resolve=>{finish=resolve;});
 const report=await workspace.startOrReport('test');assert.equal(report.state,'starting');assert.equal(report.job.active,true);assert.equal(report.job.notifiesWhenDone,true);
 assert.equal((await workspace.startOrReport('test')).state,'starting');
 finish();await workspace.starting.get('test');assert.equal(workspace.status('test').job.phase,'ready');assert.equal(notices.length,1);assert.match(notices[0][1],/automatic notice.*finished/);
 workspace.startNow=()=>Promise.reject(Error('boom'));assert.equal(await workspace.startOrReport('test').catch(error=>error.message),'boom');assert.equal(notices.length,1);
 workspace.limits.callWaitSeconds=0.05;let fail;workspace.startNow=()=>new Promise((_,reject)=>{fail=reject;});await workspace.startOrReport('test');fail(Error('Ghidra import failed.'));await workspace.starting.get('test').catch(()=>{});
 assert.equal(workspace.status('test').job.phase,'failed');assert.equal(notices.length,2);assert.match(notices[1][1],/failed.*import failed/);
 let cancel;workspace.startNow=()=>new Promise((_,reject)=>{cancel=reject;});await workspace.startOrReport('test');workspace.generation.set('test',1);cancel(Error('Ghidra start cancelled.'));await workspace.starting.get('test').catch(()=>{});
 assert.equal(workspace.status('test').job.phase,'cancelled');assert.equal(notices.length,2);
});
test('Adopting a finished project sets an existing project aside instead of refusing or deleting it',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,readdir,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path'),{createHash}=await import('node:crypto');
 const root=await mkdtemp(path.join(tmpdir(),'exo-adopt-')),bytes=Buffer.from('synthetic exe'),hash=createHash('sha256').update(bytes).digest('hex');
 try{
  const src=path.join(root,'src');await mkdir(path.join(src,'p.rep'),{recursive:true});await writeFile(path.join(src,'p.gpr'),'new');await writeFile(path.join(src,'p.rep','data'),'new-data');
  const dataDir=path.join(root,'data'),folder=path.join(dataDir,'ghidra-workspaces',createHash('sha256').update('c').digest('hex'),hash);
  await mkdir(path.join(folder,'Exomina.rep'),{recursive:true});await writeFile(path.join(folder,'Exomina.gpr'),'partial');
  const analysis={target:async()=>({kind:'file',name:'t.exe',path:'t.exe',identity:{}}),bytes:async()=>bytes};
  const workspace=new GhidraWorkspaces({dataDir,analysis,getChat:()=>({})});workspace.status=()=>({state:'stopped'});
  await workspace.adopt('c',path.join(src,'p.gpr'));
  assert.equal(await readFile(path.join(folder,'Exomina.gpr'),'utf8'),'new');
  const replaced=(await readdir(folder)).filter(x=>x.startsWith('replaced-'));assert.equal(replaced.length,1);assert.equal(await readFile(path.join(folder,replaced[0],'Exomina.gpr'),'utf8'),'partial');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('deleting saved Ghidra projects is confirmed, chat-scoped and preserves original files',async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,access,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path'),{createHash}=await import('node:crypto');
 const root=await mkdtemp(path.join(tmpdir(),'exo-delete-project-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'profile'),folder=id=>path.join(dataDir,'ghidra-workspaces',createHash('sha256').update(id).digest('hex'));
 await mkdir(path.join(folder('one'),'binary','checkpoints'),{recursive:true});await writeFile(path.join(folder('one'),'binary','checkpoints','before.gzf'),'derived checkpoint');
 await mkdir(folder('two'),{recursive:true});await writeFile(path.join(folder('two'),'keep.gpr'),'other chat');
 const original=path.join(root,'original.exe');await writeFile(original,'original bytes');
 const chat={analysisTarget:{path:original,selectionId:'one'},ghidraProject:{project:path.join(folder('one'),'a'.repeat(64))},ghidraEditing:true,working:true};let saves=0;
 const workspace=new GhidraWorkspaces({dataDir,analysis:{},getChat:()=>chat,save:async()=>{saves++;}});
 await assert.rejects(workspace.deleteProjects('one'),/Confirm deletion/);assert.equal(saves,0);
 workspace.sessions.set('one',{dead:false});await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/Save and stop/);workspace.sessions.clear();
 workspace.starting.set('one',Promise.resolve());await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/Save and stop/);workspace.starting.clear();
 const clearing=workspace.deleteProjects('one',{confirmed:true});await assert.rejects(workspace.start('one'),/being changed/);await assert.rejects(workspace.adopt('one','unused.gpr'),/being changed/);await clearing;
 await assert.rejects(access(folder('one')),/ENOENT/);assert.equal(await readFile(original,'utf8'),'original bytes');assert.equal(await readFile(path.join(folder('two'),'keep.gpr'),'utf8'),'other chat');
 assert.equal(chat.ghidraProject,undefined);assert.equal(chat.ghidraEditing,undefined);assert.equal(chat.analysisTarget.path,original);assert.equal(saves,2);
});

test('failed project cleanup keeps saved metadata and recovery checkpoints discoverable',async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm,symlink}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path'),{createHash}=await import('node:crypto');
 const root=await mkdtemp(path.join(tmpdir(),'exo-refuse-delete-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'profile'),folder=path.join(dataDir,'ghidra-workspaces',createHash('sha256').update('one').digest('hex')),outside=path.join(root,'originals');
 await mkdir(folder,{recursive:true});await mkdir(outside);await writeFile(path.join(outside,'original.exe'),'keep');await writeFile(path.join(folder,'checkpoint.gzf'),'checkpoint');await symlink(outside,path.join(folder,'linked'),'junction');
 const saved={project:path.join(folder,'a'.repeat(64))},chat={ghidraProject:saved,ghidraEditing:true};const workspace=new GhidraWorkspaces({dataDir,analysis:{},getChat:()=>chat});
 await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/linked/);assert.equal(chat.ghidraProject,saved);assert.equal(chat.ghidraEditing,true);assert.equal(await readFile(path.join(folder,'checkpoint.gzf'),'utf8'),'checkpoint');assert.equal(await readFile(path.join(outside,'original.exe'),'utf8'),'keep');
});

test('project deletion refuses target-switch maintenance and active analysis jobs before filesystem work',async()=>{
 const analysis={maintenance:new Set(['one'])},chat={ghidraProject:{project:'must remain'}};
 const workspace=new GhidraWorkspaces({dataDir:'must-not-be-read',analysis,getChat:()=>chat});
 await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/finish changing its selection/);analysis.maintenance.clear();
 workspace.jobs.set('one',{startedAt:Date.now(),finishedAt:null});await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/Save and stop/);workspace.jobs.clear();
 workspace.sessions.set('one',{dead:true,child:{exitCode:null,signalCode:null}});await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/Save and stop/);
 assert.equal(chat.ghidraProject.project,'must remain');assert.equal(workspace.deleting.size,0);
});

test('project cleanup rolls back metadata-save failure and refuses mismatched or missing saved folders',async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,readdir,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
 const root=await mkdtemp(path.join(tmpdir(),'exo-delete-rollback-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const chat={ghidraEditing:true},workspace=new GhidraWorkspaces({dataDir:root,analysis:{},getChat:()=>chat,save:async()=>{throw Error('Metadata save failed');}}),folder=workspace.folder('one'),saved={project:path.join(folder,'a'.repeat(64))};chat.ghidraProject=saved;
 await mkdir(saved.project,{recursive:true});await writeFile(path.join(saved.project,'Exomina.gpr'),'intact');
 await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/Metadata save failed/);assert.equal(chat.ghidraProject,saved);assert.equal(chat.ghidraEditing,true);assert.equal(await readFile(path.join(saved.project,'Exomina.gpr'),'utf8'),'intact');assert.equal((await readdir(path.dirname(folder))).filter(name=>name.includes('.deleting-')).length,0);
 chat.ghidraProject={project:root};assert.throws(()=>workspace.assertProjectsDeletable('one'),/expected storage layout/);
 chat.ghidraProject=saved;await rm(folder,{recursive:true,force:true});await assert.rejects(workspace.deleteProjects('one',{confirmed:true}),/folder is missing/);assert.equal(chat.ghidraProject,saved);
});

test('stopping adoption after the copy cancels before replacement and keeps the earlier project intact',async t=>{
 const {mkdtemp,mkdir,writeFile,readFile,readdir,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path'),{createHash}=await import('node:crypto');
 const root=await mkdtemp(path.join(tmpdir(),'exo-cancel-adopt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from('synthetic exe'),hash=createHash('sha256').update(bytes).digest('hex'),src=path.join(root,'source');await mkdir(path.join(src,'p.rep'),{recursive:true});await writeFile(path.join(src,'p.gpr'),'new');await writeFile(path.join(src,'p.rep','data'),'new-data');
 let entered,release;const copying=new Promise(resolve=>{entered=resolve;}),block=new Promise(resolve=>{release=resolve;});
 const analysis={target:async()=>({kind:'file',name:'t.exe',path:'t.exe',identity:{}}),bytes:async()=>bytes,confirmTarget:async()=>{entered();await block;}};
 const workspace=new GhidraWorkspaces({dataDir:path.join(root,'profile'),analysis,getChat:()=>({})}),folder=path.join(workspace.folder('one'),hash);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'Exomina.gpr'),'earlier');
 const adopting=workspace.adopt('one',path.join(src,'p.gpr'));adopting.catch(()=>{});await copying;const stopping=workspace.stop('one');release();await assert.rejects(adopting,/adoption cancelled/);await stopping;
 assert.equal(await readFile(path.join(folder,'Exomina.gpr'),'utf8'),'earlier');assert.equal((await readdir(workspace.folder('one'))).filter(name=>name.startsWith('.adopting-')).length,0);assert.equal(await readFile(path.join(src,'p.gpr'),'utf8'),'new');
});
