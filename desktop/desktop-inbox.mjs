import {createHash} from 'node:crypto';
import {phoneApproval,checkPhoneApproval} from './remote-bridge.mjs';
import {inspectionValue} from './app-inspection.mjs';

const waiting=group=>group&&['waiting','open'].includes(group.status);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const literal=value=>String(value).replace(/[\\`*_~|>#\[\](){}+\-.!]/g,'\\$&');
const parts=value=>{const result=[],points=Array.from(value);for(let i=0;i<points.length;i+=700)result.push(points.slice(i,i+700).join(''));return result;};
const unsafe=value=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)||value.includes('```')||inspectionValue(value)!==value;
const same=(a,b)=>a&&b&&a.userId===b.userId&&a.chatKey===b.chatKey&&a.generation===b.generation&&a.userVersion===b.userVersion;

export class DesktopInbox {
  constructor({getChat,listChats=()=>[],getApproval,listApprovals=()=>[],respondApproval,answerQuestion,getRun,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,delayMs=60_000}) {
    Object.assign(this,{getChat,listChats,getApproval,listApprovals,respondApproval,answerQuestion,getRun,now,setTimer,clearTimer,delayMs});
    this.pending=new Map();this.tickets=new Map();
  }
  attach(hub){this.hub=hub;}
  identity(){return this.hub?.desktopIdentity();}
  chat(id){const chat=this.getChat(id);return chat&&!chat.private&&!chat.archived&&!chat.channel?chat:null;}
  current(item){
    if(!same(item.identity,this.identity()))return null;
    const chat=this.chat(item.conversationId);if(!chat)return null;
    if(item.kind==='approval'){
      const request=this.getApproval(item.id);
      return request?.conversationId===chat.id&&this.getRun(chat.id)&&Date.parse(request.expiresAt)>this.now()?request:null;
    }
    return (chat.messages||[]).flatMap(message=>message.questions||[]).find(group=>group.id===item.id&&waiting(group))||null;
  }
  cancel(key){const item=this.pending.get(key);if(item?.timer)this.clearTimer(item.timer);this.pending.delete(key);this.tickets.delete(key);}
  rescan(){
    for(const [key,item]of this.pending)if(!this.current(item))this.cancel(key);
    if(!this.identity())return;
    for(const request of this.listApprovals())if(this.chat(request.conversationId)&&this.getRun(request.conversationId)&&Date.parse(request.expiresAt)>this.now())this.event({type:'approval',...request});
    for(const chat of this.listChats())if(this.chat(chat.id))for(const question of (chat.messages||[]).flatMap(message=>message.questions||[]))if(waiting(question))this.event({type:'chat.question',conversationId:chat.id,question});
  }
  event(event){
    if(event.type==='approval.resolved'){this.cancel('approval:'+event.id);return;}
    if(event.type==='chat.question'&&!waiting(event.question)){this.cancel('question:'+event.question?.id);return;}
    if(event.type==='messaging.status'){const identity=this.identity();if(!same(identity,this.lastIdentity)){this.lastIdentity=identity;this.rescan();}return;}
    const kind=event.type==='approval'?'approval':event.type==='chat.question'?'question':null;
    if(!kind)return;
    const id=kind==='approval'?event.id:event.question?.id,identity=this.identity(),conversationId=event.conversationId;
    if(!id||!identity||!this.chat(conversationId))return;
    const key=kind+':'+id;if(this.pending.has(key))return;
    if(this.pending.size>=200){const stale=[...this.pending].find(([,item])=>!this.current(item));if(stale)this.cancel(stale[0]);else{this.overflow=true;return;}}
    const item={kind,id,conversationId,identity,timer:null};
    this.pending.set(key,item);
    item.timer=this.setTimer(()=>this.deliver(item),this.delayMs);item.timer?.unref?.();
  }
  deliver(item){
    if(item.delivering)return item.delivering;
    const job=this.send(item).finally(()=>{if(item.delivering===job)item.delivering=null;});item.delivering=job;return job;
  }
  async send(item){
    const key=item.kind+':'+item.id;if(item.timer)this.clearTimer(item.timer);item.timer=null;
    if(this.pending.get(key)!==item)return;
    const value=this.current(item);if(!value){this.cancel(key);return;}
    const rawTitle=String(this.chat(item.conversationId)?.title||'Desktop chat').slice(0,100),title=unsafe(rawTitle)?'Desktop chat':rawTitle;
    let body,command,stamp,desktopOnly=false;
    if(item.kind==='approval'){
      const shown=phoneApproval(value);stamp=shown.digest;
      body=shown.desktopOnly?`${shown.title}\nReview this request on the computer. You can decline it here.`:
        [shown.title,'Tool: '+shown.tool,shown.target,...[shown.explain?.headline,shown.explain?.why,shown.explain?.reason],shown.detail].filter(Boolean).join('\n');
      desktopOnly=shown.desktopOnly||unsafe(body)||Buffer.byteLength(body,'utf8')>6_000;
      if(desktopOnly)body='This request needs its full preview on the computer. You can decline it here.';
      command=`Expires: ${value.expiresAt}\n${desktopOnly?'':`/desktop approve ${item.id}\n`}/desktop deny ${item.id}`;
    }else{
      if(!Array.isArray(value.questions)||value.questions.length<1)return this.cancel(key);
      stamp=digest(value);
      body=value.questions.map(question=>`${question.id}: ${question.question}${question.options?.length?'\n'+question.options.map((option,index)=>`${index+1}. ${option.label}${option.description?' : '+option.description:''}`).join('\n'):''}`).join('\n\n');
      desktopOnly=unsafe(body)||Buffer.byteLength(body,'utf8')>6_000;
      if(desktopOnly)body='This question needs to be reviewed and answered on the computer.';
      command=desktopOnly?'Open Exomina to answer this question.':`/desktop answer ${item.id} ${value.questions.length===1?'your answer':value.questions.map(q=>q.id+'=your answer').join('; ')}\nYour answer resumes the task under its current permissions. Full access may act without another prompt.`;
    }
    const previous=this.tickets.get(key),ticket={...item,digest:stamp,desktopOnly,delivered:false};this.tickets.set(key,ticket);
    const payload=parts(body);
    try{
      await this.hub.sendTask(item.identity,[...payload.map((part,index)=>`Desktop ${item.kind} ${item.id} (${index+1}/${payload.length})\n${literal(title)}\n\`\`\`text\n${part}\n\`\`\``),command],{validate:()=>{const live=this.current(item);return this.pending.get(key)===item&&!!live&&stamp===(item.kind==='approval'?phoneApproval(live).digest:digest(live));}});
      const live=this.current(item),liveDigest=live&&(item.kind==='approval'?phoneApproval(live).digest:digest(live));
      if(this.tickets.get(key)===ticket&&this.pending.get(key)===item&&stamp===liveDigest)ticket.delivered=true;
      else this.tickets.delete(key);
    }catch{const live=this.current(item),liveDigest=live&&(item.kind==='approval'?phoneApproval(live).digest:digest(live));if(previous?.delivered&&previous.digest===liveDigest&&same(previous.identity,this.identity())&&this.pending.get(key)===item)this.tickets.set(key,previous);else if(this.tickets.get(key)===ticket)this.tickets.delete(key);}
  }
  async command(identity,body){
    if(!same(identity,this.identity()))throw Error('Desktop requests are disabled for this account. Enable them in Settings → Messaging.');
    const match=/^\/desktop(?:\s+(approve|deny|answer)\s+(\S+)(?:\s+([\s\S]+))?)?\s*$/.exec(body);
    if(!match)throw Error('Use /desktop, /desktop approve ID, /desktop deny ID or /desktop answer ID your answer.');
    if(!match[1]){
      this.overflow=false;this.rescan();
      const items=[...this.pending.values()].filter(item=>this.current(item));
      for(const item of items)await this.deliver(item);
      return this.overflow?'First 200 desktop requests sent. More requests remain on the computer.':items.length?'Pending desktop requests sent.':'No pending desktop requests.';
    }
    const action=match[1],key=(action==='answer'?'question:':'approval:')+match[2],ticket=this.tickets.get(key),value=ticket&&this.current(ticket);
    if(!ticket?.delivered||!value||!same(ticket.identity,identity))throw Error('This desktop request expired, changed or was not delivered. Use /desktop.');
    if(ticket.desktopOnly&&action!=='deny')throw Error('Review and answer this request on the computer.');
    if(action==='answer'){
      if(digest(value)!==ticket.digest)throw Error('This question changed. Use /desktop before answering.');
      const response=match[3]?.trim();if(!response)throw Error('Include your answer after the question ID.');
      const single=value.questions[0];let answers;
      if(value.questions.length===1)answers={[single.id]:response};
      else try{answers=response.trim().startsWith('{')?JSON.parse(response.replace(/[“”]/g,'"')):Object.fromEntries(response.split(';').map(part=>{const split=part.indexOf('=');if(split<1)throw Error();return[part.slice(0,split).trim(),part.slice(split+1).trim()];}));}catch{throw Error('Answer each question as '+value.questions.map(q=>q.id+'=your answer').join('; '));}
      if(!answers||Array.isArray(answers)||Object.getPrototypeOf(answers)!==Object.prototype||Object.keys(answers).length!==value.questions.length||value.questions.some(q=>typeof answers[q.id]!=='string'||!answers[q.id].trim()))throw Error('Include one text answer for each question: '+value.questions.map(q=>q.id).join(', '));
      for(const question of value.questions){const answer=answers[question.id].trim();answers[question.id]=/^\d+$/.test(answer)?question.options?.[Number(answer)-1]?.label||answer:answer;}
      this.tickets.delete(key);
      const result=await this.answerQuestion(ticket.conversationId,{id:value.id,answers});
      this.pending.delete(key);
      return result?.deliveryState==='failed'?'Answer saved; delivery to the task failed. Open Exomina to continue.':'Answer saved for the desktop task.';
    }
    checkPhoneApproval(value,{digest:ticket.digest,decision:action==='approve'?'once':'deny'});
    this.cancel(key);
    const result=await this.respondApproval({id:value.id,decision:action==='approve'?'once':'deny',digest:ticket.digest});
    return action==='deny'?'Declined the desktop request.':result?.approved===false?'Blocked: '+(result.message||'The request or permission policy changed.'):'Approved once for the desktop task.';
  }
  close(){for(const key of [...this.pending.keys()])this.cancel(key);}
}
