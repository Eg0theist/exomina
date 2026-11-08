import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';

// A verified-outcome log. An agent may only ask Exomina to check a claim; the
// status of every mark comes from Exomina's own observation, so "built",
// "installed", "running" or "merged" can never be recorded on an AI's word.
const KINDS=['update_installed','update_staged','process_running','file','github_pr_merged','github_checks'];
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,SHA=/^[0-9a-f]{7,40}$/i,BUILD=/^[\w-]{8,64}$/,HASH=/^[0-9a-f]{64}$/i;
const PASSING=new Set(['success','skipped','neutral']);
const MAX_MARKS=100,MAX_BODY=2*1024*1024,GITHUB='https://api.github.com';
const NOTICE='Exomina ran this check itself. Report "verified" outcomes as observed at the time shown. For contradicted, unavailable or refused marks, tell the user the outcome is not verified and why.';

export const OUTCOME_TOOL={name:'outcome_verify',description:'Before telling the user that something is built, staged, installed, running, saved, merged or passed, have Exomina check it. Exomina runs the check itself and records the result in this chat’s verified-outcome log; you cannot write a result. Kinds: update_installed (buildId prefix of the running build), update_staged (optional buildId of the waiting update), process_running (pid, optional process name), file (workspace path, optional sha256 and minBytes), github_pr_merged (repo, number), github_checks (repo, commit sha: every check run finished and none failed). A result is verified, contradicted, unavailable (the check could not observe it) or refused (blocked by permissions). A mark covers only what its check observed at that moment. view lists this chat’s recent marks.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['check','view']},kind:{type:'string',enum:KINDS},claim:{type:'string',maxLength:300,description:'The outcome in plain words, as you would report it.'},buildId:{type:'string',maxLength:64},pid:{type:'integer',minimum:1,maximum:2147483647},name:{type:'string',maxLength:260},path:{type:'string',maxLength:4000},sha256:{type:'string',maxLength:64},minBytes:{type:'integer',minimum:0},repo:{type:'string',maxLength:201},number:{type:'integer',minimum:1},sha:{type:'string',maxLength:40},limit:{type:'integer',minimum:1,maximum:50}},required:['action'],additionalProperties:false}};

const clean=(value,max=300)=>String(value??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);
Object.assign(OUTCOME_TOOL.inputSchema.properties,{offset:{type:'integer',minimum:0,maximum:1_000_000},export:{type:'boolean',description:'For view only: return this bounded page with chain hashes and checkpoint metadata. Does not write a file.'}});
OUTCOME_TOOL.description+=' view accepts offset for retained history and export:true for a bounded page with hash-chain metadata. Archive consistency detects damage, not trusted identity against the desktop owner. Pruning/deletion is available only through direct owner controls.';
const prefix=(actual,claimed)=>typeof actual==='string'&&actual.toLowerCase().startsWith(String(claimed).toLowerCase());

/** Windows names the process; elsewhere signal 0 only proves that the ID exists. */
export function processInfo(pid,{platform=process.platform,run=execFile}={}){
  if(platform!=='win32'){try{process.kill(pid,0);return Promise.resolve({running:true,name:null});}catch(error){return Promise.resolve({running:error.code==='EPERM',name:null});}}
  return new Promise((resolve,reject)=>run('tasklist',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{timeout:10000,windowsHide:true},(error,stdout)=>{
    if(error)return reject(Error('Windows could not list processes.'));
    const row=String(stdout).split(/\r?\n/).map(line=>line.match(/^"([^"]*)","(\d+)"/)).find(match=>match&&Number(match[2])===pid);
    resolve(row?{running:true,name:row[1]}:{running:false,name:null});
  }));
}

async function sha256File(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

export class OutcomeMarks{
  /** evaluate(action,conversationId) is the live permission policy, consulted on every check. */
  constructor({store,save=()=>store.save(),evaluate,updater,resolveFile,github=null,fetchImpl=fetch,process:inspect=processInfo,now=()=>new Date(),archive=null,getScope=()=>null,approve=async()=>false}){Object.assign(this,{store,save,evaluate,updater,resolveFile,github,fetchImpl,inspect,now,archive,getScope,approve});this.queue=Promise.resolve();}
  chat(id){const chat=this.store.state.conversations.find(item=>item.id===id);if(!chat||chat.private)throw Error('Verified outcomes are kept only in saved chats.');return chat;}
  projection(chat,scope){return chat.outcomeScope===JSON.stringify(scope)||chat.outcomeScope===undefined&&scope===null?chat.outcomeMarks||[]:[];}
  resolve(conversationId,id){const chat=this.chat(conversationId),scope=this.getScope(conversationId);return this.archive?.head(conversationId,scope)?this.archive.get(conversationId,scope,id):this.projection(chat,scope).find(mark=>mark.id===id)||null;}
  view(conversationId,limit=20,offset=0,exportRows=false){const chat=this.chat(conversationId),scope=this.getScope(conversationId);if(this.archive?.head(conversationId,scope))return this.archive.view(conversationId,scope,{limit,offset,exportRows});const marks=[...this.projection(chat,scope)].reverse();return {marks:marks.slice(offset,offset+limit),total:marks.length,offset,nextOffset:offset+limit<marks.length?offset+limit:null,archive:{status:this.archive?'not-yet-migrated':'unconfigured',notice:'Recent chat-state receipts only. Long-term archival begins with the next recorded check.'}};}
  async call(args={},conversationId){
    const chat=this.chat(conversationId);
    if(args.action==='view'){
      if(this.evaluate({kind:'read',tool:'outcome_verify',target:'verified outcome archive'},conversationId)?.decision==='deny')throw Error('Outcome history is blocked by the current permission rules.');
      if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>50)||args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0||args.offset>1_000_000)||args.export!==undefined&&typeof args.export!=='boolean')throw Error('Use an archive page of 1–50 receipts and a nonnegative bounded offset.');
      return this.view(conversationId,args.limit||20,args.offset||0,args.export===true);
    }
    if(args.action!=='check')throw Error('Choose check or view.');
    const scope=this.getScope(conversationId),scopeKey=JSON.stringify(scope);
    const subject=this.subject(args);
    const mark={id:randomUUID(),at:this.now().toISOString(),kind:args.kind,claim:clean(args.claim)||subject,subject,checkedBy:'exomina'};
    const verdict=this.evaluate({kind:'read',tool:'outcome_verify',target:subject},conversationId);
    if(verdict?.decision==='deny')Object.assign(mark,{status:'refused',reason:clean(verdict.reason)||'Blocked by the permission rules.'});
    else{
      try{Object.assign(mark,await this.check(args));}
      catch(error){Object.assign(mark,error.refused?{status:'refused',reason:clean(error.message)}:{status:'unavailable',reason:clean(error.message)||'The check could not run.'});}
    }
    const persist=async()=>{
      if(this.chat(conversationId)!==chat||JSON.stringify(this.getScope(conversationId))!==scopeKey)throw Error('The chat or client scope changed before the outcome could be recorded.');
      const current=this.evaluate({kind:'read',tool:'outcome_verify',target:subject},conversationId);
      if(current?.decision==='deny')Object.assign(mark,{status:'refused',reason:clean(current.reason)||'Permission was revoked before this outcome could be recorded.'}),delete mark.observed;
      const before=chat.outcomeMarks,beforeScope=chat.outcomeScope,prior=this.projection(chat,scope);
      // The durable journal must commit before a successful outcome is returned.
      // Only the recent projection rotates; the archive never drops rows silently.
      let receipt;
      if(this.archive){if(!this.archive.head(conversationId,scope))for(const old of prior)this.archive.append(conversationId,scope,old);receipt=this.archive.append(conversationId,scope,mark);}
      chat.outcomeMarks=[...prior,mark].slice(-MAX_MARKS);chat.outcomeScope=scopeKey;
      try{await this.save();}catch(error){chat.outcomeMarks=before;chat.outcomeScope=beforeScope;throw error;}
      return {mark,...(receipt?{archive:receipt}:{}),notice:NOTICE};
    };
    const work=this.queue.then(persist);this.queue=work.catch(()=>{});return work;
  }
  /** Owner-only controls. Tools cannot select an owner action or another chat. */
  async archiveControl(args,conversationId,{userInitiated=false}={}){
    if(!userInitiated)throw Error('Outcome archive controls require a direct owner action.');
    const chat=this.chat(conversationId),scope=this.getScope(conversationId);
    if(!this.archive)throw Error('The durable outcome archive is unavailable.');
    if(args.action==='status'||args.action==='view'){
      if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>50)||args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0||args.offset>1_000_000))throw Error('Choose a bounded archive page.');
      return this.view(conversationId,args.limit||20,args.offset||0,args.export===true);
    }
    if(!['prune','delete'].includes(args.action))throw Error('Choose archive status, prune or delete.');
    const head=this.archive.head(conversationId,scope);if(!head)return {removed:0};
    const key=JSON.stringify(scope),snapshot=JSON.stringify(head);
    if(!await this.approve({title:args.action==='delete'?'Delete this chat’s outcome archive?':'Prune old outcome receipts?',detail:JSON.stringify({conversationId,scope,action:args.action,throughSequence:args.throughSequence,head,notice:'This removes historical evidence. Current claims and learned procedures using removed marks may need new checks.'},null,2),conversationId,action:{kind:'write',tool:'outcome_archive',target:conversationId},requireConfirmation:true,userInitiated:true}))throw Error('The outcome archive change was declined.');
    const run=async()=>{
      if(this.chat(conversationId)!==chat||JSON.stringify(this.getScope(conversationId))!==key||JSON.stringify(this.archive.head(conversationId,scope))!==snapshot)throw Error('The outcome archive or scope changed during review. Inspect it again.');
      if(args.action==='delete'){const before=chat.outcomeMarks;chat.outcomeMarks=[];try{await this.save();}catch(error){chat.outcomeMarks=before;throw error;}return this.archive.deleteChat(conversationId,scope);}
      const result=this.archive.prune(conversationId,scope,args.throughSequence);chat.outcomeMarks=(chat.outcomeMarks||[]).filter(mark=>this.archive.get(conversationId,scope,mark.id));await this.save();return result;
    };
    const work=this.queue.then(run);this.queue=work.catch(()=>{});return work;
  }
  subject(args){
    const {kind}=args;
    if(!KINDS.includes(kind))throw Error('Choose an outcome kind.');
    if(kind==='update_installed'){if(!BUILD.test(args.buildId||''))throw Error('Give at least the first 8 characters of the build ID.');return `installed build ${args.buildId}`;}
    if(kind==='update_staged'){if(args.buildId!==undefined&&!BUILD.test(args.buildId))throw Error('Give at least the first 8 characters of the build ID.');return args.buildId?`waiting update ${args.buildId}`:'a waiting update';}
    if(kind==='process_running'){if(!Number.isInteger(args.pid))throw Error('Give the process ID.');return `process ${args.pid}${args.name?` (${clean(args.name,80)})`:''}`;}
    if(kind==='file'){if(typeof args.path!=='string'||!args.path.trim())throw Error('Give the file path.');if(args.sha256!==undefined&&!HASH.test(args.sha256))throw Error('A SHA-256 hash has 64 hexadecimal characters.');return `file ${clean(args.path,500)}`;}
    if(!REPO.test(args.repo||'')||String(args.repo).split('/').some(part=>part==='.'||part==='..'))throw Error('Use a repository in the form owner/name.');
    if(kind==='github_pr_merged'){if(!Number.isInteger(args.number))throw Error('Give the pull request number.');if(args.sha!==undefined&&!SHA.test(args.sha))throw Error('Give a commit SHA of 7 to 40 hexadecimal characters.');return `${args.repo}#${args.number} merged`;}
    if(!SHA.test(args.sha||''))throw Error('Give a commit SHA of 7 to 40 hexadecimal characters.');
    return `checks on ${args.repo}@${args.sha.slice(0,12)}`;
  }
  async check(args){
    const {kind}=args;
    if(kind==='update_installed'||kind==='update_staged'){
      const update=await this.updater();
      if(kind==='update_installed'){
        const installed=update?.installed;if(!installed?.id)return {status:'unavailable',reason:'The running build has no build stamp.'};
        const observed={buildId:installed.id,version:installed.version||null};
        return prefix(installed.id,args.buildId)?{status:'verified',observed}:{status:'contradicted',observed,reason:`The running build is ${installed.id}.`};
      }
      if(!update?.available||!update.staged)return {status:'contradicted',observed:{waiting:null,installed:update?.installed?.id||null},reason:'No update is waiting.'};
      const observed={buildId:update.staged.id,version:update.staged.version||null};
      return !args.buildId||prefix(update.staged.id,args.buildId)?{status:'verified',observed}:{status:'contradicted',observed,reason:`The waiting update is ${update.staged.id}.`};
    }
    if(kind==='process_running'){
      const info=await this.inspect(args.pid),observed={running:info.running,name:info.name};
      if(!info.running)return {status:'contradicted',observed,reason:'No process has this ID.'};
      if(args.name&&info.name&&info.name.toLowerCase()!==String(args.name).toLowerCase())return {status:'contradicted',observed,reason:`Process ${args.pid} is ${info.name}; its ID may have been reused.`};
      return {status:'verified',observed,...(args.name&&!info.name?{reason:'A process with this ID exists; its name could not be read on this system.'}:{})};
    }
    if(kind==='file'){
      let file;try{file=await this.resolveFile(args.path);}catch(error){if(error.code==='ENOENT')return {status:'contradicted',observed:{exists:false},reason:'The file does not exist.'};error.refused=true;throw error;}
      const info=await stat(file);if(!info.isFile())return {status:'contradicted',observed:{exists:true,file:false},reason:'This path is not a file.'};
      const observed={exists:true,bytes:info.size,modifiedAt:info.mtime.toISOString()};
      if(args.minBytes!==undefined&&info.size<args.minBytes)return {status:'contradicted',observed,reason:`The file has ${info.size} bytes, fewer than ${args.minBytes}.`};
      if(args.sha256){observed.sha256=await sha256File(file);if(observed.sha256!==args.sha256.toLowerCase())return {status:'contradicted',observed,reason:'The SHA-256 hash differs.'};}
      return {status:'verified',observed};
    }
    if(kind==='github_pr_merged'){
      const pull=await this.githubGet(`/repos/${args.repo}/pulls/${args.number}`);
      const observed={state:pull?.state||null,merged:pull?.merged===true,mergedAt:pull?.merged_at||null,mergeCommit:pull?.merge_commit_sha||null,head:pull?.head?.sha||null};
      if(!observed.merged)return {status:'contradicted',observed,reason:`The pull request is ${observed.state||'in an unknown state'} and not merged.`};
      if(args.sha&&!prefix(observed.head,args.sha)&&!prefix(observed.mergeCommit,args.sha))return {status:'contradicted',observed,reason:'It was merged, but not at the commit you named.'};
      return {status:'verified',observed};
    }
    const result=await this.githubGet(`/repos/${args.repo}/commits/${args.sha}/check-runs?per_page=100`);
    const runs=Array.isArray(result?.check_runs)?result.check_runs:[],total=Number(result?.total_count)||0;
    if(total>runs.length)return {status:'unavailable',reason:`This commit has ${total} check runs; only the first ${runs.length} could be read.`};
    const counts={},pending=[],failing=[];
    for(const run of runs){const state=run.status==='completed'?run.conclusion||'unknown':run.status||'unknown';counts[state]=(counts[state]||0)+1;if(run.status!=='completed')pending.push(clean(run.name,120));else if(!PASSING.has(run.conclusion))failing.push(clean(run.name,120));}
    const observed={total,counts,...(pending.length?{pending:pending.slice(0,10)}:{}),...(failing.length?{failing:failing.slice(0,10)}:{})};
    if(!total)return {status:'contradicted',observed,reason:'No check runs were found for this commit.'};
    if(failing.length)return {status:'contradicted',observed,reason:`${failing.length} check run${failing.length===1?'':'s'} did not pass.`};
    if(pending.length)return {status:'contradicted',observed,reason:`${pending.length} check run${pending.length===1?' is':'s are'} still running.`};
    return {status:'verified',observed};
  }
  /** Uses the connected GitHub account when there is one; otherwise reads public repositories anonymously. */
  async githubGet(target){
    if(this.github?.connected)return this.github.get(target);
    let response;
    try{response=await this.fetchImpl(new URL(target,GITHUB),{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Exomina'}});}
    catch(error){throw Error(error?.name==='TimeoutError'?'GitHub did not answer in time.':'GitHub could not be reached.');}
    const body=await response.text();if(body.length>MAX_BODY)throw Error('GitHub’s answer exceeded the size limit.');
    if(response.status===404)throw Error('GitHub found nothing there. Private repositories need a GitHub connection in Connections.');
    if((response.status===403||response.status===429)&&response.headers.get('x-ratelimit-remaining')==='0')throw Error('GitHub’s anonymous rate limit is used up. A GitHub connection in Connections raises it.');
    if(!response.ok)throw Error(`GitHub returned ${response.status}.`);
    try{return JSON.parse(body);}catch{throw Error('GitHub returned an unreadable answer.');}
  }
}
