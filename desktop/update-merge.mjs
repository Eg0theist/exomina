import {readFile,writeFile,mkdir,cp,rename,lstat,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
// Electron's fs presents .asar archives as folders; program inventories must hash the archive bytes.
const rawFs=process.versions.electron?createRequire(import.meta.url)('original-fs').promises:{readFile,lstat,readdir};
import {SOURCE_FOLDER,sourceTree,readSnapshot,writeTree,treeHash,digest,plainPath,sourcePath} from './update-source.mjs';

const json=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}};
const equal=(a,b)=>a===undefined&&b===undefined||a!==undefined&&b!==undefined&&a.equals(b);
const text=bytes=>bytes&&!bytes.includes(0)&&Buffer.from(bytes.toString('utf8')).equals(bytes);
export async function mergeFile(base,local,incoming,{directory,run=runProcess}={}){
  if(equal(local,base))return {bytes:incoming};if(equal(incoming,base)||equal(local,incoming))return {bytes:local};
  if(!base||!local||!incoming||![base,local,incoming].every(text))return {conflict:true,bytes:local,reason:'Both versions changed, added or deleted this file.'};
  const folder=path.join(directory,randomUUID());await mkdir(folder,{recursive:true});
  const names=['local','base','release'];await Promise.all(names.map((name,i)=>writeFile(path.join(folder,name),[local,base,incoming][i])));
  try{const result=await run('git',['merge-file','-p','--diff3','-L','Your version','-L','Previous official release','-L','New official release',...names.map(name=>path.join(folder,name))],{cwd:folder,timeout:30000,outputLimit:128*1024**2,truncate:false});
    if(result.code===0)return {bytes:Buffer.from(result.stdout)};
    if(result.code>0&&result.code<128)return {conflict:true,bytes:Buffer.from(result.stdout),reason:'Overlapping text changes need review.'};
  }catch{}
  return {conflict:true,bytes:local,reason:'Automatic text merge unavailable; resolve with the three saved versions.'};
}
export function runProcess(command,args,{cwd,env=process.env,timeout=30*60*1000,outputLimit=2*1024**2,truncate=true,signal}={}){
  return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),settled=false;
    const stop=message=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(process.platform==='win32'&&child.pid)spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();reject(Error(message));};
    const abort=()=>stop('Update checks cancelled.');const timer=setTimeout(()=>stop('Update check timed out.'),timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const append=(old,bytes)=>{const value=Buffer.concat([old,bytes]);if(value.length<=outputLimit)return value;if(!truncate){stop('Merge output exceeds its capture limit.');return old;}return value.subarray(value.length-outputLimit);};
    child.stdout.on('data',bytes=>{stdout=append(stdout,bytes);});child.stderr.on('data',bytes=>{stderr=append(stderr,bytes);});child.once('error',e=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')});});});
}

/** Plans and check receipts live outside the editable workspace. No user code runs at prepare time. */
export class UpdateMerge {
  constructor({home,appDir,stateDir,run=runProcess,emit=()=>{},powershell='powershell.exe'}){Object.assign(this,{home,appDir,stateDir,run,emit,powershell});this.workspaceRoot=home&&path.join(home,'Workspace','.exomina-updates');this.record=stateDir&&path.join(stateDir,'merge-plan.json');}
  async save(plan){await plainPath(this.record);await mkdir(this.stateDir,{recursive:true});const temporary=this.record+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(plan),{flag:'wx',mode:0o600});await rename(temporary,this.record);this.emit({type:'state.changed'});return plan;}
  async plan(){await plainPath(this.record);const plan=await json(this.record);if(!plan)return null;if(!/^[a-f0-9-]{36}$/i.test(plan.id)||plan.workspace!==path.join(this.workspaceRoot,plan.id,'source')||plan.buildPath!==path.join(plan.workspace,'release','win-unpacked'))throw Error('Invalid update merge workspace.');await plainPath(plan.workspace);return plan;}
  async inspect({source,buildPath,staged,installed}){
    const plan=await this.plan();
    if(plan?.release?.id===staged?.id&&plan.installedId===installed?.id){const stale=plan.phase==='verified'&&(treeHash(await sourceTree(plan.workspace))!==plan.verifiedHash||treeHash(await sourceTree(path.join(this.home,'Source')))!==plan.originalHash);return {required:true,phase:stale?'changed':plan.phase,id:plan.id,workspace:plan.workspace,conflicts:plan.conflicts,changes:plan.changes,checks:plan.checks,error:stale?'Source changed after verification. Verify again or prepare a fresh merge.':plan.error};}
    const current=await sourceTree(path.join(this.home,'Source'));
    if(!current.size)return {required:false,phase:'no-source'};
    const baseline=await readSnapshot(path.join(this.appDir,SOURCE_FOLDER)).catch(()=>null);
    // Local builds are explicitly authored packages. Legacy installations have no official source baseline.
    if(!baseline)return {required:source==='public',phase:'baseline-missing',message:'This installation has no verified official source baseline. A global update cannot safely merge its source edits. Install an official baseline once while preserving your source copy.'};
    if(baseline.manifest.release.id!==(installed?.officialId||installed?.id))throw Error('The installed source baseline belongs to another release.');
    const changes=treeHash(current)!==baseline.manifest.treeHash;
    if(source==='local')return {required:false,phase:'local-build',customized:changes};
    return {required:changes,phase:changes?'customized':'clean',message:changes?'Your source differs from its official baseline. Prepare and verify a merged update before applying.':''};
  }
  async prepare({buildPath,staged,installed}){
    if(this.working||this.verifying)throw Error('An update merge is already running.');this.working=true;
    try{
      const base=await readSnapshot(path.join(this.appDir,SOURCE_FOLDER)),next=await readSnapshot(path.join(buildPath,SOURCE_FOLDER));
      if(base.manifest.release.id!==(installed?.officialId||installed?.id)||next.manifest.release.id!==(staged?.officialId||staged?.id))throw Error('The source baseline does not match these builds.');
      const original=await sourceTree(path.join(this.home,'Source')),id=randomUUID(),folder=path.join(this.workspaceRoot,id),workspace=path.join(folder,'source');
      await plainPath(folder);const merged=new Map(),conflicts=[],changes=[];
      for(const file of new Set([...base.files.keys(),...original.keys(),...next.files.keys()])){
        const b=base.files.get(file),l=original.get(file),n=next.files.get(file);
        if(!equal(b,l)||!equal(b,n))changes.push({path:file,local:!equal(b,l),release:!equal(b,n)});
        const result=await mergeFile(b,l,n,{directory:path.join(folder,'merge-inputs'),run:this.run});if(result.bytes!==undefined)merged.set(file,result.bytes);if(result.conflict)conflicts.push({path:file,reason:result.reason,resolved:false});
      }
      await writeTree(workspace,merged);await writeTree(path.join(folder,'base'),base.files);await writeTree(path.join(folder,'local'),original);await writeTree(path.join(folder,'incoming'),next.files);
      // Preserve the publisher's baseline in a customized package, never relabel customized source as official.
      await cp(path.join(buildPath,SOURCE_FOLDER),path.join(folder,'official'),{recursive:true});
      const plan={format:1,id,installedId:installed.id,release:staged,workspace,buildPath:path.join(workspace,'release','win-unpacked'),incomingBuild:buildPath,originalHash:treeHash(original),officialHash:next.manifest.treeHash,conflicts,changes,phase:conflicts.length?'conflicts':'prepared',createdAt:new Date().toISOString()};
      await writeFile(path.join(folder,'REVIEW.md'),`# Update review\n\nPrevious official release: ${installed.version}\nNew official release: ${staged.version}\n\nEdit source/ only. base/, local/ and incoming/ preserve the three inputs. Resolve each conflict with app_update_resolve, then app_update_verify runs dependency installation, tests and packaging after approval. Finally review changes and approve the restart.\n\n${changes.map(c=>'- '+c.path+(c.local?' (customized)':'')).join('\n')}\n`);
      return this.save(plan);
    }finally{this.working=false;}
  }
  async resolve(file){if(this.working||this.verifying)throw Error('Wait for update checks to finish.');const plan=await this.plan();if(!plan)throw Error('Prepare a merge first.');sourcePath(file);const conflict=plan.conflicts.find(c=>c.path===file);if(!conflict)throw Error('This file is not an outstanding conflict.');const tree=await sourceTree(plan.workspace),bytes=tree.get(file);if(bytes&&/^([<]{7}|[=]{7}|[>]{7}|[|]{7})/m.test(bytes.toString('utf8')))throw Error('Remove conflict markers before resolving this file.');conflict.resolved=true;conflict.resolvedHash=bytes?digest(bytes):null;plan.phase=plan.conflicts.every(c=>c.resolved)?'prepared':'conflicts';delete plan.verifiedHash;return this.save(plan);}
  verify(options={}){if(this.working||this.verifying)return Promise.reject(Error('An update merge is already running.'));const task=this.performVerify(options);this.verifying=task;const clear=()=>{if(this.verifying===task)this.verifying=null;};task.then(clear,clear);return task;}
  async performVerify({conversationId}={}){
    if(this.working)throw Error('An update merge is already running.');const plan=await this.plan();if(!plan)throw Error('Prepare a merge first.');if(plan.conflicts.some(c=>!c.resolved))throw Error('Resolve every conflict before checking the update.');this.working=true;
    const controller=this.controller=new AbortController();this.owner=conversationId;
    try{
      const initial=await sourceTree(plan.workspace);for(const [file,bytes]of initial)if(text(bytes)&&/^([<]{7}|[=]{7}|[>]{7}|[|]{7})/m.test(bytes.toString('utf8')))throw Error('Unresolved conflict markers in '+file);
      for(const c of plan.conflicts)if((initial.has(c.path)?digest(initial.get(c.path)):null)!==c.resolvedHash)throw Error('A resolved conflict changed. Review and resolve it again: '+c.path);
      if(treeHash(await sourceTree(path.join(this.home,'Source')))!==plan.originalHash)throw Error('Your source changed after preparation. Prepare a fresh merge.');
      plan.phase='checking';plan.checks=[];delete plan.verifiedHash;await this.save(plan);
      const vendor=path.join(plan.incomingBuild,'resources','app.asar.unpacked','vendor');await plainPath(vendor);if((await lstat(vendor).catch(()=>null))?.isDirectory()){await this.programTree(vendor);await cp(vendor,path.join(plan.workspace,'vendor'),{recursive:true,dereference:false});}
      const runner=path.join(this.appDir,'resources','app.asar.unpacked','desktop','verify-update.ps1');
      if(controller.signal.aborted)throw Error('Update checks cancelled.');
      const result=await this.run(this.powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',runner],{cwd:plan.workspace,signal:controller.signal,env:{...process.env,EXOMINA_OFFICIAL_SOURCE:path.join(path.dirname(plan.workspace),'official'),EXOMINA_MERGE_WORKSPACE:plan.workspace,EXOMINA_MERGE_RESULT:path.join(path.dirname(plan.workspace),'checks.json')}});
      await writeFile(path.join(path.dirname(plan.workspace),'checks.log'),result.stdout+'\n'+result.stderr);
      const checks=await json(path.join(path.dirname(plan.workspace),'checks.json'));plan.checks=checks?.checks||[];
      if(result.code!==0||!['dependencies','tests','package'].every(name=>plan.checks.some(c=>c.name===name&&c.passed)))throw Error('The merged update did not pass its checks. See checks.log.');
      const final=await sourceTree(plan.workspace);
      // package version metadata changes intentionally; all other source inputs must remain fixed during checks.
      const withoutVersion=files=>new Map([...files].filter(([file])=>file!=='build/taskbar-icon.json'&&!file.startsWith('build/shell-icons/')).map(([file,bytes])=>{
        if(['package.json','package-lock.json','desktop/app-version.json'].includes(file)){const value=JSON.parse(bytes.toString('utf8'));delete value.version;if(file==='package-lock.json'&&value.packages?.[''])delete value.packages[''].version;return [file,Buffer.from(JSON.stringify(value))];}return [file,bytes];}));
      if(treeHash(withoutVersion(initial))!==treeHash(withoutVersion(final)))throw Error('Source inputs changed during verification. Check the merged update again.');
      if(treeHash(await sourceTree(path.join(this.home,'Source')))!==plan.originalHash)throw Error('Your source changed during verification. Prepare a fresh merge.');
      const packaged=await json(path.join(plan.buildPath,'exomina.build.json'));if(!packaged?.id||packaged.officialId!==plan.release.id)throw Error('The package did not preserve the official baseline.');
      const baseline=await readSnapshot(path.join(plan.buildPath,SOURCE_FOLDER));if(baseline.manifest.treeHash!==plan.officialHash||baseline.manifest.release.id!==plan.release.id)throw Error('The packaged baseline changed.');
      plan.package=packaged;plan.verifiedHash=treeHash(final);const inventory=await this.programTree(plan.buildPath);plan.packageHash=digest(JSON.stringify(inventory));
      const receipt=JSON.stringify({format:1,files:inventory});plan.receiptHash=digest(receipt);await writeFile(path.join(this.stateDir,'merge-receipt-'+plan.id+'.json'),receipt,{mode:0o600});
      plan.fullSourceHash=await this.packageHash(plan.workspace);if(controller.signal.aborted)throw Error('Update checks cancelled.');plan.phase='verified';delete plan.error;return this.save(plan);
    }catch(error){plan.phase='failed';plan.error=error.message;await this.save(plan);throw error;}finally{this.working=false;this.controller=null;this.owner=null;}
  }
  cancel(){this.controller?.abort();}
  async programTree(root){
    await plainPath(root);const hashes=[];let count=0;
    // Only the package-root Chromium log is volatile. Check links before this
    // exemption and retain every nested debug.log and other program log.
    const walk=async(relative='')=>{for(const name of (await rawFs.readdir(path.join(root,relative))).sort()){const rel=relative?relative+'/'+name:name,file=path.join(root,...rel.split('/')),info=await rawFs.lstat(file);if(info.isSymbolicLink()||info.isFile()&&info.nlink>1)throw Error('Linked build files are not allowed.');if(info.isDirectory())await walk(rel);else{if(info.isFile()&&rel.toLowerCase()==='debug.log')continue;if(++count>60000)throw Error('The update package is too large.');const bytes=await rawFs.readFile(file);if(bytes.length!==info.size)throw Error('A program file changed during capture.');hashes.push({path:rel,size:bytes.length,sha256:digest(bytes)});}}};await walk();return hashes;
  }
  async packageHash(root){return digest(JSON.stringify(await this.programTree(root)));}
  async assertProgramUnmodified(installed){
    const manifest=await json(path.join(this.appDir,'exomina.program.json'));if(!manifest)return;
    if(manifest.schema!==1||manifest.buildId!==installed?.id||!Array.isArray(manifest.files))throw Error('The installed program inventory is invalid. Preserve this installation and review it manually.');
    const actual=new Map((await this.programTree(this.appDir)).filter(f=>f.path!=='exomina.program.json').map(f=>[f.path.toLowerCase(),f]));
    for(const expected of manifest.files){const key=String(expected.path||'').replaceAll('\\','/').toLowerCase();if(key==='debug.log')continue;const file=actual.get(key);if(!file||file.size!==expected.length||Buffer.from(file.sha256,'hex').toString('base64')!==expected.sha256)throw Error('Installed program files have been customized: '+expected.path+'. Preserve this copy and port the changes into Source before updating.');actual.delete(key);}
    if(actual.size)throw Error('Unrecognized files were added to the installed program. Preserve and review this copy before updating.');
  }
  async approvedBuild(current){
    const plan=await this.plan();if(!plan||plan.phase!=='verified'||plan.release.id!==current.staged.id||plan.installedId!==current.installed.id)throw Error('Prepare, resolve and verify this merged release before applying.');
    if(treeHash(await sourceTree(plan.workspace))!==plan.verifiedHash||treeHash(await sourceTree(path.join(this.home,'Source')))!==plan.originalHash||await this.packageHash(plan.buildPath)!==plan.packageHash)throw Error('The source or checked package changed. Prepare or verify the update again.');
    const receipt=path.join(this.stateDir,'merge-receipt-'+plan.id+'.json');await plainPath(receipt);if(digest(await readFile(receipt))!==plan.receiptHash)throw Error('The checked package receipt changed. Verify again.');
    return {buildPath:plan.buildPath,staged:plan.package,plan,receipt,receiptHash:plan.receiptHash};
  }
  async commitInstalled(installed){
    const plan=await this.plan();if(!plan||!['verified','promoting'].includes(plan.phase)||plan.package?.id!==installed?.id)return null;
    const source=path.join(this.home,'Source'),backup=path.join(this.home,'Source.previous-'+plan.id);
    await plainPath(source);await plainPath(backup);
    const present=async file=>!!await lstat(file).catch(()=>null);
    const pending=async message=>{plan.phase='source-pending';plan.error=message;return this.save(plan);};
    if(plan.phase==='promoting'&&await present(backup)){
      if(await present(source)&&!await present(plan.workspace)){
        if(await this.packageHash(source)===plan.fullSourceHash){plan.phase='committed';plan.sourceBackup=backup;return this.save(plan);}
        await rename(source,plan.workspace);await rename(backup,source);return pending('Source promotion changed unexpectedly. The original Source was restored and the candidate retained.');
      }
      if(!await present(source)&&await present(plan.workspace)){
        if(await this.packageHash(plan.workspace)!==plan.fullSourceHash){await rename(backup,source);return pending('The candidate changed during source promotion. Original Source was restored.');}
        await rename(plan.workspace,source);plan.phase='committed';plan.sourceBackup=backup;return this.save(plan);
      }
      return pending('Interrupted source promotion has ambiguous state. All copies were retained for review.');
    }
    if(treeHash(await sourceTree(source))!==plan.originalHash||treeHash(await sourceTree(plan.workspace))!==plan.verifiedHash||await this.packageHash(plan.workspace)!==plan.fullSourceHash)return pending('The app update installed, but source changed before promotion. Original Source and the checked workspace were retained for review.');
    // Only these checked siblings are moved. Keep the entire original tree, including personal side files.
    if(path.dirname(source)!==path.resolve(this.home)||path.dirname(backup)!==path.resolve(this.home))throw Error('Source promotion escaped the installation folder.');
    plan.phase='promoting';await this.save(plan);await rename(source,backup);
    try{await rename(plan.workspace,source);if(await this.packageHash(source)!==plan.fullSourceHash){await rename(source,plan.workspace);throw Error('Candidate changed during promotion.');}}catch(error){await rename(backup,source);return pending(error.message+' Original Source was restored.');}
    plan.phase='committed';plan.sourceBackup=backup;return this.save(plan);
  }
}
