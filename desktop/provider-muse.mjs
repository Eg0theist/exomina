import {mkdir,readFile,writeFile,access,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnMspConnection,Session,readSessionDurability} from '@muse-code/sdk';
import {APP_VERSION} from './app-version.mjs';
import {officialLoginUrl} from './provider-auth.mjs';
import {acpAction} from './permissions.mjs';
import {runtimeError,unpackedPath} from './provider-acp.mjs';
import {clipToolHistory} from './chat-memory-records.mjs';
import {durableReplace} from './durable-state.mjs';
import {museQuota} from './usage.mjs';
import {DISTRIBUTION_PROFILE} from './distribution.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exists=file=>access(file).then(()=>true,()=>false);
const optional=value=>typeof value==='string'&&value.trim()&&!['auto','default'].includes(value.trim())?value.trim():undefined;
const modelLabel=row=>row.displayLabel&&row.displayLabel!==row.modelId?row.displayLabel:({'muse-wonder-1.0':'Muse Wonder','muse-wonder-full-1.0':'Muse Wonder Full','muse-spark-1.3':'Muse Spark 1.3','muse-spark-1.2':'Muse Spark 1.2'}[row.modelId]||row.modelId);
const safe=value=>runtimeError(value).replace(/\b(?:mapi|meta)_[A-Za-z0-9_-]{16,}\b/g,'[redacted]');
export function museEnvironment(source,profile){
  const env=Object.fromEntries(Object.entries(source).filter(([key])=>!(/^(?:META_|MUSE_|EXOMINA_|OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|GEMINI_|KIMI_|MOONSHOT_|GITHUB_|GH_|COPILOT_|GROK_|XAI_|OTEL_|NODE_OPTIONS$|BUN_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_DEBUG|SSLKEYLOGFILE$)/i.test(key)||/(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION)/i.test(key))));
  const temporary=path.join(profile,'runtime-tmp');
  return {...env,HOME:profile,USERPROFILE:profile,XDG_CONFIG_HOME:path.join(profile,'.config'),XDG_DATA_HOME:path.join(profile,'.local','share'),XDG_STATE_HOME:path.join(profile,'.local','state'),XDG_CACHE_HOME:path.join(profile,'.cache'),MUSE_AUTH_PATH:path.join(profile,'.config','muse','auth.json'),TEMP:temporary,TMP:temporary,TMPDIR:temporary,DO_NOT_TRACK:'1'};
}
export function museModels(result){
  return (result?.models||[]).filter(row=>typeof row.modelId==='string'&&row.modelId.length<=300&&row.providerId==='meta').map(row=>({id:row.modelId,label:modelLabel(row),
    efforts:(Array.isArray(row.variants)?row.variants:[]).filter(value=>typeof value==='string').map(id=>({id,label:id==='xhigh'?'Extra high':id[0].toUpperCase()+id.slice(1)})),
    defaultEffort:row.defaultReasoningEffort||'',isDefault:!!row.isDefault,supportsImages:true,catalogSource:result.source}));
}
export function museApprovalChoice(request,approved){
  const choices=request.availableChoices||[];
  return approved?choices.find(choice=>choice.decision==='approved'&&choice.scope==='once'):choices.find(choice=>choice.decision==='denied'&&choice.scope==='once')||choices.find(choice=>['denied','abort'].includes(choice.decision));
}
export function museMcp(gateway,conversationId){
  if(!gateway?.script||!gateway?.url||!gateway?.token)return {};
  return{exomina:{transport:'stdio',command:process.execPath,args:[gateway.script],framing:'lineDelimitedJson',mode:'required',env:{EXOMINA_TOOL_GATEWAY:gateway.url,EXOMINA_TOOL_TOKEN:gateway.token,EXOMINA_TOOL_CONVERSATION:conversationId,ELECTRON_RUN_AS_NODE:'1'}}};
}
export function museToolPrompt(prompt,hasSharedTools){
  if(!hasSharedTools)return prompt;
  return 'Exomina tool environment:\nUse the exomina MCP workspace_shell tool for terminal commands, builds and checks. Muse’s native powershell tool is disabled in this host: its Windows sandbox cannot use this encrypted workspace reliably. The shared terminal starts in the selected chat workspace and runs with the signed-in Windows account permissions, not an OS sandbox. Exomina applies this chat’s permission level and deny rules before execution; Ask mode needs approval and Full access follows the user’s existing grant. Do not infer missing sandbox setup from a failed shared-tool call or tell the user to run the whole app as administrator. Report the actual returned error. File, browser, desktop and memory tools remain available under their existing permissions.\n\n'+prompt;
}
export function applyMuseEvent(event,state,manager){
  const p=event.params||{};if(p.sessionId!==state.sessionId||state.cancelled)return;
  const emitDelta=(id,text)=>{if(!text)return;state.museLengths.set(id,(state.museLengths.get(id)||0)+text.length);manager.delta(state,text,id);};
  if(event.method==='item/delta'){
    const kind=state.museKinds.get(p.itemId);if(kind==='agentMessage'&&(!p.field||p.field==='text'))emitDelta(p.itemId,p.delta||'');
    else if(kind==='reasoning'&&(!p.field||p.field==='text'))manager.emit({type:'chat.thinking',conversationId:state.conversationId,text:String(p.delta||'').slice(0,4000),id:p.itemId});return;
  }
  const item=p.item;if(!item||!['item/started','item/updated','item/completed'].includes(event.method))return;
  state.museKinds.set(item.itemId,item.kind);
  if(item.kind==='agentMessage'){
    const sent=state.museLengths.get(item.itemId)||0,text=String(item.text||'');if(text.length>sent)emitDelta(item.itemId,text.slice(sent));
  }else if(item.kind==='toolCall'){
    let input;try{input=JSON.parse(item.args||'{}');}catch{input={arguments:String(item.args||'').slice(0,4000)};}
    const status={inProgress:'running',completed:'done',failed:'error',cancelled:'stopped',rejected:'denied',timedOut:'error'}[item.status]||'running';
    manager.toolStep(state,{id:item.itemId,name:item.tool||'Muse tool',input,status,outcomeConfirmed:item.status==='completed',...(item.visibleOutput||item.failureReason?{output:clipToolHistory(item.visibleOutput||item.failureReason,4000)}:{})});
  }else if(item.kind==='reasoning'&&item.text)manager.emit({type:'chat.thinking',conversationId:state.conversationId,id:item.itemId,text:String(item.text).slice(0,4000)});
}

/** Meta's official MSP host owns subscription credentials and native tools.
 * API-key environment variables are removed; every host disables Contributor
 * mode. Metadata queries never send a model turn or another app's credentials. */
export class MuseProvider{
  constructor(manager,{runtimePath,spawnMsp=spawnMspConnection}={}){Object.assign(this,{manager,runtimePath,spawnMsp});this.id='muse-code';this.name='Muse Code';this.hosts=new Set();this.clients=new Set();this.usageRequests=new Map();this.usageQueue=Promise.resolve();this.closed=false;}
  async executable(){
    const name=process.platform==='win32'?'muse.exe':'muse';
    const candidates=[this.runtimePath,...(DISTRIBUTION_PROFILE==='personal'?[unpackedPath(path.join(ROOT,'vendor','muse',name))]:[]),...String(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,name))].filter(Boolean);
    for(const file of candidates)if(await exists(file))return file;
    return null;
  }
  async profile(){await this.manager.prepare();const profile=path.join(this.manager.dataDir,'muse-home');await Promise.all([path.join(profile,'.config','muse'),path.join(profile,'runtime-tmp')].map(dir=>mkdir(dir,{recursive:true})));return profile;}
  async accountMarker(){const profile=await this.profile();return path.join(profile,'account-signin.json');}
  async savedLogin(){try{const marker=JSON.parse(await readFile(await this.accountMarker(),'utf8'));return marker.method==='official-account'&&typeof marker.completedAt==='string';}catch{return false;}}
  async open({workspace,readOnly=false,provider='meta'}={}){
    if(this.closed)throw Error('Muse connection is closed.');const executable=await this.executable();if(!executable)throw Error('Install Meta’s official Muse Code client, then reopen Exomina. See https://dev.meta.ai/docs/muse-code.');
    // Native Windows shell preparation changes ACLs and cannot create files in
    // the EFS workspace. Use the existing, explicitly described Exomina terminal
    // through its permission gateway. Do not disable Muse's remaining sandbox.
    const profile=await this.profile(),args=['serve','--provider',provider,'--contributor-mode','off','--disable-shell','--sandbox-network','restricted'];if(readOnly)args.push('--disable-write');
    const handshake=this.spawnMsp({command:executable,args,cwd:workspace||profile,env:museEnvironment(this.manager.environment(this.id),profile),shutdownTimeoutMs:5000});this.hosts.add(handshake);
    let timer;
    try{
      const host=await Promise.race([handshake.initialize({clientInfo:{name:'exomina',version:APP_VERSION},capabilities:{requestedCapabilities:['sessionMcp'],userInputDialogs:true}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Muse did not finish startup in time.')),20000);})]);
      const actual=path.resolve(host.initializeResult.museHome),expected=path.resolve(profile)+path.sep;
      if(!actual.toLowerCase().startsWith(expected.toLowerCase()))throw Error('Muse did not use Exomina’s protected account profile.');
      const client={host,handshake,close:async()=>{this.clients.delete(client);this.hosts.delete(handshake);await handshake.close();}};this.clients.add(client);
      host.connection.onNotification(event=>{if(event.method==='usage/changed')this.captureUsage(event.params).catch(()=>{});});
      return client;
    }catch(error){this.hosts.delete(handshake);await handshake.close().catch(()=>{});throw Error(safe(error));}finally{clearTimeout(timer);}
  }
  async cacheIdentity(){try{return JSON.parse(await readFile(await this.accountMarker(),'utf8')).completedAt||null;}catch{return null;}}
  async cachedUsage(){
    const identity=await this.cacheIdentity();if(!identity)return null;
    if(this.lastUsageIdentity===identity&&this.lastUsage)return this.lastUsage;
    try{const saved=JSON.parse(await readFile(path.join(await this.profile(),'subscription-usage.json'),'utf8'));if(saved.identity!==identity)return null;this.lastUsage=museQuota(saved.usage);this.lastUsageIdentity=identity;return this.lastUsage;}catch{return null;}
  }
  async captureUsage(value,{publish=true}={}){
    const quota=museQuota(value);if(!quota)return null;const identity=await this.cacheIdentity();if(!identity)return null;
    const saved=await this.cachedUsage(),previous=this.lastUsageIdentity===identity&&this.lastUsage?this.lastUsage:saved;if(previous&&quota.observedAtMs<previous.observedAtMs)return previous;
    const changed=!previous||JSON.stringify(quota)!==JSON.stringify(previous);this.lastUsage=quota;this.lastUsageIdentity=identity;
    if(publish)this.manager.emit({type:'usage',provider:this.id,info:{usage:quota}});
    if(changed){const file=path.join(await this.profile(),'subscription-usage.json');this.usageQueue=this.usageQueue.catch(()=>{}).then(()=>durableReplace(file,JSON.stringify({identity,usage:this.lastUsage})));await this.usageQueue;}
    return quota;
  }
  async readClientUsage(client,{publish=true}={}){
    let pending=this.usageRequests.get(client);
    if(!pending){pending=client.host.connection.request('usage/read',{}).then(result=>this.captureUsage(result.usage,{publish})).finally(()=>this.usageRequests.delete(client));this.usageRequests.set(client,pending);}
    let timer;try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Muse usage read timed out.')),5000);})]);}finally{clearTimeout(timer);}
  }
  async usage({publish=true}={}){
    if(!await this.savedLogin())throw Error('Connect Muse Code to see its subscription usage.');
    const results=await Promise.allSettled([...this.clients].map(client=>this.readClientUsage(client,{publish:false}))),live=results.some(result=>result.status==='fulfilled'&&result.value);
    const quota=await this.cachedUsage();if(!quota)throw Error('Muse has not reported its limits yet. Send a Muse message to load them.');
    const info={usage:quota,fromCache:!live};if(publish)this.manager.emit({type:'usage',provider:this.id,info});return info;
  }
  async status(){const installed=!!await this.executable(),connected=installed&&await this.savedLogin();return{id:this.id,name:this.name,installed,connected,supportsTools:true,supportsToolFree:false,supportsImages:true,
    detail:!installed?'Install Muse Code from dev.meta.ai/docs/muse-code, then reopen Exomina. This beta uses your own official Muse installation.':connected?'Muse account sign-in saved. Commands use Exomina’s terminal and chat permissions. Your Power subscription and model access are checked when you send. No API-key fallback.':'Sign in with your Meta account to use your Muse Code subscription, including eligible Wonder models.',contributorMode:false,shellMode:'exomina-terminal',nativeShell:false};}
  async modelOptions(){if(!await this.savedLogin())return[];const client=await this.open({readOnly:true});try{
    let catalogue=await client.host.connection.request('model/list',{});
    if(!catalogue.models?.length){const result=await client.host.connection.command('session/start',{workspaceRoot:await this.profile(),providerId:'meta',approvalMode:'denyUnmatched'});catalogue=await client.host.connection.request('model/list',{sessionId:result.session.sessionId});}
    return museModels(catalogue);
  }finally{await client.close();}}
  async connect(){
    if(this.login)return{message:'Muse sign-in is already open. Finish the code in your browser.'};
    const profile=await this.profile(),executable=await this.executable();if(!executable)throw Error('Install Meta’s official Muse Code client, then reopen Exomina. See https://dev.meta.ai/docs/muse-code.');
    const child=this.manager.spawnImpl(executable,['login'],{cwd:profile,env:museEnvironment(this.manager.environment(this.id),profile),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});this.login=child;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');let buffer='',url='',code='',done=false;
    const answer=()=>({message:'Complete Muse Code’s official Meta account sign-in, then refresh connections. Your subscription stays with Muse Code.',...(url?{url}:{}),...(code?{code}:{})});
    let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const readyTimer=setTimeout(()=>resolveReady(answer()),2000),timeout=setTimeout(()=>this.manager.stopChild(child),10*60*1000);
    const read=chunk=>{buffer=(buffer+chunk).slice(-16000);const match=buffer.match(/(?:code|enter)\s*[:：]?\s*([A-Z0-9]{4}[- ][A-Z0-9]{4})\b/i);if(match)code=match[1].replace(' ','-');
      const links=buffer.match(/https:\/\/[^\s\x1b"<>]+(?=[\s\x1b])/g)||[];for(const link of links){const approved=officialLoginUrl(link,this.id);if(approved&&approved!==url){url=approved;this.manager.emit({type:'auth.url',provider:this.id,url,...(code?{userCode:code}:{})});resolveReady(answer());}}};
    child.stdout.on('data',read);child.stderr.on('data',read);
    const failed=error=>{if(done)return;done=true;clearTimeout(readyTimer);clearTimeout(timeout);this.login=null;this.manager.emit({type:'auth.error',provider:this.id,message:safe(error)});rejectReady(Error(safe(error)));};
    child.on('error',failed);child.stdout.on('error',failed);child.stderr.on('error',failed);
    child.on('close',async exit=>{if(done)return;done=true;clearTimeout(readyTimer);clearTimeout(timeout);this.login=null;
      if(exit===0){try{await writeFile(await this.accountMarker(),JSON.stringify({method:'official-account',completedAt:new Date().toISOString()}),{mode:0o600});this.manager.emit({type:'auth.completed',provider:this.id});resolveReady(answer());}catch(error){this.manager.emit({type:'auth.error',provider:this.id,message:safe(error)});rejectReady(error);}}
      else{const error=Error('Muse sign-in did not complete. Try Sign in again.');this.manager.emit({type:'auth.error',provider:this.id,message:error.message});rejectReady(error);}});
    return ready;
  }
  async disconnect(){if(this.login)this.manager.stopChild(this.login);const executable=await this.executable(),profile=await this.profile();
    if(executable)await new Promise((resolve,reject)=>{const child=this.manager.spawnImpl(executable,['logout'],{cwd:profile,env:museEnvironment(this.manager.environment(this.id),profile),windowsHide:true,shell:false,stdio:'ignore'});child.on('error',reject);child.on('close',exit=>exit===0?resolve():reject(Error('Muse could not sign out.')));});
    await unlink(await this.accountMarker()).catch(error=>{if(error.code!=='ENOENT')throw error;});return this.status();}
  async approval(request,state,workspace){
    let input;try{input=JSON.parse(request.rawArgs||'{}');}catch{input={};}
    const subject=request.subject||{},kind=subject.kind==='shell'?'execute':subject.kind==='network'?'fetch':subject.kind==='fileAccess'?(subject.access==='read'?'read':'edit'):'other';
    const decision=state.cancelled?{approved:false}:await this.manager.approveDetailed({title:'Muse wants to '+(request.toolName||'use a tool'),detail:JSON.stringify({subject,input}),conversationId:state.conversationId,action:acpAction(this.id,{kind,title:request.toolName,rawInput:{...input,...(subject.command?{command:subject.command}:{}),...(subject.path?{path:subject.path}:{})}}),input});
    const choice=museApprovalChoice(request,decision.approved&&!state.cancelled);if(!choice)throw Error('Muse did not offer a matching one-time approval choice.');return{choiceId:choice.choiceId,...(!decision.approved&&decision.message&&choice.acceptsFeedback?{feedback:decision.message}:{})};
  }
  async run(options,state){
    if(options.noTools)throw Error('Muse Code’s tool-free helper mode is not available in this build. Use it for a normal chat with tools.');
    if(!await this.savedLogin())throw Error('Connect your Muse Code subscription in Connections first.');
    const workspace=path.resolve(options.workspace||this.manager.workspace),readOnly=this.manager.getPermissionMode(state.conversationId)==='read-only',client=await this.open({workspace,readOnly});
    state.museLengths=new Map();state.museKinds=new Map();const connection=client.host.connection;state.sessionId=connection.mintCommandId();
    const session=new Session({sessionId:state.sessionId,durability:readSessionDurability(client.host.initializeResult),connection});let turn,protocolFailure;
    session.onApproval(request=>this.approval(request,state,workspace));session.onApprovalError(error=>{protocolFailure=Error(safe(error));client.close().catch(()=>{});});
    const questions=new Set();
    connection.onNotification(event=>{if(event.params?.sessionId!==state.sessionId&&event.params?.session?.sessionId!==state.sessionId)return;try{
      applyMuseEvent(event,state,this.manager);session.apply(event).io.catch(error=>{protocolFailure=error;client.close().catch(()=>{});});
      if(['userInput/request','userInput/requested'].includes(event.method)&&!questions.has(event.params.userInputId)){
        const p=event.params;questions.add(p.userInputId);
        (async()=>{const result=await this.manager.requestUserInput(state.conversationId,{questions:p.questions.map(q=>({id:q.id,header:q.header,question:q.question,options:q.options||[]})),require_answer:true},{wait:true});
          if(state.cancelled)return;const answers=p.questions.flatMap(q=>{const text=result.answers?.[q.id]?.answers?.[0];if(!text)return[];return[{questionId:q.id,...(q.options?.some(o=>o.label===text)?{selectedLabel:text}:{freeText:text})}];});
          if(answers.length===p.questions.length)await connection.command('userInput/answer',{sessionId:state.sessionId,userInputId:p.userInputId,answers});
          else await connection.command('userInput/cancel',{sessionId:state.sessionId,userInputId:p.userInputId});
        })().catch(error=>{protocolFailure=error;client.close().catch(()=>{});});
      }
    }catch(error){protocolFailure=error;client.close().catch(()=>{});}});
    state.adapterCancel=()=>{if(turn)connection.command('turn/interrupt',{sessionId:state.sessionId,turnId:turn.turnId}).catch(()=>client.close());else client.close().catch(()=>{});};
    const mcp=museMcp(this.manager.gateway,state.conversationId);
    try{
      if(!readOnly&&!Object.keys(mcp).length)throw Error('Exomina’s shared-tool connection is unavailable. Restart Exomina before retrying. No terminal command was started.');
      if(Object.keys(mcp).length&&!client.host.initializeResult.grantedCapabilities.includes('sessionMcp'))throw Error('This Muse runtime did not grant the shared-tool connection.');
      await connection.command('session/start',{sessionId:state.sessionId,workspaceRoot:workspace,providerId:'meta',approvalMode:readOnly?'denyUnmatched':this.manager.getPermissionMode(state.conversationId)==='full'?'onRequest':'promptUnmatched',...(optional(options.model)?{modelId:optional(options.model)}:{}),...(Object.keys(mcp).length?{config:{mcpServers:mcp}}:{})});
      if(state.cancelled)throw Error('Stopped.');
      const input=[{type:'text',text:museToolPrompt(options.prompt,Object.keys(mcp).length>0)},...(options.images||[]).map(image=>({type:'image',mediaType:image.mimeType||'image/png',base64Data:image.dataBase64||image.base64}))];
      turn=await session.sendUserTurn({input,ifBusy:'queue',...(optional(options.effort)?{reasoningEffort:optional(options.effort)}:{})});state.turnId=turn.turnId;
      const outcome=await Promise.race([turn.completed,client.host.exited.then(()=>{throw Error('Muse stopped before the reply finished. Its effects may be incomplete; inspect the project before retrying.');})]);
      if(protocolFailure)throw protocolFailure;if(state.cancelled)throw Error('Stopped.');if(outcome.kind!=='completed'||outcome.params.terminal!=='completed')throw Error(safe(outcome.params?.error?.message||outcome.params?.reason||'Muse did not complete the reply.'));
      return{text:state.text,sessionId:state.sessionId,provider:this.id,selection:{provider:this.id,...(optional(options.model)?{model:optional(options.model)}:{}),...(optional(options.effort)?{effort:optional(options.effort)}:{})}};
    }finally{delete state.adapterCancel;await this.readClientUsage(client).catch(()=>{});await client.close().catch(()=>{});}
  }
  close(){this.closed=true;if(this.login)this.manager.stopChild(this.login);for(const host of this.hosts)host.close().catch(()=>{});this.hosts.clear();}
}
