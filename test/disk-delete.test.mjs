import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DiskSpace,scanDirectory} from '../desktop/disk-space.mjs';
import {checkDeletable,planDeletion} from '../desktop/disk-delete.mjs';
import {ScanTree} from '../desktop/disk-tree.mjs';
import {hostAction,PermissionPolicy} from '../desktop/permissions.mjs';

const exists=async file=>access(file).then(()=>true,()=>false);
async function fixture(t){
 const base=path.resolve('../Workspace/disk-space-20261019/fixtures');await mkdir(base,{recursive:true});
 const root=await mkdtemp(path.join(base,'exomina-delete-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'proj','node_modules','pkg'),{recursive:true});await mkdir(path.join(root,'keepme'));await mkdir(path.join(root,'running','bin'),{recursive:true});await mkdir(path.join(root,'.exomina-attachments','chat'),{recursive:true});
 await writeFile(path.join(root,'proj','node_modules','pkg','index.js'),Buffer.alloc(5000));await writeFile(path.join(root,'proj','main.js'),Buffer.alloc(100));await writeFile(path.join(root,'keepme','photo.jpg'),Buffer.alloc(300));await writeFile(path.join(root,'running','bin','app.exe'),Buffer.alloc(50));await writeFile(path.join(root,'.exomina-attachments','chat','a.png'),Buffer.alloc(10));
 return root;
}
async function scanned(root,extra={}){
 const result=await scanDirectory({root,appRoots:[root]});
 return {root,tree:new ScanTree(result.treeData),status:'complete',...extra};
}
const context=(scan,extra={})=>({scan,appRoots:[scan.root],privateDirs:[],protectedDirs:[],denied:[],...extra});

test('a regular cache folder and a file in a scanned folder are deletable, with sizes from the scan',async t=>{
 const root=await fixture(t),scan=await scanned(root),ctx=context(scan);
 const folder=await checkDeletable(path.join(root,'proj','node_modules'),ctx);
 assert.equal(folder.ok,true);assert.equal(folder.kind,'folder');assert.equal(folder.bytes,5000);assert.ok(folder.alloc>=5000||folder.alloc===5000);
 const file=await checkDeletable(path.join(root,'proj','main.js'),ctx);assert.equal(file.ok,true);assert.equal(file.kind,'file');assert.equal(file.bytes,100);
});

test('system, application, private, link, outside and root targets are refused with reasons',async t=>{
 const root=await fixture(t),scan=await scanned(root);
 const refuse=async(file,pattern,ctx=context(scan))=>{const result=await checkDeletable(file,ctx);assert.equal(result.ok,false,file);assert.match(result.reason,pattern,file);};
 await refuse(root,/scan root|Outside/);
 await refuse(path.parse(root).root,/Outside|root|Drive/);
 await refuse(path.join(path.dirname(root),'elsewhere'),/Outside/);
 await refuse(path.join(root,'..','..'),/Outside/);
 await refuse(path.join(root,'.exomina-attachments'),/Exomina keeps/);
 await refuse(path.join(root,'running'),/running Exomina/,context(scan,{protectedDirs:[path.join(root,'running','bin')]}));
 await refuse(path.join(root,'proj','nope'),/no longer exists/);
 await refuse('relative\\path',/full path/);
 await refuse('C:\\Windows\\System32\\x',/Outside|System managed/);
 await refuse(path.join(root,'keepme'),/private|blocked/i,context(scan,{denied:[{effect:'deny',tool:'disk_read',match:path.join(root,'keepme')}]}));
 await symlink(path.join(root,'keepme'),path.join(root,'junction'),'junction');
 await refuse(path.join(root,'junction'),/Links and junctions|not measured/);
 // System-managed locations are refused whatever the scan root is.
 const fake={root:'C:\\',tree:{find:()=>0,alloc:[1],bytes:[1],files:[1],complete:()=>true}};
 for(const file of ['C:\\Windows\\WinSxS','C:\\Program Files\\Some App','C:\\ProgramData\\Thing','C:\\pagefile.sys'])await refuse(file,/System managed|Installed application|Outside|exist/,context(fake,{appRoots:[]}));
 for(const file of ['C:\\Users','C:\\Users\\Me','C:\\Users\\Me\\Documents','C:\\Users\\Me\\AppData\\Local'])await refuse(file,/profile or personal library/,context(fake,{appRoots:[]}));
});

test('planning drops nested items, caps the batch and reports refusals separately',async t=>{
 const root=await fixture(t),scan=await scanned(root);
 const plan=await planDeletion([{path:path.join(root,'proj'),reason:'old project'},{path:path.join(root,'proj','node_modules'),reason:'deps'},{path:path.join(root,'proj','node_modules')},{path:path.join(root,'.exomina-attachments')}],context(scan));
 assert.deepEqual(plan.items.map(item=>path.basename(item.path)),['proj']);assert.equal(plan.items[0].includes,1);assert.equal(plan.refused.length,1);
});

function service(root,scanResult,overrides={}){
 const worker=Object.assign(new EventEmitter(),{terminate:async()=>0}),calls={trash:[],remove:[],approve:[]};
 const svc=new DiskSpace({appRoots:[root],enumerate:async()=>[{id:'fixture',root,label:'x',total:1e6,used:5e5,free:5e5}],workerFactory:()=>worker,
  approve:async request=>{calls.approve.push(request);return overrides.approve?overrides.approve(request):true;},
  allowedDelete:overrides.allowedDelete||(()=>true),trash:async file=>{calls.trash.push(file);await rm(file,{recursive:true,force:true});},remove:async file=>{calls.remove.push(file);await rm(file,{recursive:true,force:true});},
  protectedDirs:overrides.protectedDirs||[]});
 return {svc,worker,calls,async ready(chat){const started=await svc.start('fixture',{conversationId:chat});worker.emit('message',{type:'done',value:scanResult});return started;}};
}

test('AI deletion needs approval of the exact list, uses the Recycle Bin by default and hides removed rows',async t=>{
 const root=await fixture(t),result=await scanDirectory({root,appRoots:[root]}),h=service(root,result);t.after(()=>h.svc.close());
 const scan=await h.ready('chat-a');
 const outcome=await h.svc.call('disk_delete',{id:scan.id,items:[{path:path.join(root,'proj','node_modules'),reason:'Rebuildable dependencies of a finished project'},{path:path.join(root,'.exomina-attachments'),reason:'looks like a cache folder here'}]},'chat-a');
 assert.equal(h.calls.approve.length,1);const request=h.calls.approve[0];assert.equal(request.requireConfirmation,true);assert.equal(request.action.kind,'write');assert.equal(request.action.tool,'disk_delete');
 assert.match(request.detail,/Recycle Bin/);assert.match(request.detail,/node_modules/);assert.match(request.detail,/Rebuildable dependencies/);assert.match(request.detail,/Exomina keeps chat attachments/);
 assert.equal(h.calls.trash.length,1);assert.equal(h.calls.remove.length,0);assert.equal(outcome.deleted.length,1);assert.equal(outcome.refused.length,1);assert.equal(outcome.method,'recycle');
 assert.equal(await exists(path.join(root,'proj','node_modules')),false);assert.equal(await exists(path.join(root,'.exomina-attachments')),true);
 const view=h.svc.read({id:scan.id,view:'folders'},'chat-a');assert.equal(view.removedCount,1);
 const proj=h.svc.read({id:scan.id,node:view.rows.find(row=>row.name==='proj').id},'chat-a');assert.ok(!JSON.stringify(proj.rows).includes('node_modules'));
});

test('declined approval, another chat and blocked permission levels delete nothing',async t=>{
 const root=await fixture(t),result=await scanDirectory({root,appRoots:[root]});
 let h=service(root,result,{approve:()=>false});t.after(()=>h.svc.close());let scan=await h.ready('chat-a');
 await assert.rejects(h.svc.call('disk_delete',{id:scan.id,items:[{path:path.join(root,'proj','main.js'),reason:'test only fixture'}]},'chat-a'),/declined/);assert.equal(await exists(path.join(root,'proj','main.js')),true);
 await assert.rejects(h.svc.call('disk_delete',{id:scan.id,items:[{path:path.join(root,'proj','main.js'),reason:'test only fixture'}]},'chat-b'),/not been shared/);
 h.svc.allowedDelete=()=>false;await assert.rejects(h.svc.call('disk_delete',{id:scan.id,items:[{path:path.join(root,'proj','main.js'),reason:'test only fixture'}]},'chat-a'),/blocked/);
 assert.equal(h.calls.trash.length,0);assert.equal(await exists(path.join(root,'proj','main.js')),true);
});

test('user deletion needs no chat, supports permanent removal and verifies items are gone',async t=>{
 const root=await fixture(t),result=await scanDirectory({root,appRoots:[root]}),h=service(root,result);t.after(()=>h.svc.close());const scan=await h.ready();
 const preview=await h.svc.preview({id:scan.id,items:[{path:path.join(root,'keepme')},{path:path.join(root,'running')}]});assert.equal(preview.items.length,2);assert.ok(preview.alloc>0);
 const outcome=await h.svc.remove({id:scan.id,items:[{path:path.join(root,'keepme')}],method:'permanent'},null,{local:true});
 assert.equal(h.calls.approve.length,0);assert.equal(h.calls.remove.length,1);assert.equal(h.calls.trash.length,0);assert.equal(outcome.deleted.length,1);assert.equal(await exists(path.join(root,'keepme')),false);
 await assert.rejects(h.svc.remove({id:scan.id,items:[],method:'shred'},null,{local:true}),/Recycle Bin or permanent/);
 const again=await h.svc.remove({id:scan.id,items:[{path:path.join(root,'keepme')}]},null,{local:true});assert.equal(again.deleted.length,0);assert.match(again.refused[0].reason,/no longer exists/);
});

test('protected program folders cannot be deleted even when they contain the selection',async t=>{
 const root=await fixture(t),result=await scanDirectory({root,appRoots:[root]}),h=service(root,result,{protectedDirs:[path.join(root,'running','bin')]});t.after(()=>h.svc.close());const scan=await h.ready();
 const outcome=await h.svc.remove({id:scan.id,items:[{path:path.join(root,'running')},{path:path.join(root,'running','bin','app.exe')}]},null,{local:true});
 assert.equal(outcome.deleted.length,1);assert.equal(outcome.refused.length,1);assert.match(outcome.refused[0].reason,/running Exomina/);assert.equal(await exists(path.join(root,'running')),true);
});

test('deleting is classified as a write: read-only blocks it and nothing makes it automatic',()=>{
 assert.equal(hostAction('disk_delete',{id:'x'}).kind,'write');assert.equal(hostAction('disk_read',{id:'x'}).kind,'read');
 const readOnly=new PermissionPolicy({getSettings:()=>({permissionMode:'read-only',permissionRules:[]})});
 assert.equal(readOnly.evaluate(hostAction('disk_delete',{id:'x'})).decision,'deny');
 const ask=new PermissionPolicy({getSettings:()=>({permissionMode:'ask',permissionRules:[]})});
 assert.equal(ask.evaluate(hostAction('disk_delete',{id:'x'})).decision,'ask');
});

test('Recycle Bin move passes the path in the environment, never in the command, and reports failures',async()=>{
 const {recycleItem}=await import('../desktop/disk-delete.mjs');
 const seen=[];
 const fake=code=>(command,args,options)=>{seen.push({command,args,options});const child=Object.assign(new EventEmitter(),{stderr:Object.assign(new EventEmitter(),{setEncoding(){}}),kill(){}});setImmediate(()=>{if(code)child.stderr.emit('data','Exception: sharing violation');child.emit('close',code);});return child;};
 const hostile="C:\\x'; Remove-Item C:\\ -Recurse #\\file.txt";
 await recycleItem(hostile,{spawnImpl:fake(0),platform:'win32'});
 assert.equal(seen[0].options.env.EXOMINA_RECYCLE_PATH,hostile);assert.ok(!seen[0].args.join(' ').includes('Remove-Item'));assert.match(seen[0].args.join(' '),/SendToRecycleBin/);assert.equal(seen[0].options.windowsHide,true);
 await assert.rejects(recycleItem(hostile,{spawnImpl:fake(1),platform:'win32'}),/sharing violation/);
 await assert.rejects(recycleItem(hostile,{platform:'linux'}),/only available on Windows/);
});

test('review fixes: running program files, streams, per-item permission rules and swapped items are all refused',async t=>{
 const root=await fixture(t),result=await scanDirectory({root,appRoots:[root]});
 const scan={root,tree:new ScanTree(result.treeData),status:'complete'},base={scan,appRoots:[root],privateDirs:[],protectedDirs:[],denied:[]};
 // Descendants of the running program are refused, not just its ancestors.
 const blocked=await checkDeletable(path.join(root,'running','bin','app.exe'),{...base,protectedTrees:[path.join(root,'running')]});assert.equal(blocked.ok,false);assert.match(blocked.reason,/running Exomina program/);
 // Alternate data streams and device-style paths are not supported.
 for(const file of [path.join(root,'proj','main.js')+':hidden','\\\\.\\C:\\x'])assert.equal((await checkDeletable(file,base)).ok,false,file);
 // A deny or ask rule on one location blocks that item even if the scan root as a whole is allowed.
 const partial=await checkDeletable(path.join(root,'keepme'),{...base,canDelete:file=>!file.toLowerCase().includes('keepme')});assert.equal(partial.ok,false);assert.match(partial.reason,/permission rules/);
 assert.equal((await checkDeletable(path.join(root,'proj','main.js'),{...base,canDelete:file=>!file.toLowerCase().includes('keepme')})).ok,true);
 // The approved object must still be the same object when the deletion runs.
 const {executeDeletion}=await import('../desktop/disk-delete.mjs'),plan=await planDeletion([{path:path.join(root,'proj','main.js'),reason:'fixture only'}],base);
 plan.items[0].identity='0:1';let trashed=0;
 const outcome=await executeDeletion(plan,{method:'recycle',trash:async()=>{trashed++;},context:base});
 assert.equal(trashed,0);assert.equal(outcome.deleted.length,0);assert.match(outcome.failed[0].error,/replaced by a different item/);
});
