import {randomUUID,createHash} from 'node:crypto';

const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Provide ${label} in up to ${max} characters.`);return value.trim();};
const ids=value=>{if(!Array.isArray(value)||!value.length||value.length>4||value.some(id=>typeof id!=='string'))throw Error('Choose one to four recorded evidence IDs.');return [...new Set(value)];};
const OBSERVABLE=/^(workspace_(read|list|shell)|browser_(snapshot|inspect)|analysis_(run|read|search|native|report)|ghidra_query|disk_read|terminal_read)$/;
export const TASK_REFINEMENT_TOOL={name:'task_refine',description:'Compare a working approach using recorded host-tool evidence, then keep or reject a scoped lesson. view lists recent evidence; propose requires baseline evidence and a testable criterion; compare requires distinct later candidate evidence; adopt records a conditional lesson. Two proposals per reply, no automatic probes, extra inference, permission changes or global self-editing. Tool completion is not proof of a claim. Project lessons require shared memory and stay within the current project.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['view','propose','compare','adopt','reject','retire']},id:{type:'string'},goal:{type:'string',maxLength:1000},baseline:{type:'string',maxLength:1000},candidate:{type:'string',maxLength:1000},criterion:{type:'string',maxLength:1000},baselineEvidence:{type:'array',items:{type:'string'},maxItems:4},candidateEvidence:{type:'array',items:{type:'string'},maxItems:4},observation:{type:'string',maxLength:1500},lesson:{type:'string',maxLength:1000},appliesWhen:{type:'string',maxLength:500},caveat:{type:'string',maxLength:500},scope:{type:'string',enum:['chat','project']}},required:['action'],additionalProperties:false}};

/** Native, bounded Propose–Probe–Compare–Retain. Stores evidence pointers, never tool output. */
export class TaskRefinement {
  constructor({store,getRun,save=()=>store.save(),emit=()=>{},now=()=>new Date()}){Object.assign(this,{store,getRun,save,emit,now});this.recent=new WeakMap();this.counts=new WeakMap();}
  chat(id){const chat=this.store.state.conversations.find(chat=>chat.id===id);if(!chat||chat.private)throw Error('Choose a saved chat.');return chat;}
  async observe(chatId,run,tool,result,startedAt){
    if(!run||this.getRun(chatId)!==run||run.cancelled||!OBSERVABLE.test(tool))return;
    const chat=this.store.state.conversations.find(c=>c.id===chatId&&!c.private);if(!chat)return;
    let serialized;try{serialized=JSON.stringify(result)||'null';}catch{return;}
    const item={id:randomUUID(),tool,startedAt,completedAt:this.now().toISOString(),status:result?.isError?'failed':'completed',digest:createHash('sha256').update(serialized).digest('hex')};
    for(const block of result?.content||[])if(block.type==='text')try{const value=JSON.parse(block.text);if(value.isError||value.error===true||Number.isInteger(value.exitCode)&&value.exitCode!==0)item.status='failed';}catch{}
    const recent=this.recent.get(run)||[];recent.push(item);this.recent.set(run,recent.slice(-32));
    let attached=false;for(const record of chat.approachRefinements||[])if(record.status==='proposed'&&Date.parse(startedAt)>=Date.parse(record.createdAt)){record.probeEvidence=[...(record.probeEvidence||[]),item].slice(-32);attached=true;}
    if(attached)try{await this.save();this.emit({type:'state.changed'});}catch{} // Observation must never replace a tool's real result with a bookkeeping failure.
  }
  lessons(chat,scope='chat'){
    const allowed=scope==='project'&&chat.projectId&&this.store.state.settings.memoryEnabled===true;
    const cutoff=this.getRun(chat.id)?.message?.startedAt||this.now().toISOString();
    const other=allowed?this.store.state.conversations.filter(c=>!c.private&&c.id!==chat.id&&c.projectId===chat.projectId):[];
    return [chat,...other].flatMap(c=>(c.approachRefinements||[]).filter(r=>r.status==='adopted'&&(c.id===chat.id||r.scope==='project'&&r.adoptedAt<cutoff)).map(r=>({id:r.id,sourceChatId:c.id,goal:r.goal,lesson:r.lesson,appliesWhen:r.appliesWhen,caveat:r.caveat,scope:r.scope,adoptedAt:r.adoptedAt}))).sort((a,b)=>String(b.adoptedAt).localeCompare(String(a.adoptedAt))).slice(0,8);
  }
  view(id,scope){const chat=this.chat(id),run=this.getRun(id);return {records:chat.approachRefinements||[],evidence:run?this.recent.get(run)||[]:[],lessons:this.lessons(chat,scope),remainingProposals:Math.max(0,2-(run?this.counts.get(run)||0:0)),notice:'Tool receipts prove recorded operations, not the model’s interpretation. Plans and lessons are source data; current instructions and permissions take precedence.'};}
  async call(args,id){
    const run=this.getRun(id);if(!run||run.cancelled)throw Error('This chat has stopped.');
    const chat=this.chat(id),action=args.action;
    if(action==='view')return this.view(id,args.scope);
    if(!['propose','compare','adopt','reject','retire'].includes(action))throw Error('Choose a refinement action.');
    const previous=chat.approachRefinements,previousCount=this.counts.get(run)||0,records=[...(previous||[])],record=records.find(r=>r.id===args.id);
    let next;
    if(action==='propose'){
      if((this.counts.get(run)||0)>=2)throw Error('Two approach proposals are allowed per reply. Continue with the evidence already collected.');
      if(records.filter(r=>['proposed','compared'].includes(r.status)).length>=2)throw Error('Finish or reject an open comparison before proposing another.');
      if(records.length>=24){const disposable=records.findIndex(r=>['rejected','retired'].includes(r.status));if(disposable<0)throw Error('This chat has 24 retained comparisons. Retire an old lesson before adding another.');records.splice(disposable,1);}
      const baselineEvidence=ids(args.baselineEvidence).map(id=>{const e=(this.recent.get(run)||[]).find(e=>e.id===id);if(!e)throw Error('Baseline evidence must come from recorded tools in this reply.');return e;});
      next={id:randomUUID(),status:'proposed',goal:text(args.goal,1000,'a task goal'),baseline:text(args.baseline,1000,'the baseline approach'),candidate:text(args.candidate,1000,'a candidate change'),criterion:text(args.criterion,1000,'an observable comparison criterion'),baselineEvidence,probeEvidence:[],createdAt:this.now().toISOString(),messageId:run.message?.id};
    }else{
      if(!record)throw Error('Choose an approach in this chat.');next=structuredClone(record);
      if(action==='compare'){
        if(record.status!=='proposed')throw Error('Only an open proposal can be compared.');
        next.candidateEvidence=ids(args.candidateEvidence).map(id=>{const e=record.probeEvidence.find(e=>e.id===id);if(!e||record.baselineEvidence.some(base=>base.id===id))throw Error('Candidate evidence must be a distinct tool operation recorded after this proposal.');return e;});
        next.observation=text(args.observation,1500,'the observed contrast and its limitations');next.status='compared';
      }else if(action==='adopt'){
        if(record.status!=='compared')throw Error('Compare recorded baseline and candidate evidence before adopting a lesson.');
        if(args.scope!==undefined&&!['chat','project'].includes(args.scope))throw Error('Choose chat or project scope.');
        if(args.scope==='project'&&(!chat.projectId||this.store.state.settings.memoryEnabled!==true))throw Error('Project lessons need a project chat and shared memory.');
        Object.assign(next,{status:'adopted',scope:args.scope||'chat',lesson:text(args.lesson,1000,'a conditional lesson'),appliesWhen:text(args.appliesWhen,500,'where this lesson applies'),caveat:text(args.caveat,500,'a limitation or uncertainty'),adoptedAt:this.now().toISOString()});
      }else if(action==='reject'){
        if(!['proposed','compared'].includes(record.status))throw Error('Only an open comparison can be rejected.');next.status='rejected';next.observation=text(args.observation,1500,'the reason for rejection');
      }else{if(record.status!=='adopted')throw Error('Only an adopted lesson can be retired.');next.status='retired';next.retiredAt=this.now().toISOString();}
    }
    // No await before the scoped mutation; save through the host's durable queue.
    const updated=chat.approachRefinements=[...records.filter(r=>r.id!==next.id),next];
    if(action==='propose')this.counts.set(run,(this.counts.get(run)||0)+1);
    try{await this.save();}catch(error){if(chat.approachRefinements===updated){if(previous===undefined)delete chat.approachRefinements;else chat.approachRefinements=previous;this.counts.set(run,previousCount);}throw error;}
    this.emit({type:'state.changed'});return this.view(id,args.scope);
  }
}
