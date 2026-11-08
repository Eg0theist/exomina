import path from 'node:path';
import {mkdir,realpath,lstat,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
const exec=promisify(execFile);
const same=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const within=(root,file)=>{const relative=path.relative(root,file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const env=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(GIT_|NODE_OPTIONS$|ELECTRON_|.*(?:TOKEN|SECRET|PASSWORD|API_KEY))/i.test(key)));
export const TASK_WORKSPACE_TOOL={name:'task_workspace',description:'Inspect this chat’s managed Git worktree and its bounded diff. Create or detach a coding workspace from Terminal → Coding workspace while the chat is idle. Creation uses committed files only; untracked and ignored files are not copied. Committed secrets can still be present. A worktree is file organization, not a process sandbox.',inputSchema:{type:'object',properties:{action:{enum:['status','diff']}},required:['action'],additionalProperties:false}};

export async function resolveGitExecutable(cwd){
  const repository=await realpath(cwd);
  for(const directory of String(process.env.PATH||process.env.Path||'').split(path.delimiter)){
    if(!path.isAbsolute(directory))continue;
    try{const root=await realpath(directory);if(same(root,repository)||within(repository,root))continue;
      const file=await realpath(path.join(root,process.platform==='win32'?'git.exe':'git'));if(same(file,repository)||within(repository,file)||!(await lstat(file)).isFile())continue;await access(file,process.platform==='win32'?constants.F_OK:constants.X_OK);return file;
    }catch{}
  }
  throw Error('A trusted Git executable was not found in an absolute PATH directory outside the project.');
}

export class TaskWorkspaces{
  constructor({root,getChat,getWorkspace,save,approve,exclude=async()=>{},idle=()=>true,changed=()=>{}}){Object.assign(this,{root,getChat,getWorkspace,save,approve,exclude,idle,changed});this.queue=Promise.resolve();}
  run(work){const pending=this.queue.then(work);this.queue=pending.catch(()=>{});return pending;}
  async git(cwd,args,{allowEmpty=false,truncate=false}={}){
    const binary=await resolveGitExecutable(cwd),options=['--no-optional-locks','-c','core.hooksPath='+path.join(this.root,'empty-hooks'),'-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','core.untrackedCache=false'];
    const settings={cwd,env:env(),windowsHide:true,shell:false,maxBuffer:2*1024*1024,timeout:60_000};
    let configured='';try{configured=(await exec(binary,[...options,'config','--null','--get-regexp','^filter\..*\.(clean|smudge|process)$'],settings)).stdout;}catch(error){if(error.code!==1)throw error;}
    const names=[...new Set(configured.split('\0').map(entry=>/^filter\.(.+)\.(?:clean|smudge|process)\n/.exec(entry)?.[1]).filter(Boolean))];
    const filters=names.flatMap(name=>['-c',`filter.${name}.clean=`,'-c',`filter.${name}.smudge=`,'-c',`filter.${name}.process=`,'-c',`filter.${name}.required=false`]);
    try{const output=(await exec(binary,[...options,...filters,...args],settings)).stdout.trimEnd();return truncate?{text:output,truncated:false}:output;}
    catch(error){if(allowEmpty&&error.code===1)return '';if(truncate&&error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return {text:String(error.stdout||'').slice(0,2*1024*1024),truncated:true};throw Error('Git task workspace: '+String(error.stderr||error.message).slice(0,1800));}
  }
  async repository(folder,id){const actual=await realpath(folder);await this.exclude(actual,id);const root=await realpath(await this.git(actual,['rev-parse','--show-toplevel']));await this.exclude(root,id);const common=await realpath(await this.git(root,['rev-parse','--path-format=absolute','--git-common-dir']));await this.exclude(common,id);return {root,common};}
  chat(id){const chat=this.getChat(id);if(!chat||chat.private||chat.background||chat.channel)throw Error('Choose a saved desktop chat for a coding workspace.');return chat;}
  status(id){return this.chat(id).taskWorkspace||null;}
  async create(id){return this.run(async()=>{const chat=this.chat(id);if(chat.taskWorkspace)throw Error('This chat already has a task workspace.');if(!this.idle(id))throw Error('Stop this chat’s running work before changing its folder.');const originalWorkspace=this.getWorkspace(chat),repo=await this.repository(originalWorkspace,id),base=await this.git(repo.root,['rev-parse','--verify','HEAD']);
    if(!same(await realpath(originalWorkspace),repo.root))throw Error('Choose the repository root as this chat’s project folder before creating a coding workspace.');
    const tracked=(await this.git(repo.root,['ls-tree','-rz','--name-only',base])).split('\0').filter(Boolean);for(const name of tracked){const source=path.resolve(repo.root,name);if(!within(repo.root,source))throw Error('Invalid tracked file path.');await this.exclude(source,id);}
    const taskId=randomUUID(),branch='exomina/task-'+taskId,folder=path.join(this.root,taskId);await this.exclude(folder);await mkdir(path.join(this.root,'empty-hooks'),{recursive:true});const managedRoot=await realpath(this.root);if(!within(managedRoot,folder))throw Error('Invalid task folder.');
    if(!await this.approve({title:'Create a separate coding workspace?',conversationId:id,requireConfirmation:true,action:{kind:'execute',tool:'task_workspace',target:repo.root},detail:`Repository: ${repo.root}\nStarting commit: ${base}\nBranch: ${branch}\nFolder: ${folder}\nOnly committed files are checked out. Ignored and untracked files are not copied. Repository hooks and content filters are disabled during creation. No merge or push is performed.`}))throw Error('Task workspace creation declined.');
    if(this.chat(id)!==chat||chat.taskWorkspace||!this.idle(id)||!same(this.getWorkspace(chat),originalWorkspace))throw Error('The chat workspace changed during review.');
    const current=await this.repository(originalWorkspace,id);if(!same(current.root,repo.root)||!same(current.common,repo.common))throw Error('Repository identity changed during review.');
    for(const name of tracked)await this.exclude(path.resolve(repo.root,name),id);
    if(!same(await realpath(this.root),managedRoot))throw Error('Task folder changed during review.');await this.exclude(repo.root);await this.exclude(folder);
    await this.git(repo.root,['worktree','add','-b',branch,'--',folder,base]);
    const record={id:taskId,repository:repo.root,folder,branch,base,originalWorkspace,createdAt:new Date().toISOString()};chat.taskWorkspace=record;try{await this.save();}catch(error){try{await this.git(repo.root,['worktree','remove','--',folder]);delete chat.taskWorkspace;}catch{}throw Error(`The chat binding could not be saved. Branch ${branch} was retained. Check ${folder} before retrying. ${error.message}`);}this.changed();return record;
  });}
  async owned(id){const record=this.status(id);if(!record||!/^[-a-f0-9]{36}$/.test(record.id)||!same(path.join(this.root,record.id),record.folder))throw Error('No matching managed workspace for this chat.');const actual=await realpath(record.folder);if(!same(actual,record.folder)||(await lstat(record.folder)).isSymbolicLink())throw Error('The task folder was replaced with a link.');await this.exclude(actual,id);const repo=await this.repository(record.repository,id);const list=await this.git(repo.root,['worktree','list','--porcelain']);if(!list.split(/\r?\n\r?\n/).some(item=>{const location=item.split(/\r?\n/).find(line=>line.startsWith('worktree '))?.slice(9);return location&&same(location,record.folder)&&item.includes('branch refs/heads/'+record.branch);}))throw Error('Git no longer associates this task with its recorded branch. Detach the task binding to return to its original folder.');return {record,repo};}
  async diff(id){const {record}=await this.owned(id);const status=await this.git(record.folder,['status','--porcelain=v1','--untracked-files=all']),output=await this.git(record.folder,['diff','--no-ext-diff','--no-textconv',record.base,'--'],{truncate:true}),diff=output.text;return {branch:record.branch,base:record.base,status,diff,truncated:output.truncated,revision:createHash('sha256').update(status+'\0'+diff).digest('hex'),note:output.truncated?'Diff exceeded 2 MiB and was shortened. Line-comment batching is unavailable for this diff.':'Untracked files appear in status; their contents are not included.'};}
  remove(id){return this.run(async()=>{const {record,repo}=await this.owned(id);if(!this.idle(id))throw Error('Stop this chat’s work and terminals before removing its folder.');if(await this.git(record.folder,['status','--porcelain=v1','--untracked-files=all','--ignored=matching']))throw Error('This task has uncommitted, untracked or ignored files. Preserve them before removing the worktree.');
    if(!await this.approve({title:'Remove this clean task folder?',conversationId:id,requireConfirmation:true,action:{kind:'execute',tool:'task_workspace',target:record.folder},detail:`Folder: ${record.folder}\nThe clean worktree is removed. Branch ${record.branch} and its commits stay in the repository. This chat returns to ${record.originalWorkspace}.`}))throw Error('Task removal declined.');await this.owned(id);if(!this.idle(id))throw Error('Work started while removal was awaiting review.');if(await this.git(record.folder,['status','--porcelain=v1','--untracked-files=all','--ignored=matching']))throw Error('Files changed during review. The task folder was kept.');await this.git(repo.root,['worktree','remove','--',record.folder]);delete this.chat(id).taskWorkspace;await this.save();this.changed();return {removed:true,branchRetained:record.branch};
  });}
  forget(id){return this.run(async()=>{const chat=this.chat(id),record=chat.taskWorkspace;if(!record||!this.idle(id))throw Error('Stop this chat’s work before detaching its task binding.');if(!await this.approve({title:'Detach this coding workspace?',conversationId:id,requireConfirmation:true,action:{kind:'write',tool:'task_workspace',target:record.folder},detail:`This chat returns to its original folder. No task files, worktrees, branches or commits are deleted.\nTask folder: ${record.folder}`}))throw Error('Detachment declined.');if(this.chat(id)!==chat||!this.idle(id))throw Error('The chat changed during review.');delete chat.taskWorkspace;await this.save();this.changed();return {detached:true};});}
  async call(args,id){if(!['status','diff'].includes(args.action))throw Error('Use Terminal → Coding workspace while this chat is idle to change its task binding.');if(!await this.approve({title:'Read coding workspace?',conversationId:id,action:{kind:'read',tool:'task_workspace',target:this.status(id)?.folder||'current chat'},detail:'Read the selected coding workspace status or diff.'}))throw Error('Workspace read declined.');const value=args.action==='status'?this.status(id):await this.diff(id);return {content:[{type:'text',text:JSON.stringify(value)}]};}
}
