import {createHash, randomUUID} from 'node:crypto';

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const KINDS=new Set(['chat','project','note','skill','workflow','artifact']);
const ROLES=new Set(['admin','contributor','reader']);
const copy=value=>structuredClone(value);
const denied=()=>Error('This resource is unavailable in the current client scope.');
const id=value=>{if(typeof value!=='string'||!ID.test(value))throw Error('Invalid client scope identifier.');return value;};
const label=value=>{if(typeof value!=='string'||!value.trim()||value.length>120||/[\x00-\x1f]/.test(value))throw Error('Provide a name of 1–120 characters.');return value.trim();};
const key=value=>`${value.kind}:${value.id}`;
const same=(a,b)=>a?.organizationId===b?.organizationId&&a?.clientId===b?.clientId;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty=()=>({version:1,revision:0,organizations:[],clients:[],bindings:[]});

export function validateClientScopes(state){
  if(!state||state.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.organizations)||!Array.isArray(state.clients)||!Array.isArray(state.bindings)||state.organizations.length>100||state.clients.length>1000||state.bindings.length>10000)throw Error('Invalid client authorization state.');
  const organizations=new Set(),clients=new Set(),bindings=new Set();
  for(const org of state.organizations){id(org.id);label(org.name);if(organizations.has(org.id)||!Array.isArray(org.members)||org.members.length>1000)throw Error('Invalid organization.');organizations.add(org.id);const members=new Set();for(const member of org.members){id(member.principalId);if(members.has(member.principalId)||!ROLES.has(member.role)||!Array.isArray(member.clientIds)||member.clientIds.length>1000||new Set(member.clientIds).size!==member.clientIds.length)throw Error('Invalid organization membership.');members.add(member.principalId);member.clientIds.forEach(id);}if(!org.members.some(member=>member.role==='admin'))throw Error('An organization needs an administrator.');}
  for(const client of state.clients){id(client.id);id(client.organizationId);label(client.name);if(!organizations.has(client.organizationId)||clients.has(client.id)||!['active','retired'].includes(client.status))throw Error('Invalid client.');clients.add(client.id);}
  for(const org of state.organizations)for(const member of org.members)for(const clientId of member.clientIds)if(!state.clients.some(client=>client.id===clientId&&client.organizationId===org.id))throw Error('Client membership crosses an organization.');
  for(const binding of state.bindings){if(!KINDS.has(binding.kind))throw Error('Invalid resource kind.');id(binding.id);id(binding.organizationId);id(binding.clientId);if(bindings.has(key(binding))||!state.clients.some(client=>client.id===binding.clientId&&client.organizationId===binding.organizationId))throw Error('Invalid resource binding.');bindings.add(key(binding));if(binding.sources!==undefined&&(!Array.isArray(binding.sources)||binding.sources.length>100||binding.sources.some(source=>!KINDS.has(source?.kind)||!ID.test(source?.id||'')||key(source)===key(binding))))throw Error('Invalid derived-resource sources.');}
  const byKey=new Map(state.bindings.map(binding=>[key(binding),binding]));
  for(const binding of state.bindings){let count=0;const visit=(current,seen)=>{if(++count>1000||seen.has(key(current)))throw Error('Invalid derived-resource dependency graph.');const branch=new Set([...seen,key(current)]);for(const source of current.sources||[]){const target=byKey.get(key(source));if(target){if(!same(binding,target))throw Error('Derived-resource sources cross clients.');visit(target,branch);}}};visit(binding,new Set());}
  return state;
}

/** Local authorization boundary, not a network identity provider. Principal and
 * resource callbacks are supplied by the trusted host. Configuration methods
 * must only be exposed to the owner's approved UI, never as model tools. */
export class ClientScopes{
  constructor({store,save=()=>store.save(),getPrincipal=()=>null,getChat=()=>null,resourceExists=()=>false,scopedTools=[]}){
    Object.assign(this,{store,save,getPrincipal,getChat,resourceExists});this.scopedTools=new Set(scopedTools);this.queue=Promise.resolve();this.writeFailed=false;
    if(store.state.clientScopes!==undefined)validateClientScopes(store.state.clientScopes);
  }
  state(){return this.store.state.clientScopes||empty();}
  binding(kind,resourceId,state=this.state()){return state.bindings.find(binding=>binding.kind===kind&&binding.id===resourceId)||null;}
  resourceScope(resource,state=this.state()){
    if(!resource||!KINDS.has(resource.kind)||!ID.test(resource.id||''))throw denied();
    const direct=this.binding(resource.kind,resource.id,state);
    if(resource.kind!=='chat')return direct;
    const chat=this.getChat(resource.id);if(!chat)return direct;
    const project=chat.projectId?this.binding('project',chat.projectId,state):null;
    if(direct&&project&&!same(direct,project))throw denied();
    return direct||project;
  }
  member(principalId,scope,state=this.state()){
    const client=state.clients.find(item=>item.id===scope.clientId&&item.organizationId===scope.organizationId&&item.status==='active');
    const member=state.organizations.find(org=>org.id===scope.organizationId)?.members.find(item=>item.principalId===principalId);
    return client&&member&&(member.role==='admin'||member.clientIds.includes(scope.clientId))?member:null;
  }
  context(chatId){
    if(this.writeFailed||this.changing)throw Error('Client authorization is unavailable while a configuration change is pending.');
    const scope=this.resourceScope({kind:'chat',id:chatId});if(!scope)return null;
    const principalId=this.getPrincipal(chatId);if(!principalId||!this.member(principalId,scope))throw denied();
    return Object.freeze({chatId,principalId,organizationId:scope.organizationId,clientId:scope.clientId,revision:this.state().revision});
  }
  isScoped(chatId){return !!this.resourceScope({kind:'chat',id:chatId});}
  fingerprint(chatId){const scope=this.context(chatId);return scope?digest(scope):'personal';}
  allowsResource(chatId,resource,action='read'){
    try{
      if(!['read','write','execute','approve'].includes(action))return false;
      const context=this.context(chatId),scope=this.resourceScope(resource);
      if(!context)return !scope;
      if(!scope||!same(scope,context))return false;
      let visited=0;const sourcesAllowed=(binding,seen)=>{if(++visited>1000||seen.has(key(binding)))return false;const branch=new Set([...seen,key(binding)]);return (binding.sources||[]).every(source=>{const sourceScope=this.resourceScope(source);return sourceScope&&same(sourceScope,context)&&sourcesAllowed(sourceScope,branch);});};
      if(!sourcesAllowed(scope,new Set()))return false;
      const member=this.member(context.principalId,scope);
      return !!member&&(action==='read'||member.role==='admin'||member.role==='contributor'&&['write','execute'].includes(action));
    }catch{return false;}
  }
  assertResource(chatId,resource,action='read'){if(!this.allowsResource(chatId,resource,action))throw denied();return this.context(chatId);}
  filterResources(chatId,rows,resourceForRow){return rows.filter(row=>this.allowsResource(chatId,resourceForRow(row),'read'));}
  captureJob(chatId){return Object.freeze({chatId,fingerprint:this.fingerprint(chatId)});}
  assertJob(job){if(!job||typeof job.chatId!=='string'||job.fingerprint!==this.fingerprint(job.chatId))throw Error('Client authorization changed while this work was pending. Review it again.');return this.context(job.chatId);}
  cacheKey(chatId,value){return digest([this.fingerprint(chatId),value]);}
  toolAllowed(chatId,name){try{return !this.context(chatId)||this.scopedTools.has(name);}catch{return false;}}
  status(){
    const principalId=this.getPrincipal();if(!principalId)throw denied();
    const state=this.state(),organizations=state.organizations.filter(org=>org.members.some(member=>member.principalId===principalId));
    const clients=state.clients.filter(client=>this.member(principalId,{organizationId:client.organizationId,clientId:client.id}));
    return copy({version:1,revision:state.revision,organizations:organizations.map(org=>({id:org.id,name:org.name,role:org.members.find(member=>member.principalId===principalId).role})),clients,bindings:state.bindings.filter(binding=>this.member(principalId,binding)),limits:'Local owner authorization only. Network identity, credential brokerage and managed workers require separate adapters.'});
  }
  manage(input){
    const supplied=copy(input);const run=this.queue.catch(()=>{}).then(()=>this.change(supplied));this.queue=run;return run;
  }
  async change(input){
    if(this.writeFailed)throw Error('Client authorization storage failed. Reopen the app before changing it.');
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid client scope request.');
    const principalId=this.getPrincipal();id(principalId);
    const previous=this.store.state.clientScopes,next=copy(this.state());
    const admin=organizationId=>{const org=next.organizations.find(org=>org.id===organizationId);if(!org?.members.some(member=>member.principalId===principalId&&member.role==='admin'))throw denied();return org;};
    const fields={createOrganization:['action','name'],createClient:['action','organizationId','name'],setMember:['action','organizationId','principalId','role','clientIds'],bindResource:['action','organizationId','clientId','kind','id','sources'],retireClient:['action','organizationId','clientId']};
    if(!fields[input.action]||Object.keys(input).some(field=>!fields[input.action].includes(field)))throw Error('Unsupported client scope request.');
    let result;
    if(input.action==='createOrganization'){
      result={id:randomUUID(),name:label(input.name),members:[{principalId,role:'admin',clientIds:[]}]};next.organizations.push(result);
    }else{
      const org=admin(id(input.organizationId));
      if(input.action==='createClient'){result={id:randomUUID(),organizationId:org.id,name:label(input.name),status:'active'};next.clients.push(result);}
      if(input.action==='setMember'){
        const target=id(input.principalId),role=input.role;
        if(role!=='none'&&!ROLES.has(role))throw Error('Invalid member role.');
        org.members=org.members.filter(member=>member.principalId!==target);
        if(role!=='none')org.members.push({principalId:target,role,clientIds:copy(input.clientIds||[])});
        result={principalId:target,role};
      }
      if(input.action==='bindResource'){
        const resource={kind:input.kind,id:id(input.id)},scope={organizationId:org.id,clientId:id(input.clientId)};
        if(!KINDS.has(resource.kind)||!await this.resourceExists(resource))throw denied();
        if(!this.member(principalId,scope,next))throw denied();
        const existing=this.resourceScope(resource,next);if(existing&&!same(existing,scope))throw Error('Resources cannot be relabelled across clients. Create a new resource and review its sources.');
        if(resource.kind==='project'&&(this.store.state.conversations||[]).some(chat=>chat.projectId===resource.id&&this.binding('chat',chat.id,next)&&!same(this.binding('chat',chat.id,next),scope)))throw Error('A project contains a chat from another client.');
        const sources=input.sources||[];
        if(!Array.isArray(sources)||sources.length>100)throw Error('Use at most 100 derived-resource sources.');
        for(const source of sources){const sourceScope=this.resourceScope(source,next);if(!sourceScope||!same(sourceScope,scope)||!this.member(principalId,sourceScope,next))throw Error('Derived resources must retain the client scope of every source.');}
        if(sources.some(source=>key(source)===key(resource)))throw Error('A derived resource cannot be its own source.');
        result={...resource,...scope,...(sources.length?{sources:copy(sources)}:{})};next.bindings=next.bindings.filter(binding=>key(binding)!==key(resource));next.bindings.push(result);
      }
      if(input.action==='retireClient'){const client=next.clients.find(client=>client.id===input.clientId&&client.organizationId===org.id);if(!client)throw denied();client.status='retired';result=client;}
    }
    next.revision++;validateClientScopes(next);
    // Commit before publishing the new authorization generation. A failed write
    // poisons this instance; no subsequent operation can silently restore access.
    this.changing=true;this.store.state.clientScopes=next;
    try{await this.save();}catch(error){this.store.state.clientScopes=previous;this.writeFailed=true;throw error;}finally{this.changing=false;}
    return copy({result,revision:next.revision});
  }
}
