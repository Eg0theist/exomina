import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createLibraryBackup,inspectLibraryBackup,restoreLibraryBackup,backupState,verifyLibraryBackup} from '../desktop/library-backup.mjs';
import {Store} from '../desktop/store.mjs';
import {MemoryStore} from '../desktop/note-store.mjs';
import {SkillLibrary} from '../desktop/skill-library.mjs';
import {ChatMemoryTree} from '../desktop/chat-memory-tree.mjs';
import {ChatMemoryService} from '../desktop/chat-memory-service.mjs';
import {fingerprint} from '../desktop/chat-memory-records.mjs';
import {ClientScopes} from '../desktop/client-scopes.mjs';
import {ClientRuntime} from '../desktop/client-runtime.mjs';

async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'exomina-library-test-'));assert.equal(path.dirname(root),os.tmpdir());t.after(()=>rm(root,{recursive:true,force:true}));const dataDir=path.join(root,'data'),folder=path.join(root,'backups'),destination=path.join(root,'restores'),workspace=path.join(root,'work');for(const p of [dataDir,folder,destination,workspace])await mkdir(p);for(const relative of ['memory/notes.sqlite','chat-memory/tree.sqlite','archive.sqlite']){const file=path.join(dataDir,relative);await mkdir(path.dirname(file),{recursive:true});new DatabaseSync(file).close();}return {root,dataDir,folder,destination,workspace};}
test('library backup restores actual threads, domain databases, content bytes and safe defaults',async t=>{
 const e=await fixture(t),memory=new MemoryStore(e.dataDir);await memory.note('A useful original memory.',{conversationId:'chat'});memory.close();
 for(const relative of ['chat-memory/tree.sqlite','archive.sqlite']){const file=path.join(e.dataDir,relative);await mkdir(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE original(text TEXT); INSERT INTO original VALUES(\'original survives\')');db.close();}
 const bytes=Buffer.from('stored attachment content'),id=createHash('sha256').update(bytes).digest('hex'),uploadId='upload-1',relativePath='.exomina-attachments/fixture/note.txt';await mkdir(path.dirname(path.join(e.workspace,relativePath)),{recursive:true});await writeFile(path.join(e.workspace,relativePath),bytes);
 const state={settings:{workspace:e.workspace,permissionMode:'full',remoteSecret:'must-not-export',externalMcpServers:[{env:{KEY:'must-not-export'}}],personalization:{soul:{name:'Fixture',essence:'Useful'}}},conversations:[{id:'chat',title:'Real restored thread',provider:'codex',channel:{type:'discord'},permissionMode:'full',sessions:{codex:'must-not-export'},messages:[{id:'m',role:'user',content:'Original',attachments:[{id,uploadId,relativePath,kind:'file',bytes:bytes.length,sha256:id}]}]},{id:'temporary',private:true,messages:[{role:'user',content:'private temporary'}]}],projects:[{id:'p',name:'Project',folder:e.workspace,instructions:'Keep these instructions',files:['private.txt']}],prompts:[{id:'prompt',text:'Original prompt'}],schedules:[{id:'s',enabled:true,recipient:'remote'}],scratchpad:{notes:[{id:'note',title:'Notebook',text:'Original notebook',allowAI:false}],jobs:[{status:'running'}],settings:{enabled:true}}};
 const saved=await createLibraryBackup({...e,state,uploads:{[uploadId]:{attachment:state.conversations[0].messages[0].attachments[0],workspace:e.workspace,text:'stored attachment content'}}});
 assert.equal(saved.counts.chats,1);const exported=await readFile(path.join(saved.path,'state.json'),'utf8');assert.ok(!exported.includes('must-not-export'));assert.ok(!exported.includes('private temporary'));
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination,executable:'C:/Example/Exomina.exe'}),store=new Store(restored.profile,{workspace:restored.workspace});await store.init();
 assert.equal(store.state.conversations[0].messages[0].content,'Original');assert.equal(store.state.conversations[0].title,'Real restored thread');assert.equal(store.state.conversations[0].permissionMode,'ask');assert.deepEqual(store.state.conversations[0].sessions,{});assert.equal(store.state.settings.browserEnabled,false);assert.equal(store.state.schedules[0].enabled,false);assert.equal(store.state.scratchpad.notes[0].text,'Original notebook');assert.equal(store.state.scratchpad.settings.enabled,false);assert.equal(store.state.projects[0].folder,'');
 const uploads=JSON.parse(await readFile(path.join(restored.profile,'chat-uploads.json'),'utf8'));assert.equal(await readFile(path.join(uploads[uploadId].workspace,relativePath),'utf8'),'stored attachment content');
 const reopened=new MemoryStore(restored.profile);assert.equal((await reopened.recall('useful original'))[0].text,'A useful original memory.');reopened.close();
 assert.equal(JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8')).files.length,restored.verifiedFiles);assert.equal((await readdir(e.destination)).length,1);assert.equal(state.settings.permissionMode,'full');
});
test('tampered backup bytes and path traversal fail before publishing a restored profile',async t=>{
 const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}});await writeFile(path.join(saved.path,'state.json'),'changed');await assert.rejects(inspectLibraryBackup(saved.path),/integrity/);assert.deepEqual(await readdir(e.destination),[]);
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8'));manifest.files[0].path='../outside';await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest));await assert.rejects(inspectLibraryBackup(saved.path),/inventory/);
});
test('remote MCP credential files never transfer and cannot enter a restored backup inventory',async t=>{
 const e=await fixture(t);await writeFile(path.join(e.dataDir,'remote-mcp-credentials.json'),'synthetic encrypted credential sentinel','utf8');
 const saved=await createLibraryBackup({...e,state:{settings:{externalMcpServers:[{id:'suno',url:'https://api.suno.com/mcp',enabled:true}]},conversations:[]}});
 assert.equal(saved.files.some(file=>file.path==='remote-mcp-credentials.json'),false);assert.equal((await readdir(saved.path)).includes('remote-mcp-credentials.json'),false);
 assert.equal(JSON.parse(await readFile(path.join(saved.path,'state.json'),'utf8')).settings.externalMcpServers,undefined);
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8'));manifest.files.push({path:'remote-mcp-credentials.json',bytes:0,sha256:'0'.repeat(64)});await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest),'utf8');await assert.rejects(inspectLibraryBackup(saved.path),/Invalid backup inventory/);
});

test('AI voice acknowledgment is excluded from export and restore while voice choices survive',async t=>{
 const e=await fixture(t),voice={companionMode:'device',realtimeVoice:'cedar',aiVoiceAcknowledged:1},state={settings:{voice},conversations:[]};
 const saved=await createLibraryBackup({...e,state}),file=path.join(saved.path,'state.json'),exported=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(exported.settings.voice,{companionMode:'device',realtimeVoice:'cedar'});
 assert.equal(state.settings.voice.aiVoiceAcknowledged,1,'export must not modify the original profile');
 // Older or independently edited backups must not carry consent into a new profile.
 exported.settings.voice.aiVoiceAcknowledged=1;
 const bytes=Buffer.from(JSON.stringify(exported),'utf8');await writeFile(file,bytes);
 const manifestFile=path.join(saved.path,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8')),entry=manifest.files.find(item=>item.path==='state.json');
 entry.bytes=bytes.length;entry.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(manifestFile,JSON.stringify(manifest),'utf8');
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),restoredState=JSON.parse(await readFile(path.join(restored.profile,'state.json'),'utf8'));
 assert.deepEqual(restoredState.settings.voice,{companionMode:'device',realtimeVoice:'cedar'});
});

test('checking a copied backup reads hashes and database integrity without creating a restore',async t=>{
 const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}});
 const before=await readFile(path.join(saved.path,'manifest.json'));
 const checked=await verifyLibraryBackup(saved.path);
 assert.equal(checked.path,saved.path);assert.equal(checked.verifiedFiles,saved.files.length);
 assert.deepEqual(checked.checks,['file-checksums','database-quick-check']);
 assert.match(checked.limitations,/Does not restore/);
 assert.deepEqual(await readFile(path.join(saved.path,'manifest.json')),before);
 assert.deepEqual(await readdir(e.destination),[]);
 await writeFile(path.join(saved.path,'state.json'),'damaged copy','utf8');
 await assert.rejects(verifyLibraryBackup(saved.path),/integrity/);
});

test('checking WAL-mode backups leaves the source inventory unchanged',async t=>{
 const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}}),relative='memory/notes.sqlite';
 const db=new DatabaseSync(path.join(saved.path,relative));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE fixture(text);INSERT INTO fixture VALUES(\'kept\');');db.close();
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8')),entry=manifest.files.find(e=>e.path===relative),bytes=await readFile(path.join(saved.path,relative));
 entry.bytes=bytes.length;entry.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest),'utf8');
 const before=await readdir(saved.path,{recursive:true});
 await verifyLibraryBackup(saved.path);
 assert.deepEqual(await readdir(saved.path,{recursive:true}),before);
 assert.deepEqual(await readFile(path.join(saved.path,relative)),bytes);
});

test('backup check rejects a corrupt SQLite file even with matching inventory checksums',async t=>{
 const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}});
 const file=path.join(saved.path,'memory/notes.sqlite'),bytes=Buffer.from('damaged database');
 await writeFile(file,bytes);
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8')),entry=manifest.files.find(e=>e.path==='memory/notes.sqlite');
 entry.bytes=bytes.length;entry.sha256=createHash('sha256').update(bytes).digest('hex');
 await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest),'utf8');
 await assert.rejects(verifyLibraryBackup(saved.path),/database|file is not/i);
 assert.deepEqual(await readdir(e.destination),[]);
});
test('missing referenced attachment aborts backup and leaves no apparently complete folder',async t=>{const e=await fixture(t);await assert.rejects(createLibraryBackup({...e,state:{settings:{},conversations:[{id:'c',messages:[{attachments:[{uploadId:'missing',kind:'file'}]}]}]}}),/missing/);assert.deepEqual(await readdir(e.folder),[]);});
test('restoring strips imported execution controls even if the reviewed state asks for Full access',()=>{const result=backupState({settings:{permissionMode:'full',permissionRules:[{effect:'allow'}],messaging:{token:'secret'}},conversations:[{id:'c',messages:[],channel:{type:'discord'},permissionMode:'full',sessions:{sid:'secret'}}]});assert.equal(result.settings.permissionMode,'ask');assert.equal(result.settings.messaging,undefined);assert.equal(result.conversations[0].channel,undefined);assert.deepEqual(result.conversations[0].sessions,{});});
test('restore rejects an upload index entry without a matching verified inventory record',async t=>{
 const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}}),file=path.join(saved.path,'chat-uploads.json'),bytes=Buffer.from('uninventoried'),id=createHash('sha256').update(bytes).digest('hex');await mkdir(path.join(saved.path,'uploads'));await writeFile(path.join(saved.path,'uploads/x'),bytes);await writeFile(file,JSON.stringify({x:{attachment:{id,bytes:bytes.length,sha256:id,relativePath:'.exomina-attachments/x/file.txt'}}}));
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8')),entry=manifest.files.find(f=>f.path==='chat-uploads.json'),raw=await readFile(file);entry.bytes=raw.length;entry.sha256=createHash('sha256').update(raw).digest('hex');await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest));await assert.rejects(restoreLibraryBackup({folder:saved.path,destination:e.destination}),/uninventoried/);assert.deepEqual(await readdir(e.destination),[]);
});
test('review receipt binds restoration to the manifest that was reviewed',async t=>{const e=await fixture(t),saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}});await assert.rejects(restoreLibraryBackup({folder:saved.path,destination:e.destination,expectedReceipt:'changed'}),/changed after you reviewed/);assert.deepEqual(await readdir(e.destination),[]);});
test('restored overview and spending policies cannot resume automatic work',()=>{const copy=backupState({settings:{},conversations:[],scratchpad:{notes:[],organization:{autoRefresh:true,refreshConfigured:true,applied:{overview:'Keep this overview'}}},agentSpending:{policy:{enabled:true},trials:[{id:'trial'}]}});assert.equal(copy.scratchpad.organization.autoRefresh,false);assert.equal(copy.scratchpad.organization.refreshConfigured,false);assert.equal(copy.scratchpad.organization.applied.overview,'Keep this overview');assert.equal(copy.agentSpending.policy.enabled,false);});

test('fresh-library transfer keeps Soul evidence, repaired memory IDs and skill revisions with their sharing scopes',async t=>{
 const e=await fixture(t),chat={id:'chat',title:'Portable thread',provider:'codex',projectId:'p',messages:[]};
 const soul={name:'Fixture',essence:'Attend to particulars.',traits:[{id:'trait',text:'Check the source.',source:'stated',evidence:'A concrete user correction.'}],history:[{id:'old-core',action:'essence',beforeEssence:'Earlier description.'}],learning:{enabled:true,observations:[{id:'obs',key:'technical',text:'Outcome first.',scope:'technical',support:[{chatId:'chat',messageId:'u',quote:'Lead with the result.'}]}]}};
 const state={settings:{memoryEnabled:true,permissionMode:'full',personalization:{soul}},conversations:[chat],projects:[{id:'p',name:'Portable project',instructions:'Keep the intent.'}]};
 const tree=await new ChatMemoryTree(e.dataDir).init(),service=new ChatMemoryService({tree,settings:()=>({chatMemoryEnabled:true})}),answer='A retained completed answer.',date='2026-10-28T10:00:00Z';
 for(const text of ['A retained',answer])await tree.append('chat',{key:'followup:card:answer:'+fingerprint(text)+':part:0',role:'assistant',kind:'assistant',text,createdAt:text===answer?date:null,metadata:{followupId:'card'}});
 await service.recordFollowup('chat',{id:'card',answer,status:'answered',finishedAt:date});
 const skills=await new SkillLibrary({dir:path.join(e.dataDir,'shared-skills'),getChat:id=>id===chat.id?chat:null,getSettings:()=>({memoryEnabled:true}),approve:async()=>true}).init();
 const created=await skills.call({action:'create',scope:'project',name:'Traceable review',description:'Review with evidence.',instructions:'Read the full source.',references:[{name:'checks.md',text:'Keep unresolved questions visible.'}]},'chat');
 await skills.call({action:'revise',id:created.skill.id,baseRevision:1,instructions:'Read the full source and name the uncertainty.'},'chat');
 const saved=await createLibraryBackup({...e,state,skills:skills.state});
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),store=new Store(restored.profile,{workspace:restored.workspace});await store.init();
 assert.deepEqual(store.state.settings.personalization.soul,state.settings.personalization.soul);
 const reopened=await new SkillLibrary({dir:path.join(restored.profile,'shared-skills'),getChat:id=>store.state.conversations.find(c=>c.id===id),getSettings:()=>store.state.settings}).init();
 const catalog=await reopened.call({action:'catalog'},'chat');assert.equal(catalog.skills.length,1);assert.equal(catalog.skills[0].revision,2);assert.equal(catalog.skills[0].scope,'project');
 assert.equal((await reopened.call({action:'read',id:created.skill.id,revision:1},'chat')).text,'Read the full source.');
 assert.equal((await reopened.call({action:'read',id:created.skill.id,revision:2,reference:'checks.md'},'chat')).text,'Keep unresolved questions visible.');
 const restoredTree=await new ChatMemoryTree(restored.profile).init();try{const source=await restoredTree.zoom('chat',0);assert.equal(source.text,answer);assert.equal(source.retainedId,1);assert.equal((await restoredTree.stats('chat')).retiredDuplicates,1);}finally{await restoredTree.close();await service.close();}
 assert.equal(saved.counts.skills,1);assert.equal(store.state.conversations[0].permissionMode,'ask');
});

test('older backups without skills remain restorable and active side answers are interrupted',async t=>{
 const e=await fixture(t),state={settings:{},conversations:[{id:'c',messages:[{id:'m',role:'assistant',content:'',followups:[{id:'f',status:'answering',taskStatus:'working',answer:'Partial reply.'}]}]}]};
 const saved=await createLibraryBackup({...e,state}),manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8'));
 manifest.files=manifest.files.filter(entry=>entry.path!=='shared-skills/library.json');delete manifest.counts.skills;
 await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest),'utf8');
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),store=new Store(restored.profile,{workspace:restored.workspace});await store.init();
 const card=store.state.conversations[0].messages[0].followups[0];assert.equal(card.status,'interrupted');assert.equal(card.taskStatus,'blocked');assert.equal(card.answer,'Partial reply.');
});

test('invalid skill revision content fails restore even when its file checksum matches the inventory',async t=>{
 const e=await fixture(t),state={settings:{},conversations:[{id:'c',messages:[]}]},saved=await createLibraryBackup({...e,state});
 const file=path.join(saved.path,'shared-skills/library.json');
 await writeFile(file,JSON.stringify({version:1,skills:[{id:'bad',ownerChatId:'c',scope:{kind:'chat',id:'c'},status:'active',revisions:[{revision:1,hash:'0'.repeat(64),references:[]}]}]}),'utf8');
 const manifest=JSON.parse(await readFile(path.join(saved.path,'manifest.json'),'utf8')),entry=manifest.files.find(entry=>entry.path==='shared-skills/library.json'),bytes=await readFile(file);entry.bytes=bytes.length;entry.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(path.join(saved.path,'manifest.json'),JSON.stringify(manifest),'utf8');
 await assert.rejects(restoreLibraryBackup({folder:saved.path,destination:e.destination}),/skill|Skill|Provide/);assert.deepEqual(await readdir(e.destination),[]);
});

async function clientFixture(t){
 const e=await fixture(t),state={settings:{},conversations:[{id:'alpha-chat',projectId:'alpha-project',messages:[]},{id:'beta-chat',projectId:'beta-project',messages:[]},{id:'personal',messages:[]}],projects:[{id:'alpha-project',name:'Alpha'},{id:'beta-project',name:'Beta'}]},store={state,save:async()=>{}};
 const scopes=new ClientScopes({store,getPrincipal:()=> 'owner',getChat:id=>state.conversations.find(chat=>chat.id===id),resourceExists:()=>true});
 const org=(await scopes.manage({action:'createOrganization',name:'Agency'})).result,clients=[];
 for(const name of ['alpha','beta']){const client=(await scopes.manage({action:'createClient',organizationId:org.id,name})).result;clients.push(client);await scopes.manage({action:'bindResource',organizationId:org.id,clientId:client.id,kind:'project',id:name+'-project'});}
 const runtime=new ClientRuntime({scopes,dataDir:e.dataDir,getChats:()=>state.conversations});
 try{await (await runtime.memory('alpha-chat')).note('Client Alpha confidential marker');await (await runtime.memory('beta-chat')).note('Client Beta confidential marker');}finally{await runtime.close();}
 return {...e,state,scopes,org,clients};
}
test('backup and restore retain separate client databases and authorization before any retrieval',async t=>{
 const e=await clientFixture(t),saved=await createLibraryBackup(e),clientFiles=saved.files.filter(entry=>entry.path.startsWith('client-data/'));
 assert.equal(clientFiles.length,2);assert.equal((await verifyLibraryBackup(saved.path)).verifiedFiles,saved.files.length);
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),state=JSON.parse(await readFile(path.join(restored.profile,'state.json'),'utf8'));
 assert.deepEqual(state.clientScopes,e.state.clientScopes);
 const scopes=new ClientScopes({store:{state},getPrincipal:()=> 'owner',getChat:id=>state.conversations.find(chat=>chat.id===id)}),runtime=new ClientRuntime({scopes,dataDir:restored.profile,getChats:()=>state.conversations});
 try{const a=await runtime.memory('alpha-chat'),b=await runtime.memory('beta-chat');assert.match((await a.run(['wake'])).text,/Alpha confidential/);assert.doesNotMatch((await a.run(['wake'])).text,/Beta confidential/);assert.match((await b.run(['wake'])).text,/Beta confidential/);assert.deepEqual(runtime.chats('personal').map(chat=>chat.id),['personal']);}finally{await runtime.close();}
});
test('deep backup and restore destinations preserve scoped client memory',async t=>{
 const e=await clientFixture(t),folder=path.join(e.folder,'deep-'.repeat(24)),destination=path.join(e.destination,'deep-'.repeat(24));await mkdir(folder);await mkdir(destination);
 const saved=await createLibraryBackup({...e,folder}),clientFiles=saved.files.filter(entry=>entry.path.startsWith('client-data/'));
 assert.equal(clientFiles.length,2);assert.ok(clientFiles.every(entry=>path.join(saved.path,...entry.path.split('/')).length>270),'exercise native SQLite backup filenames beyond ordinary Win32 limits');
 assert.equal((await verifyLibraryBackup(saved.path)).verifiedFiles,saved.files.length);
 const restored=await restoreLibraryBackup({folder:saved.path,destination}),state=JSON.parse(await readFile(path.join(restored.profile,'state.json'),'utf8'));
 assert.deepEqual(state.clientScopes,e.state.clientScopes);
 assert.ok(path.join(restored.profile,clientFiles[0].path).length>270,'exercise reopening client memory under a deep restored profile');
 const scopes=new ClientScopes({store:{state},getPrincipal:()=> 'owner',getChat:id=>state.conversations.find(chat=>chat.id===id)}),runtime=new ClientRuntime({scopes,dataDir:restored.profile,getChats:()=>state.conversations});
 try{const a=await runtime.memory('alpha-chat'),b=await runtime.memory('beta-chat');assert.match((await a.run(['wake'])).text,/Alpha confidential/);assert.doesNotMatch((await a.run(['wake'])).text,/Beta confidential/);assert.match((await b.run(['wake'])).text,/Beta confidential/);}
 finally{await runtime.close();}
});

test('retired client data transfers without making its chats personal or granting new access',async t=>{
 const e=await clientFixture(t);await e.scopes.manage({action:'retireClient',organizationId:e.org.id,clientId:e.clients[0].id});
 const saved=await createLibraryBackup(e);assert.equal(saved.files.filter(entry=>entry.path.startsWith('client-data/')).length,2);
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),state=JSON.parse(await readFile(path.join(restored.profile,'state.json'),'utf8'));
 const scopes=new ClientScopes({store:{state},getPrincipal:()=> 'owner',getChat:id=>state.conversations.find(chat=>chat.id===id)});assert.equal(scopes.isScoped('alpha-chat'),true);assert.throws(()=>scopes.context('alpha-chat'),/unavailable/);
});
test('client database paths require a matching validated boundary even with correct hashes',async t=>{
 const e=await clientFixture(t),saved=await createLibraryBackup(e),manifestFile=path.join(saved.path,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 const original=manifest.files.find(entry=>entry.path.startsWith('client-data/')),foreign='client-data/'+'0'.repeat(64)+'/memory/notes.sqlite';await mkdir(path.dirname(path.join(saved.path,foreign)),{recursive:true});await writeFile(path.join(saved.path,foreign),await readFile(path.join(saved.path,original.path)));
 manifest.files.push({...original,path:foreign});await writeFile(manifestFile,JSON.stringify(manifest),'utf8');await assert.rejects(inspectLibraryBackup(saved.path),/no matching client/);assert.deepEqual(await readdir(e.destination),[]);
});
test('malformed client authorization aborts export instead of silently dropping the boundary',async t=>{
 const e=await fixture(t);await assert.rejects(createLibraryBackup({...e,state:{settings:{},conversations:[],clientScopes:{version:1}}}),/Invalid client authorization/);assert.deepEqual(await readdir(e.folder),[]);
});
test('optional durable outcome archive transfers through backup, verification and restore',async t=>{
 const e=await fixture(t),relative='outcome-archive/outcomes.sqlite',source=path.join(e.dataDir,relative);await mkdir(path.dirname(source));const db=new DatabaseSync(source);try{db.exec("CREATE TABLE receipt(id TEXT PRIMARY KEY,claim TEXT);INSERT INTO receipt VALUES('kept','Retained outcome evidence')");}finally{db.close();}
 const saved=await createLibraryBackup({...e,state:{settings:{},conversations:[]}});assert.ok(saved.files.some(file=>file.path===relative));await verifyLibraryBackup(saved.path);
 const restored=await restoreLibraryBackup({folder:saved.path,destination:e.destination}),reopened=new DatabaseSync(path.join(restored.profile,relative),{readOnly:true});try{assert.equal(reopened.prepare('SELECT claim FROM receipt WHERE id=?').get('kept').claim,'Retained outcome evidence');}finally{reopened.close();}
});
