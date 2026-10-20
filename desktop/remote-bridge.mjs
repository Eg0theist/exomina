import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openChannel} from './remote-crypto.mjs';
import {phonePendingQuestions,phoneWorkCounts} from './phone-work.mjs';
// Must match cloud/relay.mjs RELAY_LIMITS.maxBlob (cloud/ is not packaged with the desktop app).
const RELAY_LIMITS={maxBlob:4*1024*1024};

/** Desktop end of the mobile remote (MOBILE-DESIGN.md). Paired phones send encrypted requests via
 * the relay; this checks each one against the allowlist below and calls the same invoke() the
 * desktop window uses. Anything not listed is refused. Payloads are rebuilt from known fields, so a
 * phone cannot pass permission modes, rules or note-work grants. Approving on the phone can only
 * mean "this once" or "deny"; standing grants stay a desk decision. */
const pick=(p,keys)=>Object.fromEntries(keys.filter((k)=>p?.[k]!==undefined).map((k)=>[k,p[k]]));
const text=(v,max)=>typeof v==='string'?v.slice(0,max):undefined;
export const REMOTE_METHODS=Object.freeze({
  'bootstrap':()=>({}),
  'conversations.get':(p)=>({id:String(p?.id||'')}),
  'conversations.rename':(p)=>({id:String(p?.id||''),title:text(p?.title,200)}),
  'conversations.pin':(p)=>pick(p,['id','pinned']),
  'chat.send':(p)=>pick(p,['conversationId','text','provider','model','effort','followupMode','projectId','questionId']),
  'chat.cancel':(p)=>({conversationId:String(p?.conversationId||'')}),
  'chat.question.answer':(p)=>pick(p,['conversationId','id','questionId','answers']),
  'chat.question.answerText':(p)=>pick(p,['conversationId','source','answers']),
  'chat.question.continue':(p)=>pick(p,['conversationId','id']),
  'approval.respond':(p)=>({id:String(p?.id||''),decision:p?.decision==='once'||(p?.decision===undefined&&p?.approved===true)?'once':'deny',...(p?.digest?{digest:text(p.digest,64)}:{}),...(text(p?.message,2000)!==undefined?{message:text(p.message,2000)}:{})}),
  'notes.view':()=>({}),
  'notes.phone.view':()=>({}),
  'notes.get':(p)=>({id:String(p?.id||'')}),
  'notes.create':(p)=>pick(p,['title','text']),
  'notes.save':(p)=>pick(p,['id','title','text','revision']),
  'memory.search':(p)=>({query:String(p?.query||'').slice(0,500),newOnly:p?.newOnly===true}),
  'usage.refresh':(p)=>({details:p?.details===true}),
});
const ATTACH_MS=2*60_000,FLUSH_MS=250;
export function phoneApproval(approval){
  const {finish,...value}=approval;
  const sensitive=new Set(['security','permissions','permission','credential','credentials','provider','remote','cloud','update','restart','login','signin','auth','account','extension']);
  const parts=[value.tool,value.kind].flatMap(word=>String(word||'').toLowerCase().split(/[._\s-]+/));
  const large=value.previewTruncated===true||Buffer.byteLength(JSON.stringify(pick(value,['title','explain','detail','target'])),'utf8')>32000;
  const desktopOnly=large||parts.some(part=>sensitive.has(part))||/\b(?:security|permissions?|credentials?|sign[ -]?in|API key)\b/i.test(String(value.title||''));
  return {...pick(value,['id','conversationId','kind','tool','expiresAt']),title:desktopOnly?(large?'Large operation preview: approve on computer':'Account or security action: approve on computer'):value.title,
    ...(!desktopOnly?pick(value,['explain','detail','target']):{}),desktopOnly,digest:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
export function checkPhoneApproval(approval,payload){
  if(!approval)throw Error('This approval is no longer pending.');
  const shown=phoneApproval(approval);
  if(payload.digest!==shown.digest)throw Error('The approval changed. Refresh it on your phone.');
  if(shown.desktopOnly&&payload.decision==='once')throw Error('Approve this account or security change on the computer.');
}

/** The phone loads chats one by one; the full state would not fit a relay message. */
export function trimBootstrap(state){
  const visible=new Set((state.conversations||[]).filter(c=>!c.private).map(c=>c.id));
  return { remote:true, settings:pick(state.settings,['provider','model','effort','memoryEnabled']),
    providers:(state.providers||[]).map(p=>pick(p,['id','name','mode'])),
    connections:(state.connections||[]).map(p=>pick(p,['id','connected','configured','available'])),
    conversations:(state.conversations||[]).filter(c=>!c.private).map(chat=>({...pick(chat,['id','title','provider','updatedAt','pinned']),...phoneWorkCounts(chat),messages:[],messageCount:chat.messages?.length||0,remoteTrimmed:true})),
    activeRuns:(state.activeRuns||[]).filter(r=>visible.has(r.conversationId)).map(r=>pick(r,['conversationId','startedAt'])),
    queues:Object.fromEntries(Object.entries(state.queues||{}).filter(([id])=>visible.has(id)).map(([id,items])=>[id,items.slice(0,10).map(item=>({...pick(item,['id','provider','queuedAt']),text:text(item.text,500)}))])),
    approvals:(state.approvals||[]).filter(a=>!a.conversationId||visible.has(a.conversationId)).map(phoneApproval),usage:state.usage||{},
    memories:[],tools:(state.tools||[]).map(({name,category,enabled})=>({name,category,enabled}))};
}

/** One chat for the phone: recent messages only, text and work details clipped, images/attachments dropped.
 * Long chats with embedded images or huge tool output otherwise exceed the relay message limit. */
export function trimChat(chat,{maxMessages=60,maxBytes=1_500_000}={}){
  if(!chat)return chat;
  if(chat.private)throw Error('This chat is private to the computer.');
  const clip=(v,n)=>typeof v==='string'?(v.length>n?v.slice(0,n)+'\n… (shortened on the phone)':v):undefined;
  const all=chat.messages||[];
  const shape=(m)=>({...pick(m,['id','role','questions']),content:clip(m.content,20000),
    ...(m.followups?.length?{followups:m.followups.slice(-20).map(item=>({...pick(item,['id','provider','model','status','taskStatus','createdAt']),text:clip(item.text,4000),answer:clip(item.answer,20000),summary:clip(item.summary,2000),error:clip(item.error,1000)}))}:{}),
    ...(Array.isArray(m.activity)&&m.activity.length?{activity:m.activity.slice(-30).map(a=>({...pick(a,['title','kind','status']),output:clip(a.output,1500),text:clip(a.text,1500)}))}:{})});
  const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
  const pending=phonePendingQuestions(chat),pendingQuestions=pending.slice(-32);
  while(pendingQuestions.length&&bytes(pendingQuestions)>maxBytes/2)pendingQuestions.shift();
  const result=messages=>({...pick(chat,['id','title','provider','updatedAt','pinned']),messages,pendingQuestions,pendingQuestionsOmitted:pending.length-pendingQuestions.length,earlierOmitted:all.length-messages.length});
  let messages=all.slice(-maxMessages).map(shape);
  while(messages.length>1&&bytes(result(messages))>maxBytes)messages.shift();
  if(bytes(result(messages))>maxBytes)messages=messages.map(({activity,followups,questions,...m})=>m);
  return result(messages);
}

/** Message IDs already handled, persisted so a restart inside the time window cannot replay them. */
export class SeenStore{
  constructor(file,{windowMs=10*60_000,now=()=>Date.now()}={}){Object.assign(this,{file,windowMs,now});this.ids=new Map();this.chain=Promise.resolve();}
  async load(){try{this.ids=new Map(Object.entries(JSON.parse(await readFile(this.file,'utf8'))));}catch(error){if(error.code!=='ENOENT')throw error;this.ids=new Map();}return this;}
  async claim(id){
    const work=this.chain.then(async()=>{
      const t=this.now();for(const [k,v] of this.ids)if(t-v>this.windowMs)this.ids.delete(k);
      if(this.ids.has(id))return false;
      this.ids.set(id,t);
      try{
        await mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';
        await writeFile(tmp,JSON.stringify(Object.fromEntries(this.ids)),{encoding:'utf8',mode:0o600});
        for(let attempt=0;;attempt++)try{await rename(tmp,this.file);break;}catch(error){if(attempt>=2||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,20));}
      }catch(error){this.ids.delete(id);throw error;}
      return true;
    });
    this.chain=work.catch(()=>{});return work;
  }
}

export class RemoteBridge{
  /** getPeers(): active paired phones [{id,boxKey,name}] as the desktop currently knows them.
   * isEnabled(): the "Allow phone control" switch. Both are checked for every message. */
  constructor({client,identity,ownId,getPeers,isEnabled,invoke,seen,drainOnStart=false,now=()=>Date.now(),log=()=>{},limits=RELAY_LIMITS}){
    Object.assign(this,{client,identity,ownId,getPeers,isEnabled,invoke,seen,drainOnStart,now,log,limits});
    this.channels=new Map();this.attached=new Map();this.pending=new Map();this.running=false;
  }
  peer(id){return this.running&&this.isEnabled()?this.getPeers().find((p)=>p.id===id)||null:null;}
  async channel(peer){
    const key=`${peer.id}:${peer.boxKey}`;
    if(!this.channels.has(key)){for(const k of this.channels.keys())if(k.startsWith(peer.id+':'))this.channels.delete(k);this.channels.set(key,openChannel({own:this.identity,ownId:this.ownId,peerId:peer.id,peerBoxKey:peer.boxKey,now:this.now}));}
    return this.channels.get(key);
  }
  forget(peerId){for(const k of [...this.channels.keys()])if(k.startsWith(peerId+':'))this.channels.delete(k);this.attached.delete(peerId);this.pending.delete(peerId);}
  start(){
    if(this.running)return;this.running=true;this.abort=new AbortController();
    this.ready=this.drainOnStart?this.client.resetInbox():Promise.resolve();
    (async()=>{let backoff=1000;
      try{await this.ready;}catch{this.running=false;return;}
      while(this.running){
        try{
          const messages=await this.client.inbox(this.isEnabled()?25:0,this.abort.signal);backoff=1000;
          const done=[];for(const m of messages){if(!this.running)break;done.push(m.seq);const work=await this.receive(m);if(work)work.catch(()=>{});}
          await this.client.ack(done);
          if(!this.isEnabled()&&!messages.length)await new Promise((r)=>setTimeout(r,5000));
        }catch(e){if(!this.running)break;this.log(`remote relay: ${e.code||e.message}`);await new Promise((r)=>setTimeout(r,backoff));backoff=Math.min(backoff*2,30_000);}
      }})();
  }
  stop(){this.running=false;this.abort?.abort();clearTimeout(this.timer);this.timer=null;this.attached.clear();this.pending.clear();}
  /** Opens and de-duplicates in order; returns the (async) handling of an accepted request. */
  async receive({from,blob}){
    const peer=this.peer(from);if(!peer)return null;
    let msg;try{msg=await (await this.channel(peer)).open(blob);}catch{this.log('remote: dropped an unreadable message');return null;}
    if(!await this.seen.claim(`${from}:${msg.id}`))return null;
    const body=msg.body||{};
    if(body.kind==='attach'){this.attached.set(from,this.now()+ATTACH_MS);return null;}
    if(body.kind==='detach'){this.attached.delete(from);return null;}
    if(body.kind!=='invoke'||typeof body.method!=='string')return null;
    return this.call(peer,body);
  }
  async call(peer,{rid,method,payload}){
    let reply;
    try{
      const clean=Object.hasOwn(REMOTE_METHODS,method)?REMOTE_METHODS[method](payload&&typeof payload==='object'?payload:{}):null;
      if(!clean)throw Error('This action is only available on the computer.');
      if(!this.running||!this.peer(peer.id))throw Error('Phone control is off.');
      let value=await this.invoke(method,clean);
      if(method==='bootstrap')value=trimBootstrap(value);
      else if(method==='conversations.get')value=trimChat(value);
      reply={kind:'result',rid,ok:true,value};
    }catch(e){reply={kind:'result',rid,ok:false,error:String(e?.message||'Failed.').slice(0,500)};}
    if(!this.peer(peer.id))return;
    let blob=await (await this.channel(peer)).seal(reply);
    if(blob.length>this.limits.maxBlob)blob=await (await this.channel(peer)).seal({kind:'result',rid,ok:false,error:'This is too large to show on the phone.'});
    if(this.peer(peer.id))await this.client.send(peer.id,blob);
  }
  /** Called for every desktop event; batched per attached phone. */
  event(value){
    if(!/^(chat\.(?:delta|complete|error|cancelled|started|activity|question|followup|queue)|approval(?:\.|$)|state\.changed$|notes\.)/.test(value?.type||''))return;
    // The phone reloads filtered snapshots. Raw deltas and tool output only waste
    // relay bandwidth, and can include fields the phone projection excludes.
    value={type:'state.changed'};
    if(!this.running||!this.attached.size)return;
    const t=this.now();
    for(const [id,until] of this.attached){
      if(until<t||!this.peer(id)){this.attached.delete(id);continue;}
      this.pending.set(id,[value]);
    }
    if(!this.timer)this.timer=setTimeout(()=>this.flush().catch((e)=>this.log(`remote events: ${e.message}`)),FLUSH_MS);
  }
  async flush(){
    this.timer=null;const batches=[...this.pending];this.pending.clear();
    for(const [id,events] of batches){
      const peer=this.peer(id);if(!peer)continue;
      try{
        let blob=await (await this.channel(peer)).seal({kind:'events',events});
        if(blob.length>this.limits.maxBlob)blob=await (await this.channel(peer)).seal({kind:'events',events:[{type:'state.changed'}]});
        if(this.peer(id))await this.client.send(id,blob);
      }catch(e){this.log(`remote events: ${e.message}`);}
    }
  }
}
