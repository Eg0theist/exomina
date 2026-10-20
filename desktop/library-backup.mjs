import {mkdir,readFile,writeFile,lstat,realpath,open,rename,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import path from 'node:path';
import {jsonExportChunks} from './data-export.mjs';
import {validateState} from './durable-state.mjs';
import {libraryRestoreLauncher} from './library-launcher.mjs';

const FORMAT='exomina-library-backup';
const DATABASES=['memory/notes.sqlite','chat-memory/tree.sqlite','archive.sqlite'];
const hex=/^[a-f0-9]{64}$/;
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const safeRelative=value=>typeof value==='string'&&value.length<400&&!value.includes('\\')&&!value.includes(':')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\x00-\x1f]/.test(p));
async function regular(file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Backup files must be regular files without links.');return s;}
async function safeFile(root,relative){
 if(!safeRelative(relative))throw Error('Invalid backup path.');
 const base=await realpath(root),file=path.join(base,...relative.split('/'));let current=base;
 for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Backup folders cannot contain links.');}
 if(!within(key(base),key(await realpath(file))))throw Error('Backup path left its folder.');await regular(file);return file;
}
async function hashFile(file){const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(file)){size+=chunk.length;hash.update(chunk);}return {bytes:size,sha256:hash.digest('hex')};}
async function jsonFile(file,value){await mkdir(path.dirname(file),{recursive:true});const f=await open(file,'wx',0o600);let buffer='';try{for(const chunk of jsonExportChunks(value)){if(buffer.length+chunk.length>65536&&buffer){await f.writeFile(buffer,'utf8');buffer='';}if(chunk.length>=65536)await f.writeFile(chunk,'utf8');else buffer+=chunk;}if(buffer)await f.writeFile(buffer,'utf8');await f.sync();}finally{await f.close();}}
async function copyChecked(source,target,expected){const before=await regular(source);await mkdir(path.dirname(target),{recursive:true});const input=await open(source,'r');let output;const hash=createHash('sha256'),buf=Buffer.alloc(1024*1024);let bytes=0;try{const opened=await input.stat();if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino)throw Error('A backup source changed while opening.');output=await open(target,'wx',0o600);while(true){const {bytesRead}=await input.read(buf,0,buf.length,null);if(!bytesRead)break;const chunk=buf.subarray(0,bytesRead);bytes+=bytesRead;hash.update(chunk);await output.writeFile(chunk);}const sha256=hash.digest('hex');if(expected&&(expected.bytes!==bytes||expected.sha256!==sha256))throw Error('Backup integrity check failed while copying: '+path.basename(source));await output.sync();return {bytes,sha256};}finally{await input.close();await output?.close();}}

/** Restore policy never imports execution grants, accounts, remote pairings or
 * queued jobs. Domain content keeps its IDs, history, notebook and provenance. */
export function backupState(state,{workspace}={}){
 state=structuredClone(state);
 const settings={provider:state.settings?.provider||'codex',permissionMode:'ask',permissionRules:[],desktopEnabled:false,browserEnabled:false,memoryEnabled:state.settings?.memoryEnabled!==false,chatMemoryEnabled:true,chatMemorySummaries:false,chatMemoryBackfill:false,memoryCapture:state.settings?.memoryCapture||'automatic',autoTitle:state.settings?.autoTitle!==false};
 for(const field of ['appearance','personalization','voice','sounds','spellcheck','tutorialProgress','interfaceView'])if(state.settings?.[field]!==undefined)settings[field]=structuredClone(state.settings[field]);
 if(workspace)settings.workspace=workspace;
 const conversations=(state.conversations||[]).filter(c=>!c.private).map(c=>{
  const rest=Object.fromEntries(['id','title','titleSource','pinned','pinnedOrder','archived','provider','updatedAt','createdAt','projectId','personalization','taskGuide','selection','branch','parentId'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]));
  if(c.approachRefinements)rest.approachRefinements=c.approachRefinements.filter(r=>['adopted','rejected','retired'].includes(r.status));
  return {...rest,sessions:{},permissionMode:'ask',messages:c.messages.map(m=>{
   const {questions,followups}=m,message=Object.fromEntries(['id','role','content','provider','model','effort','speed','lane','error','continuationError','createdAt','startedAt','finishedAt','attachments','activity','segments','helpers','helpersOmitted','escalated'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
   return {...message,...(questions?{questions:questions.map(q=>({...q,status:['waiting','open'].includes(q.status)?'cancelled':q.status}))}:{}),...(followups?{followups:followups.map(q=>({...q,status:['running','queued','waiting'].includes(q.status)?'interrupted':q.status,...(['pending','working'].includes(q.taskStatus)?{taskStatus:'blocked',summary:'Interrupted by library transfer; continue explicitly from this chat.'}:{})}))}:{})};
  })};
 });
 const result={settings,conversations,projects:structuredClone(state.projects||[]),prompts:structuredClone(state.prompts||[]),schedules:(state.schedules||[]).map(s=>({...s,enabled:false,recipient:'',delivery:'desktop'}))};
 for(const project of result.projects){project.folder='';project.files=[];}
 if(state.scratchpad){const {notes,handled,organization}=state.scratchpad;result.scratchpad={notes:structuredClone(notes||[]),handled:structuredClone(handled||[]),jobs:[],settings:{enabled:false},...(organization?{organization:{...structuredClone(organization),autoRefresh:false,refreshConfigured:false}}:{})};}
 return result;
}

export async function createLibraryBackup({dataDir,state,uploads={},assets,folder,version='unknown'}){
 const parent=await realpath(folder);if(within(key(dataDir),key(parent)))throw Error('Choose a backup folder outside Exomina’s private data folder.');
 const stage=path.join(parent,'.exomina-backup-'+randomUUID()),destination=path.join(parent,'Exomina-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
 await mkdir(stage,{mode:0o700});const manifest={format:FORMAT,version:1,appVersion:version,createdAt:new Date().toISOString(),files:[],counts:{chats:0,messages:0,attachments:0},warnings:[],omitted:['provider sign-ins','accounts','remote pairings','permission grants','queued or scheduled execution','project file contents']};
 async function add(relative){manifest.files.push({path:relative,...await hashFile(path.join(stage,...relative.split('/')))});}
 try{
  const portable=backupState(state);manifest.counts.chats=portable.conversations.length;manifest.counts.messages=portable.conversations.reduce((n,c)=>n+c.messages.length,0);
  await jsonFile(path.join(stage,'state.json'),portable);await add('state.json');
  for(const relative of DATABASES){
   const source=path.join(dataDir,...relative.split('/'));try{await regular(source);}catch(e){if(e.code==='ENOENT')throw Error('A required library database is missing: '+relative);throw e;}
   const target=path.join(stage,...relative.split('/'));await mkdir(path.dirname(target),{recursive:true});const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);}finally{db.close();}await add(relative);
  }
  const assetIds=new Set(),uploadIds=new Set();for(const c of portable.conversations)for(const m of c.messages)for(const a of m.attachments||[]){if(a.uploadId)uploadIds.add(a.uploadId);if(hex.test(a.id)&&a.kind!=='file')assetIds.add(a.id);}
  const art=portable.settings.appearance?.companionArtwork;if(hex.test(art?.id||''))assetIds.add(art.id);
  const assetRows=[];for(const id of assetIds){const record=await assets?.get(id);if(!record)throw Error('A referenced image or video is missing: '+id);const relative='assets/'+id+'.asset';await mkdir(path.join(stage,'assets'),{recursive:true});await writeFile(path.join(stage,...relative.split('/')),Buffer.from(record.dataBase64,'base64'),{flag:'wx',mode:0o600});await add(relative);assetRows.push({id,mimeType:record.mimeType,bytes:record.bytes,sha256:record.sha256});manifest.counts.attachments++;}
  await jsonFile(path.join(stage,'asset-index.json'),assetRows);await add('asset-index.json');
  const uploadRows={};for(const id of uploadIds){const record=uploads[id];if(!record)throw Error('An uploaded attachment is missing: '+id);const a=record.attachment,relative=String(a.relativePath||'').replaceAll('\\','/');if(!relative.startsWith('.exomina-attachments/')||!safeRelative(relative))throw Error('Invalid upload path.');const source=await safeFile(record.workspace,relative),target='uploads/'+id;if(!/^[\w-]{1,100}$/.test(id))throw Error('Invalid upload ID.');await copyChecked(source,path.join(stage,...target.split('/')));await add(target);const digest=await hashFile(path.join(stage,...target.split('/')));if(digest.sha256!==a.sha256||digest.bytes!==a.bytes)throw Error('An uploaded attachment changed during backup.');uploadRows[id]={attachment:{...a,relativePath:relative},text:record.text??null};manifest.counts.attachments++;}
  await jsonFile(path.join(stage,'chat-uploads.json'),uploadRows);await add('chat-uploads.json');
  await jsonFile(path.join(stage,'manifest.json'),manifest);await rename(stage,destination);return {path:destination,...manifest};
 }catch(e){await rm(stage,{recursive:true,force:true});throw e;}
}

const allowed=relative=>['state.json','asset-index.json','chat-uploads.json',...DATABASES].includes(relative)||/^assets\/[a-f0-9]{64}\.asset$/.test(relative)||/^uploads\/[\w-]{1,100}$/.test(relative);
export async function inspectLibraryBackup(folder){
 const root=await realpath(folder),file=await safeFile(root,'manifest.json');if((await regular(file)).size>16*1024*1024)throw Error('Backup manifest is too large.');
 const manifestBytes=await readFile(file),manifest=JSON.parse(manifestBytes.toString('utf8'));if(manifest.format!==FORMAT||manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length>100000)throw Error('Unsupported Exomina backup.');
 const seen=new Set();for(const entry of manifest.files){if(!allowed(entry.path)||seen.has(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!hex.test(entry.sha256))throw Error('Invalid backup inventory.');seen.add(entry.path);const source=await safeFile(root,entry.path);const actual=await hashFile(source);if(actual.bytes!==entry.bytes||actual.sha256!==entry.sha256)throw Error('Backup integrity check failed: '+entry.path);}
 for(const name of ['state.json','asset-index.json','chat-uploads.json',...DATABASES])if(!seen.has(name))throw Error('Backup is incomplete: '+name);
 return {root,manifest,receipt:createHash('sha256').update(manifestBytes).digest('hex')};
}

/** Writes a new isolated profile. No existing profile is overwritten. */
export async function restoreLibraryBackup({folder,destination,executable,expectedReceipt}){
 const {root:sourceRoot,manifest,receipt}=await inspectLibraryBackup(folder),parent=await realpath(destination),name='Exomina-restored-'+randomUUID().slice(0,8),stage=path.join(parent,'.'+name),target=path.join(parent,name),profile=path.join(stage,'Profile'),workspace=path.join(target,'Workspace'),root=path.join(stage,'verified');
 if(expectedReceipt&&receipt!==expectedReceipt)throw Error('The backup changed after you reviewed it. Choose it again.');
 if(within(key(sourceRoot),key(parent)))throw Error('Choose a restore destination outside the backup folder.');
 await mkdir(stage,{mode:0o700});await mkdir(profile);await mkdir(root);
 try{
  // Only the verified copies below may be parsed or installed. Hashing happens
  // while the exact destination bytes are copied, closing the review/copy race.
  for(const entry of manifest.files)await copyChecked(await safeFile(sourceRoot,entry.path),path.join(root,...entry.path.split('/')),entry);
  for(const entry of manifest.files.filter(e=>DATABASES.includes(e.path)||e.path.startsWith('assets/')))await copyChecked(await safeFile(root,entry.path),path.join(profile,...entry.path.split('/')));
  // Verify database structure and integrity before the new profile is published.
  for(const relative of DATABASES.filter(r=>manifest.files.some(f=>f.path===r))){const db=new DatabaseSync(path.join(profile,...relative.split('/')),{readOnly:true});try{db.exec('PRAGMA trusted_schema=OFF');if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('A backup database failed its integrity check.');}finally{db.close();}}
  const sourceState=validateState(JSON.parse(await readFile(await safeFile(root,'state.json'),'utf8'))),state=backupState(sourceState,{workspace});await jsonFile(path.join(profile,'state.json'),state);
  const assetRows=JSON.parse(await readFile(await safeFile(root,'asset-index.json'),'utf8'));if(!Array.isArray(assetRows))throw Error('Invalid asset index.');
  await mkdir(path.join(profile,'assets'),{recursive:true});const db=new DatabaseSync(path.join(profile,'assets/index.sqlite'));try{db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,mimeType TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL)');const put=db.prepare('INSERT INTO assets VALUES(?,?,?,?)');for(const a of assetRows){if(!hex.test(a.id)||a.sha256!==a.id||!manifest.files.some(f=>f.path==='assets/'+a.id+'.asset'&&f.sha256===a.sha256&&f.bytes===a.bytes))throw Error('Invalid asset record.');put.run(a.id,a.mimeType,a.bytes,a.sha256);}}finally{db.close();}
  const uploads=JSON.parse(await readFile(await safeFile(root,'chat-uploads.json'),'utf8'));if(!uploads||Array.isArray(uploads)||typeof uploads!=='object')throw Error('Invalid upload index.');await mkdir(path.join(stage,'Workspace'));
  for(const [id,record]of Object.entries(uploads)){if(!/^[\w-]{1,100}$/.test(id))throw Error('Invalid upload record.');const relative=record.attachment?.relativePath,entry=manifest.files.find(f=>f.path==='uploads/'+id);if(!safeRelative(relative)||!relative.startsWith('.exomina-attachments/')||!entry||entry.bytes!==record.attachment.bytes||entry.sha256!==record.attachment.sha256)throw Error('Invalid or uninventoried attachment.');await copyChecked(await safeFile(root,'uploads/'+id),path.join(stage,'Workspace',...relative.split('/')),entry);record.workspace=workspace;}
  for(const chat of state.conversations)for(const message of chat.messages)for(const attachment of message.attachments||[]){if(attachment.uploadId&&!uploads[attachment.uploadId])throw Error('Conversation references a missing upload.');if(attachment.kind!=='file'&&!assetRows.some(a=>a.id===attachment.id))throw Error('Conversation references a missing asset.');}
  await jsonFile(path.join(profile,'chat-uploads.json'),uploads);await mkdir(path.join(stage,'Accounts'));
  // A visible, inspectable launcher keeps this restored library easy to open.
  const launcher=executable?libraryRestoreLauncher({target,workspace,executable}):null;
  if(launcher)await writeFile(path.join(stage,launcher.name),launcher.text,{encoding:'utf8',mode:launcher.mode});
  await writeFile(path.join(stage,'RESTORE.txt'),`${launcher?.name||'The restored profile'} opens this separate restored library. Sign in to providers on this device. Projects keep their instructions; choose their working folders again. Schedules and note work are paused. Your previous library has not been changed.\n`,'utf8');
  if(!within(key(stage),key(await realpath(root))))throw Error('Staged verification files left the restore folder.');await rm(root,{recursive:true,force:true});await rename(stage,target);return {path:target,profile:path.join(target,'Profile'),workspace,launcher:launcher?.name,counts:manifest.counts,verifiedFiles:manifest.files.length};
 }catch(e){await rm(stage,{recursive:true,force:true});throw e;}
}
