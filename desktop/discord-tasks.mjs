import {phoneApproval,checkPhoneApproval} from './remote-bridge.mjs';

export const DISCORD_CONTROLS=/^\/(?:help|start|approve|deny|approvals|answer|questions|status|stop|permissions|project|new)(?:\s|$)/;
export const DISCORD_TASK_HELP='\n\nLocal work (your PC must stay awake):\n/permissions shows your access level\n/permissions full gives this paired account broad access, without routine approval prompts\n/permissions auto-edit allows edits; commands still ask\n/permissions ask asks before actions\n/permissions read-only allows reading only\n/project lists projects; /project ID selects one; /project default selects your workspace\n/status shows progress and queued messages\n/stop stops work and clears queued messages\n/new starts a fresh chat\n/approvals resends outstanding approvals; /approve ID or /deny ID answers one\n/questions resends questions; /answer ID your answer responds (use a JSON object for several questions)\n\nTips: Send follow-up directions while work is running; they queue for the task. Choose Full access only for an account you trust with your computer. Access is saved separately for each paired account and also editable in desktop Settings → Messaging. Changing access stops current work. Deny rules and required account/security confirmations still apply. /help is available while the AI is busy.';
const literal=value=>String(value).replace(/[\\`*_~|>#\[\](){}+\-.!]/g,'\\$&');
// Escape after partitioning so a message boundary cannot split a Markdown escape.
const literalParts=value=>{const parts=[];for(let i=0;i<value.length;i+=800)parts.push(literal(value.slice(i,i+800)));return parts;};

/** Only transport-authenticated DM commands reach this controller. Model output
 * and tool output never enter command(). Approval tickets are bound to the
 * complete delivered operation, originating account, DM, connection and turn. */
export class DiscordTasks {
  constructor({getChat,getApproval,listApprovals,respondApproval,answerQuestion,getRun,projects,workspace,save,setMode,stop,now=()=>Date.now()}) {
    Object.assign(this,{getChat,getApproval,listApprovals,respondApproval,answerQuestion,getRun,projects,workspace,save,setMode,stop,now});
    this.tickets=new Map();this.progress=new Map();this.deliveries=new Map();
  }
  attach(hub){this.hub=hub;}
  chatFor(identity,id){const chat=id&&this.getChat(id);return chat&&chat.channel?.type==='discord'&&chat.channel.chatKey===identity.chatKey&&chat.channel.userId===identity.userId?chat:null;}
  async send(identity,text){if(!this.hub.currentIdentity(identity))throw Error('Discord access was revoked.');return this.hub.sendTask(identity,text);}
  route(chat){return chat?.channel?.type==='discord'?this.hub.taskIdentity(chat.channel):null;}
  async approval(request){
    if(!request)return;
    const chat=this.getChat(request.conversationId),identity=this.route(chat);if(!identity)return;
    const shown=phoneApproval(request),previous=this.tickets.get(request.id),ticket={identity,digest:shown.digest,conversationId:chat.id,delivered:false};
    this.tickets.set(request.id,ticket);
    const body=shown.desktopOnly?`${shown.title}\nThis request needs approval on the computer. You can decline it here.`:
      `${shown.title||'Approval requested'}\nTool: ${shown.tool}\n${shown.target||''}\n${shown.explain?[shown.explain.headline,shown.explain.why,shown.explain.reason].filter(Boolean).join('\n'):''}\n${shown.detail||''}`;
    try{
      const parts=literalParts(body);
      await this.send(identity,[...parts.map((part,index)=>`Approval ${request.id} (${index+1}/${parts.length})\n${part}`),`Approval ${request.id}\nExpires: ${request.expiresAt}\n${shown.desktopOnly?'':`/approve ${request.id}\n`}/deny ${request.id}`]);
      if(this.tickets.get(request.id)===ticket&&this.hub.currentIdentity(identity)&&this.getApproval(request.id))ticket.delivered=true;
      else if(this.tickets.get(request.id)===ticket)this.tickets.delete(request.id);
    }catch{if(this.tickets.get(request.id)===ticket){if(previous?.delivered&&previous.digest===shown.digest&&this.getApproval(request.id)&&this.hub.currentIdentity(identity))this.tickets.set(request.id,previous);else this.tickets.delete(request.id);}}
  }
  async question(identity,group){
    const lines=group.questions.map(q=>`${q.id}: ${q.question}${q.options?.length?'\n'+q.options.map((o,i)=>`${i+1}. ${o.label}${o.description?' : '+o.description:''}`).join('\n'):''}`);
    await this.send(identity,`Question ${group.id}\n${lines.join('\n\n')}\n\n/answer ${group.id} ${group.questions.length===1?'your answer':'{"question-id":"answer",...}'}\nAnswers do not approve actions.`);
  }
  event(event){
    if(event.type==='approval.resolved'){this.tickets.delete(event.id);return;}
    const chat=event.conversationId&&this.getChat(event.conversationId),identity=this.route(chat);if(!identity)return;
    let work;
    if(event.type==='approval')work=()=>this.approval(this.getApproval(event.id));
    else if(event.type==='chat.question'&&['waiting','open'].includes(event.question?.status)){
      const key='question:'+event.question.id;if(this.progress.has(key))return;this.progress.set(key,this.now());work=()=>this.question(identity,event.question);
    }else if(event.type==='chat.activity'||event.type==='chat.segment'){
      const step=event.step;if(!step||!['tool','note','permission'].includes(step.kind))return;
      const previous=this.progress.get(chat.id)||0;if(this.now()-previous<30000)return;
      this.progress.set(chat.id,this.now());work=()=>this.send(identity,'Working: '+String(step.kind==='note'?step.text:step.title||step.text||step.tool||'Local task in progress').slice(0,1400));
    }else return;
    if(this.progress.size>500)this.progress.delete(this.progress.keys().next().value);
    // Preserve message order within a DM, including all chunks of an approval.
    const key=identity.chatKey,next=(this.deliveries.get(key)||Promise.resolve()).catch(()=>{}).then(work).catch(()=>{});
    this.deliveries.set(key,next);next.finally(()=>{if(this.deliveries.get(key)===next)this.deliveries.delete(key);});
  }
  async command(identity,body,conversationId){
    if(!this.hub.currentIdentity(identity))throw Error('Discord access was revoked.');
    const match=/^\/(\S+)(?:\s+([\s\S]*))?$/.exec(body),command=match?.[1],arg=match?.[2]?.trim()||'';
    const chat=this.chatFor(identity,conversationId);
    if(command==='help'||command==='start')return 'Exomina Discord commands\n/ai claude (or chatgpt, gemini, …) switches the AI\n/usage shows subscription usage'+DISCORD_TASK_HELP;
    if(command==='approve'||command==='deny'){
      const ticket=this.tickets.get(arg),request=this.getApproval(arg);
      if(!ticket?.delivered||!request||ticket.identity.userId!==identity.userId||ticket.identity.chatKey!==identity.chatKey||ticket.identity.generation!==identity.generation||ticket.identity.userVersion!==identity.userVersion||!this.chatFor(identity,request.conversationId)||!this.getRun(request.conversationId)||Date.parse(request.expiresAt)<=this.now())throw Error('This approval is expired, undelivered, or belongs to another account or task. Use /approvals.');
      checkPhoneApproval(request,{digest:ticket.digest,decision:command==='approve'?'once':'deny'});
      // Claim before invoking: duplicate commands cannot approve twice.
      this.tickets.delete(arg);const result=await this.respondApproval({id:arg,decision:command==='approve'?'once':'deny',digest:ticket.digest});
      return command==='approve'?(result?.approved===false?'Blocked: '+(result.message||'The task or permission policy changed.'):'Approved once.'):'Declined.';
    }
    if(command==='stop'){this.hub.stopUser(identity);if(chat)this.stop(chat.id);return 'Stopped the task and discarded queued messages. Pending approvals were declined.';}
    if(command==='permissions'){
      if(!arg)return `Discord task permissions: ${chat?.permissionMode||this.hub.taskMode(identity)}. Set with /permissions ask, auto-edit, full or read-only. Full runs routine actions with your Windows account permissions. Deny rules and required confirmations still apply.`;
      if(!['ask','auto-edit','full','read-only'].includes(arg))throw Error('Use /permissions ask, auto-edit, full or read-only.');
      this.hub.stopUser(identity);if(chat){this.stop(chat.id);await this.setMode(chat,arg);}
      await this.hub.setTaskMode(identity,arg);return `Discord task permissions: ${arg}. Active and queued work was stopped so the next task starts with this policy. This changes only your Discord tasks.`;
    }
    if(command==='project'){
      if(!arg)return `Current folder: ${chat?this.workspace(chat):'default workspace'}\nSaved projects:\n${this.projects().map(p=>`${p.id} : ${p.name}`).join('\n')||'(none)'}\nUse /project ID or /project default. The next task starts a fresh chat.`;
      const project=arg==='default'?null:this.projects().find(p=>p.id===arg);if(arg!=='default'&&!project)throw Error('Unknown project. Use /project to list saved project IDs.');
      this.hub.stopUser(identity);if(chat)this.stop(chat.id);await this.hub.setTaskProject(identity,project?.id||'');return 'Selected '+(project?.name||'default workspace')+'. Send the next task to begin a fresh chat.';
    }
    if(command==='new'){this.hub.stopUser(identity);if(chat)this.stop(chat.id);await this.hub.clearTaskChat(identity);return 'Started a fresh chat. Send your next task.';}
    if(!chat){if(command==='status')return 'No task yet. Send a task to start. Use /permissions or /project to configure it.';if(['approvals','questions'].includes(command))return 'No pending requests.';throw Error('Send a task first.');}
    if(command==='status'){
      const run=this.getRun(chat.id),step=run?.message?.activity?.filter(s=>s.kind!=='thinking').at(-1),pending=this.listApprovals().filter(a=>a.conversationId===chat.id);
      return `${run?'Running':'Idle'} · ${chat.permissionMode||'ask'}\nFolder: ${this.workspace(chat)}\n${step?String(step.title||step.text||step.tool||'Working').slice(0,1400):''}\nPending approvals: ${pending.length}\nQueued messages: ${this.hub.queued(identity)}`;
    }
    if(command==='approvals'){const pending=this.listApprovals().filter(a=>a.conversationId===chat.id);for(const request of pending)await this.approval(request);return pending.length?'Pending approvals sent.':'No pending approvals.';}
    const groups=chat.messages.flatMap(m=>m.questions||[]).filter(g=>['waiting','open'].includes(g.status));
    if(command==='questions'){for(const group of groups)await this.question(identity,group);return groups.length?'Pending questions sent.':'No pending questions.';}
    if(command==='answer'){
      const parts=/^(\S+)\s+([\s\S]+)$/.exec(arg),group=groups.find(g=>g.id===parts?.[1]);if(!group)throw Error('Use /questions, then /answer ID your answer.');
      const single=group.questions[0],choice=/^[1-6]$/.test(parts[2])?single.options?.[Number(parts[2])-1]?.label:undefined;
      const answers=group.questions.length===1?{[single.id]:choice||parts[2]}:JSON.parse(parts[2]);
      await this.answerQuestion(chat.id,{id:group.id,answers});return 'Answer delivered.';
    }
    throw Error('Unknown task command. Use /help.');
  }
}
