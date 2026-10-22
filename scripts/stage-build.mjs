// Local package promotion has fixed transaction slots, never dated full backups.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat,mkdir,open,rename,unlink,rmdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractFile,uncache} from '@electron/asar';
import {plainPath} from '../desktop/update-source.mjs';

const project=path.resolve(import.meta.dirname,'..');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(parent,child)=>{const rel=path.relative(parent,child);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
const exists=async file=>{try{await lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const hash=async file=>{const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');};
export function stagingPaths(root=project){
  root=path.resolve(root);const release=path.join(root,'release'),work=path.join(release,'.staging');
  return {root,release,work,stage:path.join(release,'win-unpacked'),candidate:path.join(work,'candidate','win-unpacked'),previous:path.join(work,'previous'),journal:path.join(work,'transaction.json'),lock:path.join(release,'.staging.lock')};
}
async function plainDirectory(dir){await plainPath(dir);if(!(await lstat(dir)).isDirectory())throw Error('Expected a plain directory: '+dir);}
export async function withStagingLock(root,action){
  const p=stagingPaths(root);await plainPath(p.release);await mkdir(p.release,{recursive:true});
  let lock;
  try{lock=await open(p.lock,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Another build/stage owns '+p.lock+'. If interrupted, confirm its recorded PID has exited before removing this lock.');throw e;}
  try{await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),'utf8');await plainPath(p.work);await mkdir(p.work,{recursive:true});return await action(p);}
  finally{await lock.close();await unlink(p.lock);}
}
export async function packageInventory(directory){
  await plainDirectory(directory);const files=[],directories=[];
  const walk=async relative=>{
    for(const name of (await readdir(path.join(directory,relative))).sort()){
      const rel=relative?relative+'/'+name:name,file=path.join(directory,...rel.split('/')),info=await lstat(file);
      if(info.isSymbolicLink()||info.isFile()&&info.nlink!==1)throw Error('Linked package entries are not allowed: '+rel);
      if(!relative&&info.isDirectory()&&!['resources','locales','exomina-source'].includes(name))throw Error('Unexpected package directory; retained: '+rel);
      if(info.isDirectory()){directories.push(rel);await walk(rel);}
      else if(info.isFile()){
        if(files.length>=60000)throw Error('Package inventory limit exceeded.');
        // The root Chromium log is mutable and is never used as build evidence.
        files.push({path:rel,size:info.size,sha256:rel.toLowerCase()==='debug.log'?null:await hash(file)});
      }else throw Error('Unsupported package entry: '+rel);
    }
  };
  await walk('');return {files,directories};
}
function comparable(inventory){return {...inventory,files:inventory.files.filter(f=>f.path.toLowerCase()!=='debug.log')};}
export async function inspectPackage(directory,{expectedId}={}){
  const inventory=await packageInventory(directory);
  const build=await json(path.join(directory,'exomina.build.json'));
  if(typeof build.id!=='string'||!/^[-\w]{8,64}$/.test(build.id)||typeof build.version!=='string'||!Number.isFinite(Date.parse(build.builtAt)))throw Error('Invalid package build identity.');
  if(expectedId&&build.id!==expectedId)throw Error('Candidate build identity changed.');
  for(const file of ['Exomina.exe','resources/app.asar'])if(!inventory.files.some(f=>f.path===file&&f.size>0))throw Error('Incomplete package: '+file);
  // A promotion replaces the archive at a pathname already inspected above.
  // ASAR caches header offsets by pathname, so discard the previous header.
  const archive=path.join(directory,'resources','app.asar');uncache(archive);
  const packaged=JSON.parse(extractFile(archive,'package.json'));
  const metadata=await json(path.join(directory,'resources','app.asar.unpacked','desktop','app-version.json'));
  if(packaged.version!==build.version||metadata.version!==build.version)throw Error('Package versions do not match.');
  return {build,inventory};
}
export async function assertPackageIdle(directory){
  if(process.platform!=='win32')return;
  // Emit only a boolean, never other processes' paths or command lines.
  const {stdout}=await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),[
    '-NoProfile','-NonInteractive','-File',path.join(project,'scripts','stage-build-idle.ps1'),'-Directory',directory
  ],{windowsHide:true,encoding:'utf8',timeout:30000});
  if(stdout.trim()!=='idle')throw Error('A package is in use or its process state could not be checked; retained: '+directory);
}
async function candidateBoundary(p,candidate,{mustExist=true}={}){
  const workspace=path.join(path.dirname(p.root),'Workspace');
  if(!same(candidate,p.candidate)&&!(inside(workspace,candidate)&&path.basename(candidate)==='win-unpacked'&&path.basename(path.dirname(candidate))==='candidate'))throw Error('Candidate must be a managed staging slot or a Workspace task candidate/win-unpacked.');
  if(inside(candidate,p.stage)||inside(p.stage,candidate)||same(candidate,p.stage))throw Error('Candidate overlaps the current stage.');
  await plainPath(candidate);
  if(mustExist)await plainDirectory(candidate);
}
async function saveJournal(p,value){
  await plainPath(p.journal);const temp=p.journal+'.tmp';await plainPath(temp);
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});await rename(temp,p.journal);
}
async function removePrevious(p,inventory,idle){
  // The only directory this module can remove is this exact transaction slot.
  assert.equal(path.dirname(p.previous),p.work);assert.equal(path.basename(p.previous),'previous');
  await plainDirectory(p.previous);await idle(p.previous);
  const current=await packageInventory(p.previous),approved=new Map(inventory.files.map(f=>[f.path,f]));
  for(const dir of current.directories)if(!inventory.directories.includes(dir))throw Error('Unexpected directory in previous stage; retained.');
  for(const file of current.files){
    const expected=approved.get(file.path);
    if(!expected||file.sha256!==expected.sha256||file.sha256!==null&&file.size!==expected.size)throw Error('Previous stage changed; retained.');
  }
  // Remaining-subset verification also permits retry after a partially locked deletion.
  for(const file of current.files){const target=path.join(p.previous,...file.path.split('/'));await plainPath(target);await unlink(target);}
  for(const dir of current.directories.sort((a,b)=>b.split('/').length-a.split('/').length)){const target=path.join(p.previous,...dir.split('/'));await plainPath(target);await rmdir(target);}
  await rmdir(p.previous);
}
async function finishCleanup(p,transaction,idle){
  try{
    if(await exists(p.previous))await removePrevious(p,transaction.previous.inventory,idle);
    await unlink(p.journal);
    return {status:'removed',bytes:transaction.previous?.inventory.files.reduce((sum,f)=>sum+f.size,0)||0};
  }catch(error){return {status:'deferred',reason:error.message};}
}
export async function stageBuild({root=project,candidate,expectedId,verify=async()=>{},idle=assertPackageIdle,locked=false}={}){
  const promote=async p=>{
    if(await exists(p.journal)||await exists(p.previous))throw Error('An unfinished staging transaction exists. Run npm run stage -- --recover before another build.');
    candidate=path.resolve(candidate||p.candidate);await candidateBoundary(p,candidate);
    const next=await inspectPackage(candidate,{expectedId});await verify(candidate,next);
    const previous=await exists(p.stage)?await inspectPackage(p.stage):null;
    if(previous){await idle(p.stage);if(previous.build.id===next.build.id)throw Error('This build is already staged.');}
    await idle(candidate);
    const transaction={schema:1,phase:'prepared',candidate,next,previous,startedAt:new Date().toISOString()};
    await saveJournal(p,transaction);
    let movedPrevious=false,movedCandidate=false;
    try{
      if(previous){await rename(p.stage,p.previous);movedPrevious=true;}
      await rename(candidate,p.stage);movedCandidate=true;
      const published=await inspectPackage(p.stage,{expectedId:next.build.id});
      assert.deepEqual(comparable(published.inventory),comparable(next.inventory),'Published package changed.');
      await verify(p.stage,published);
    }catch(error){
      // Retain both inputs and the journal if restoration itself fails.
      if(movedCandidate)await rename(p.stage,candidate);
      if(movedPrevious)await rename(p.previous,p.stage);
      await unlink(p.journal);throw error;
    }
    transaction.phase='published';await saveJournal(p,transaction);
    const cleanup=await finishCleanup(p,transaction,idle);
    const result={schema:1,build:next.build,stage:p.stage,cleanup,finishedAt:new Date().toISOString()};
    await plainPath(path.join(p.release,'last-staging.json'));await writeFile(path.join(p.release,'last-staging.json'),JSON.stringify(result,null,2)+'\n','utf8');
    return result;
  };
  if(locked){
    const p=stagingPaths(root);await plainPath(p.lock);
    if((await json(p.lock)).pid!==process.pid)throw Error('The package pipeline does not own the staging lock.');
    return promote(p);
  }
  return withStagingLock(root,promote);
}
export async function recoverStaging({root=project,idle=assertPackageIdle}={}){
  return withStagingLock(root,async p=>{
    await plainPath(p.journal);const transaction=await json(p.journal);
    if(transaction.schema!==1||!['prepared','published'].includes(transaction.phase))throw Error('Unknown staging transaction; retained.');
    await candidateBoundary(p,path.resolve(transaction.candidate),{mustExist:false});
    if(transaction.phase==='published'){
      const current=await inspectPackage(p.stage,{expectedId:transaction.next.build.id});assert.deepEqual(comparable(current.inventory),comparable(transaction.next.inventory));
      return {build:current.build,cleanup:await finishCleanup(p,transaction,idle)};
    }
    // A crash before commit always restores the old stage. No package is deleted.
    if(await exists(p.previous)){
      const previous=await inspectPackage(p.previous,{expectedId:transaction.previous.build.id});assert.deepEqual(comparable(previous.inventory),comparable(transaction.previous.inventory));
      await idle(p.previous);
      if(await exists(p.stage)){
        if(await exists(transaction.candidate))throw Error('Both candidate and current stage exist; inspect transaction manually.');
        await inspectPackage(p.stage,{expectedId:transaction.next.build.id});await idle(p.stage);await plainPath(transaction.candidate);await rename(p.stage,transaction.candidate);
      }
      await rename(p.previous,p.stage);
    }else if(transaction.previous){await inspectPackage(p.stage,{expectedId:transaction.previous.build.id});}
    else if(await exists(p.stage)){if(await exists(transaction.candidate))throw Error('Ambiguous first-stage recovery.');await inspectPackage(p.stage,{expectedId:transaction.next.build.id});await idle(p.stage);await plainPath(transaction.candidate);await rename(p.stage,transaction.candidate);}
    await unlink(p.journal);return {status:'restored',candidate:transaction.candidate};
  });
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(['--candidate','--expected-id'].includes(args[i])&&args[i+1])options[args[i]==='--candidate'?'candidate':'expectedId']=args[++i];
    else if(args[i]==='--check')options.check=true;
    else if(args[i]==='--recover')options.recover=true;
    else throw Error('Use stage-build.mjs [--candidate path] [--expected-id id] [--check | --recover].');
  }
  if(options.check){const result=await inspectPackage(path.resolve(options.candidate||stagingPaths().stage),options);console.log(JSON.stringify({build:result.build,files:result.inventory.files.length,bytes:result.inventory.files.reduce((n,f)=>n+f.size,0),policy:'Remove the superseded stage after validation; preserve installed App and rollback.'}));}
  else console.log(JSON.stringify(await (options.recover?recoverStaging():stageBuild(options))));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
