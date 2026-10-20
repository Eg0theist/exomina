import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../desktop/memory.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-memory-'));const stores=[];t.after(async()=>{for(const s of stores)s.close();await rm(dir,{recursive:true,force:true})});return {dir,open(){const store=new MemoryStore(dir);stores.push(store);return store}};}
test('durable Unicode notes, search and explicit approvals',async t=>{
 const f=await fixture(t),a=f.open();await a.init();await a.note('Remember café and 🌙.');await a.note('Second note: Windows 11.');const b=f.open();await b.init();assert.equal((await b.list('CAFÉ'))[0].text,'Remember café and 🌙.');assert.match((await b.run(['wake'])).text,/Remember café/);
 await assert.rejects(()=>b.note('é'.repeat(141)),/280/);await assert.rejects(()=>b.note('one\ntwo'),/one line/);await assert.rejects(()=>a.call('memory_note',{text:'Do not persist'},async()=>false,'test'),/declined/);assert.equal((await b.list()).length,2);
});
test('hierarchical compression preserves source notes, paginated recall and expandable summaries',async t=>{
 const f=await fixture(t),a=f.open();await a.init();for(let n=1;n<=160;n++)await a.note(`Synthetic source ${n}: café 🌙`);
 let compressed=0;for(let i=0;i<100;i++){const pending=JSON.parse((await a.run(['nap'])).text);if(!pending.range)break;const saved=await a.run(['nap',pending.range,`Summary of ${pending.range}`]);assert.equal(saved.error,false);compressed++;}assert.ok(compressed>=22);
 const wake=JSON.parse((await a.run(['wake'])).text);assert.ok(wake.notes.some(n=>n.summary));assert.equal(wake.total,160);assert.equal((await a.list('',1000)).length,160);assert.equal((await a.list('source 17:'))[0].text,'Synthetic source 17: café 🌙');
 const expanded=JSON.parse((await a.run(['zoom','1-64'])).text);assert.equal(expanded.notes.length,64);assert.equal(expanded.summary,'Summary of 1-64');assert.equal(expanded.notes[0].text,'Synthetic source 1: café 🌙');
 await a.remove(expanded.notes[0].id);assert.equal(JSON.parse((await a.run(['zoom','1-64'])).text).summary,null);
});
test('verified legacy migration removes obsolete copies; tombstones prevent resurrection',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.dir,'memory'));const row=Buffer.alloc(320,32),text='#0 2026-10-05 Saved café';row.write(text);row[319]=10;const file=path.join(f.dir,'memory','LOG.txt');await writeFile(file,row);
 const tree=path.join(f.dir,'memory','TREE.txt');await writeFile(tree,'Old derived copy: Saved café');const a=f.open();await a.init();assert.equal((await a.list()).length,1);await assert.rejects(readFile(file),{code:'ENOENT'});await assert.rejects(readFile(tree),{code:'ENOENT'});const note=(await a.list())[0];await a.clear();await a.note(note.text,{id:note.id});assert.deepEqual(await a.list(),[]);a.close();const b=f.open();await b.init();assert.deepEqual(await b.list(),[]);
 await b.remove('remote-deleted-note');await b.applySyncedNote({id:'remote-deleted-note',text:'Stale note',createdAt:'2026-10-05T00:00:00Z'});assert.deepEqual(await b.list(),[]);
 await b.applySyncedNote({id:'remote-live-note',text:'First',createdAt:'2026-10-05T00:00:00Z'});await b.applySyncedNote({id:'remote-live-note',text:'Second',createdAt:'2026-10-05T00:00:00Z'});assert.equal((await b.list())[0].text,'Second');
});

test('automatic notes deduplicate exact text and return bounded sync metadata',async t=>{
 const f=await fixture(t),a=f.open();await a.init();const first=await a.call('memory_note',{text:' Durable café preference '},async()=>true);assert.equal(first.savedNote.text,'Durable café preference');assert.ok(first.savedNote.id);assert.ok(first.savedNote.createdAt);
 const same=await a.note('Durable café preference');assert.equal(same.id,first.savedNote.id);assert.deepEqual(await a.getNote(same.id),first.savedNote);assert.equal((await a.list()).length,1);
 await a.applySyncedNote({id:'explicit-other-device-id',text:'Durable café preference',createdAt:'2026-10-05T00:00:00Z'});assert.equal((await a.list()).length,2);
 for(let n=0;n<6;n++)await a.note(`Additional source ${n}`);const final=await a.call('memory_note',{text:'Additional source 6'},async()=>true);assert.match(final.content[0].text,/summary is pending/);
});

test('SQL invalidation spans connections, rejects stale summaries and retains unrelated caches',async t=>{
 const f=await fixture(t),a=f.open();await a.init();for(let n=1;n<=72;n++)await a.note(`Original ${n}`,{id:`n${n}`});
 assert.equal((await a.run(['nap','1-8','Unreviewed sources'])).error,true);
 for(let n=0;n<12;n++){const pending=JSON.parse((await a.run(['nap'])).text);if(!pending.range)break;assert.equal((await a.run(['nap',pending.range,`Cached ${pending.range}`,pending.version])).error,false);}
 const b=f.open();await b.init();const issued=JSON.parse((await a.run(['nap','1-8'])).text);await b.applySyncedNote({id:'n3',text:'Updated original 3',createdAt:'2026-10-05T00:00:00Z'});
 assert.equal((await b.run(['nap','1-8','Another process did not read the sources'])).error,true);
 const stale=await a.run(['nap','1-8','Must not be accepted',issued.version]);assert.equal(stale.error,true);assert.match(stale.detail,/changed/);
 assert.equal(JSON.parse((await a.run(['zoom','1-64'])).text).summary,null);assert.equal(JSON.parse((await a.run(['zoom','9-16'])).text).summary,'Cached 9-16');
 const pending=JSON.parse((await a.run(['nap'])).text);assert.equal(pending.range,'1-8');assert.equal(pending.sources.find(x=>x.id==='n3').text,'Updated original 3');assert.equal((await a.run(['nap',pending.range,'Corrected leaf',pending.version])).error,false);
 assert.equal(JSON.parse((await a.run(['nap'])).text).range,'1-64');await b.remove('n3');assert.equal(JSON.parse((await a.run(['zoom','1-8'])).text).summary,null);assert.equal((await a.list('Updated original')).length,0);
});

test('forget drops overlapping summaries and rebuilds them without touching source notes',async t=>{
 const f=await fixture(t),a=f.open();await a.init();for(let n=1;n<=80;n++)await a.note(`Source ${n}`);
 for(let n=0;n<20;n++){const p=JSON.parse((await a.run(['nap'])).text);if(!p.range)break;await a.run(['nap',p.range,`Summary ${p.range}`,p.version]);}
 const result=JSON.parse((await a.run(['forget','3-4'])).text);assert.equal(result.sourcesPreserved,true);assert.equal(result.forgottenSummaries,2);assert.equal((await a.list('',100)).length,80);
 assert.equal(JSON.parse((await a.run(['zoom','1-8'])).text).summary,null);assert.equal(JSON.parse((await a.run(['zoom','1-64'])).text).summary,null);assert.equal(JSON.parse((await a.run(['zoom','9-16'])).text).summary,'Summary 9-16');assert.equal(JSON.parse((await a.run(['nap'])).text).range,'1-8');
 const tool=await a.call('memory_forget',{range:'9-16'});assert.equal(tool.isError,false);assert.ok(a.definitions.some(x=>x.name==='memory_forget'));
});

test('10,000 originals use bounded SELECT results for wake and nap, with stable cursor pagination',async t=>{
 const f=await fixture(t),a=f.open();await a.init();a.db.exec('BEGIN IMMEDIATE');try{const insert=a.db.prepare('INSERT INTO notes(id,created_at,text) VALUES(?,?,?)');for(let n=1;n<=10000;n++)insert.run(`scale-${n}`,'2026-10-05T00:00:00Z',`Synthetic original ${n} `+'é'.repeat(100));a.db.exec('COMMIT');}catch(e){a.db.exec('ROLLBACK');throw e;}
 const originalPrepare=a.db.prepare.bind(a.db);let returned=0,maxResult=0,sourceAll=0;
 a.db.prepare=sql=>{const statement=originalPrepare(sql);return new Proxy(statement,{get(target,key){if(key==='get'||key==='all')return (...args)=>{const value=target[key](...args),count=key==='all'?value.length:Number(!!value);returned+=count;maxResult=Math.max(maxResult,count);if(key==='all'&&/FROM notes/i.test(sql))sourceAll+=count;return value;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 const firstResult=await a.run(['wake']),first=JSON.parse(firstResult.text);assert.equal(first.total,10000);assert.ok(Buffer.byteLength(firstResult.text)<=12000);assert.ok(first.notes.length<=40);assert.ok(returned<100,`wake returned ${returned} database rows`);assert.ok(maxResult<=1);assert.equal(sourceAll,0);
 returned=0;const pending=JSON.parse((await a.run(['nap'])).text);assert.equal(pending.sources.length,8);assert.ok(returned<30);assert.equal(maxResult,8);
 a.db.prepare=originalPrepare;await a.note('Arrived after the snapshot',{id:'later'});
 const second=JSON.parse((await a.run(['wake',first.nextPart,first.snapshot,first.nextCursor])).text);assert.equal(second.snapshot,10000);assert.equal(second.total,10000);assert.ok(second.notes.every(x=>x.seq<first.notes.at(-1).seq));assert.equal(second.notes.some(x=>x.id==='later'),false);
 const expanded=JSON.parse((await a.run(['zoom','1-10000'])).text);assert.equal(expanded.notes.length,200);assert.equal(expanded.nextCursor,200);const continuation=JSON.parse((await a.run(['zoom','1-10000',expanded.nextCursor])).text);assert.equal(continuation.notes[0].seq,201);
});

test('malformed legacy sources stay intact; verified old tombstones remove remaining legacy copies',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.dir,'memory'));const file=path.join(f.dir,'memory','LOG.txt'),invalid=Buffer.from('incomplete legacy record');await writeFile(file,invalid);const a=f.open();await assert.rejects(a.init(),/complete regular/);assert.deepEqual(await readFile(file),invalid);
 const row=Buffer.alloc(320,32);row.write('#0 2026-10-05 Migrated secret');row[319]=10;await writeFile(file,row);await a.init();const note=(await a.list())[0];await a.remove(note.id);a.close();
 // Simulates an earlier release retaining the legacy file after a successful migration.
 await writeFile(file,row);await writeFile(path.join(f.dir,'memory','TREE'),'Cached old secret');const b=f.open();await b.init();assert.equal((await b.list()).length,0);await assert.rejects(readFile(file),{code:'ENOENT'});await assert.rejects(readFile(path.join(f.dir,'memory','TREE')),{code:'ENOENT'});
});

test('legacy TREE directories never block verified migration and remain untouched inactive data',async t=>{
 const f=await fixture(t),memoryDir=path.join(f.dir,'memory'),treeFile=path.join(memoryDir,'TREE','nested','unknown-cache.txt'),otherTreeFile=path.join(memoryDir,'TREE.txt','unknown.txt');await mkdir(path.dirname(treeFile),{recursive:true});await mkdir(path.dirname(otherTreeFile),{recursive:true});const cache='Synthetic unknown legacy cache retained without importing.';await writeFile(treeFile,cache);await writeFile(otherTreeFile,cache);
 const log=path.join(memoryDir,'LOG.txt'),row=Buffer.alloc(320,32);row.write('#0 2026-10-05 Verified original café');row[319]=10;await writeFile(log,row);
 const a=f.open();await a.init();assert.equal((await a.list())[0].text,'Verified original café');await assert.rejects(readFile(log),{code:'ENOENT'});assert.equal(await readFile(treeFile,'utf8'),cache);assert.equal(await readFile(otherTreeFile,'utf8'),cache);assert.deepEqual(await a.list('unknown legacy cache'),[]);
 await a.clear();a.close();const b=f.open();await b.init();assert.deepEqual(await b.list(),[]);assert.equal(await readFile(treeFile,'utf8'),cache);assert.equal(await readFile(otherTreeFile,'utf8'),cache);
});

test('invalid LOG is still rejected before cleanup when a legacy TREE directory exists',async t=>{
 const f=await fixture(t),treeFile=path.join(f.dir,'memory','TREE','keep.txt'),log=path.join(f.dir,'memory','LOG.txt');await mkdir(path.dirname(treeFile),{recursive:true});await writeFile(treeFile,'Synthetic original cache');await writeFile(log,'Incomplete original log');const a=f.open();await assert.rejects(a.init(),/complete regular/);assert.equal(await readFile(log,'utf8'),'Incomplete original log');assert.equal(await readFile(treeFile,'utf8'),'Synthetic original cache');
});

test('legacy TREE links remain rejected without following or deleting their targets',async t=>{
 const f=await fixture(t),memoryDir=path.join(f.dir,'memory'),target=path.join(f.dir,'unrelated-synthetic-data');await mkdir(memoryDir);await mkdir(target);const preserved=path.join(target,'keep.txt');await writeFile(preserved,'Synthetic unrelated original');await symlink(target,path.join(memoryDir,'TREE'),'junction');const log=path.join(memoryDir,'LOG.txt');await writeFile(log,Buffer.alloc(0));const a=f.open();await assert.rejects(a.init(),/non-regular/);assert.equal(await readFile(preserved,'utf8'),'Synthetic unrelated original');assert.equal((await readFile(log)).length,0);
});

test('review migration treats existing notes as known and keeps later arrivals new across restart',async t=>{
 const f=await fixture(t),a=f.open();await a.init();await a.note('Already known preference',{id:'existing'});
 a.db.exec("DELETE FROM migration WHERE name='memory-review-v1'; DROP INDEX notes_review; ALTER TABLE notes DROP COLUMN reviewed;");a.close();
 const b=f.open();await b.init();assert.deepEqual(await b.reviewStatus(),{unreviewedCount:0});assert.equal((await b.list())[0].reviewed,true);
 await b.note('A newly learned preference',{id:'new-note'});await b.applySyncedNote({id:'new-synced',text:'Received from another device',createdAt:'2020-01-01T00:00:00Z'});
 assert.deepEqual(await b.reviewStatus(),{unreviewedCount:2});assert.equal((await b.list('',500,{newOnly:true})).length,2);b.close();
 const c=f.open();await c.init();assert.deepEqual(await c.reviewStatus(),{unreviewedCount:2});assert.equal((await c.list('ALREADY'))[0].reviewed,true);
});

test('reviewing exact shown IDs preserves unseen arrivals, source revisions and tombstones',async t=>{
 const f=await fixture(t),a=f.open();await a.init();const shown=await a.note('Visible new note',{id:'shown'});await a.note('Arrived after the view loaded',{id:'later'});const revision=a.meta().revision;
 await a.review([shown.id,shown.id,'unknown']);assert.equal(a.meta().revision,revision);assert.deepEqual(await a.reviewStatus(),{unreviewedCount:1});assert.deepEqual((await a.list('',500,{newOnly:true})).map(note=>note.id),['later']);
 await a.note('Visible new note');assert.deepEqual(await a.reviewStatus(),{unreviewedCount:1},'Exact deduplication must not recreate an alert');
 await a.remove('later');await a.review(['later']);assert.deepEqual(await a.reviewStatus(),{unreviewedCount:0});assert.equal(await a.getNote('later'),null);
 await assert.rejects(a.review(new Array(501).fill('shown')),/500/);await assert.rejects(a.review([null]),/500/);await assert.rejects(a.review('shown'),/500/);
});
