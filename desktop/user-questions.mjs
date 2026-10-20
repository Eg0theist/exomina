import {randomUUID} from 'node:crypto';
import {resolveTextQuestion} from './text-questions.mjs';

// Host asynchronous questions may use title/string options; native Codex
// questions use id/header/question/object options. Both become the same cards.
const questionSchema={type:'object',properties:{id:{type:'string',maxLength:100},header:{type:'string',maxLength:80},question:{type:'string',minLength:1,maxLength:4000},title:{type:'string',minLength:1,maxLength:4000},multiSelect:{type:'boolean'},options:{type:'array',maxItems:6,items:{anyOf:[{type:'string',maxLength:500},{type:'object',properties:{label:{type:'string',maxLength:500},description:{type:'string',maxLength:1500}},required:['label'],additionalProperties:false}]}}},anyOf:[{required:['question']},{required:['title']}],additionalProperties:false};
const inputSchema={type:'object',properties:{questions:{type:'array',minItems:1,maxItems:3,items:questionSchema},wait_seconds:{type:'integer',minimum:10,maximum:300},require_answer:{type:'boolean'}},required:['questions'],additionalProperties:false};
export const QUESTION_TOOLS=[
  {name:'ask_user_question',description:'Exomina interactive question popup and persistent clickable answers. Works in ordinary chat and work, including Codex Default mode. Waits for the user; timer expiry or closing the popup never supplies an answer. Set require_answer:false only for an optional choice. Ask one to three questions, with choices and custom input. Use ask_user_question_async if independent work can continue. Never use this for permissions.',inputSchema},
  {name:'ask_user_question_async',description:'Exomina interactive question popup and clickable cards while independent work continues. Works in Codex Default mode. Set require_answer:true for a decision the task needs; completion then waits for the answer even after the timer. Set require_answer:false for optional preferences. Answers are delivered to this chat as tracked follow-ups. Never use this for permissions.',inputSchema},
  {name:'request_user_input',description:'Ask one to three non-permission questions in a popup with suggested options and custom text, kept in persistent question cards. Blocking questions wait for the user to answer; the countdown never resumes them. Use require_answer:false only for an optional choice, with a 60-second response window (10–300 with wait_seconds). An optional timeout returns an explicit unanswered result; the card stays usable. A timeout is not an answer or approval. Continue independent work, and keep dependent work pending if the answer is required. Never use this for permissions.',inputSchema},
  {name:'request_user_input_async',description:'Ask non-permission questions in a popup and persistent cards while independent work continues. Options and custom text are available. A response timer defaults to 60 seconds; late answers are sent to the originating chat as tracked follow-ups. Set require_answer:true when a decision is needed: independent work may continue, but task completion waits for the answer. Optional questions keep a timed response window and completion reminder. Use question_update if a question no longer matters. Never use this for permissions.',inputSchema},
  {name:'question_update',description:'Mark an unanswered question card no longer relevant after the task or available information changes. Supply its id and a concrete reason; this removes its completion reminder without inventing an answer.',inputSchema:{type:'object',properties:{id:{type:'string',maxLength:100},reason:{type:'string',minLength:1,maxLength:2000}},required:['id','reason'],additionalProperties:false}},
];
export const questionInstructions='When you need a preference, clarification or decision, call Exomina\'s ask_user_question or ask_user_question_async tool so the user gets a popup and persistent clickable choices with custom input. These host tools work in ordinary chat and Codex Default mode. Prefer these names: the native request_user_input name can be restricted to Plan mode. Do not substitute a question and bullet list in prose for the tool. Give the user 60 seconds by default (longer for complex questions), and keep doing independent work while an asynchronous question is open. Never treat a preselected option, elapsed timer or no reply as an answer or permission. Blocking questions wait for an answer after the countdown. For asynchronous questions needed to complete the task, set require_answer:true; keep dependent work pending. Use require_answer:false for optional choices and state any reasonable assumption if none arrives. The user can answer later using the card. Use question_update with a reason when a question stops being relevant. Exomina reminds the user of relevant unanswered questions at task completion. Permission requests must use the separate approval controls.\n';
export const questionTranscript=message=>(message.questions||[]).map(({id,status,questions,answers,reason,createdAt,answeredAt,requireAnswer,waitingForAnswer})=>({id,status,questions,answers,reason,createdAt,answeredAt,requireAnswer,waitingForAnswer}));
export function pendingQuestionContext(messages){
  const pending=messages.flatMap(questionTranscript).filter(group=>['waiting','open'].includes(group.status));
  if(!pending.length)return '';
  return 'Unanswered question cards from earlier work in this chat (source context):\n'+JSON.stringify(pending.slice(-6))+'\nThese cards still accept answers. Use question_update with the card id and a reason if a question no longer matters. Do not treat an unanswered card as a choice or approval.\n';
}

function normalizeQuestions(input){
  if(!Array.isArray(input)||!input.length||input.length>3)throw Error('Ask one to three questions at a time.');
  const ids=new Set();
  return input.map((item,index)=>{
    const question=item?.question??item?.title;
    if(typeof question!=='string'||!question.trim()||question.length>4000)throw Error('Use a clear question of at most 4,000 characters.');
    const id=item.id??'question-'+(index+1);
    if(typeof id!=='string'||!id||id.length>100||ids.has(id)||['__proto__','constructor','prototype'].includes(id))throw Error('Use a different valid id for each question.');
    ids.add(id);
    if(item.options!=null&&(!Array.isArray(item.options)||item.options.length>6))throw Error('Provide up to six options. Custom input is always available.');
    const options=(item.options||[]).map(option=>{
      const label=typeof option==='string'?option:option?.label,description=typeof option==='object'?option?.description:undefined;
      if(typeof label!=='string'||!label.trim()||label.length>500||description!==undefined&&(typeof description!=='string'||description.length>1500))throw Error('Use short option labels and descriptions.');
      return {label:label.trim(),...(description?{description}: {})};
    });
    if(new Set(options.map(option=>option.label)).size!==options.length)throw Error('Use different option labels.');
    if(item.multiSelect!==undefined&&typeof item.multiSelect!=='boolean')throw Error('Use a boolean for multiple-choice selection.');
    return {id,header:String(item.header||'').slice(0,80),question:question.trim(),options,...(item.multiSelect?{multiSelect:true}:{})};
  });
}

/** Questions are persistent conversation data. They never grant tool permissions. */
export class UserQuestions{
  constructor({getRun,getChat,save,emit,deliver,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}){
    Object.assign(this,{getRun,getChat,save,emit,deliver,now,setTimer,clearTimer});this.windows=new Map();this.deliveries=new Map();
  }
  stamp(){return new Date(this.now()).toISOString();}
  publish(parent,message,group){this.emit({type:'chat.question',conversationId:parent,messageId:message.id,question:structuredClone(group)});}
  find(parent,id){const chat=this.getChat(parent);for(const message of chat.messages||[]){const group=message.questions?.find(item=>item.id===id);if(group)return {message,group};}throw Error('This question does not belong to this chat.');}
  windowFor(parent,group){const window=this.windows.get(group.id);return window?.parent===parent&&window.group===group?window:undefined;}
  async ask(parent,args,{wait=true}={}){
    const run=this.getRun(parent);if(!run||run.cancelled)throw Error('The task has stopped.');
    if(this.getChat(parent).messages.flatMap(message=>message.questions||[]).filter(item=>['waiting','open'].includes(item.status)).length>=6)throw Error('Resolve an earlier question before asking more.');
    const questions=normalizeQuestions(args.questions),seconds=args.wait_seconds??60;
    if(!Number.isInteger(seconds)||seconds<10||seconds>300)throw Error('Choose a response window from 10 to 300 seconds.');
    if(args.require_answer!==undefined&&typeof args.require_answer!=='boolean')throw Error('Use a boolean to indicate whether the task needs an answer.');
    const requireAnswer=args.require_answer??wait;
    run.activity?.cut();
    const activityAfterId=run.message.activity?.at(-1)?.id;
    const group={id:randomUUID(),questions,status:'waiting',requireAnswer,waitingForAnswer:requireAnswer,createdAt:this.stamp(),expiresAt:new Date(this.now()+seconds*1000).toISOString(),waitSeconds:seconds,...(activityAfterId?{activityAfterId}:{})};
    run.message.questions??=[];run.message.questions.push(group);
    const window={parent,message:run.message,group,wait,settled:false};
    window.done=new Promise(resolve=>window.resolve=resolve);this.windows.set(group.id,window);
    const step={id:'question:'+group.id,kind:'question',questionId:group.id,status:'done',startedAt:group.createdAt};
    if(run.activity)run.activity.add(step);else{run.message.activity??=[];run.message.activity.push(step);}
    try{await this.save();}catch(error){this.windows.delete(group.id);run.message.questions=run.message.questions.filter(item=>item!==group);run.message.activity=run.message.activity.filter(item=>item!==step);window.resolve({status:'cancelled',answers:{}});throw error;}
    if(window.settled)return wait?window.done:this.result(group);
    this.publish(parent,run.message,group);
    window.timer=this.setTimer(()=>{this.expire(window).catch(()=>{});},Math.max(0,Date.parse(group.expiresAt)-this.now()));window.timer?.unref?.();
    return wait?window.done:this.result(group);
  }
  result(group,status=group.status){return {id:group.id,status,require_answer:!!group.requireAnswer,waiting_for_answer:!!group.waitingForAnswer,answers:group.answers||{},...(group.deliveryState?{deliveryState:group.deliveryState}:{}),...(group.deliveryError?{deliveryError:group.deliveryError}:{}),pending:['waiting','open','unanswered','cancelled'].includes(status),notice:group.status==='answered'?'The user supplied these answers. They do not grant tool permissions.':group.status==='irrelevant'?'This question is no longer relevant: '+group.reason:'No answer has been supplied. A timer or skipped window is not an answer or approval. The question card remains available for later input.'};}
  async expire(window){
    if(window.settled)return;
    if(!window.group.requireAnswer)return this.release(window,'unanswered');
    // The response countdown is a reminder, not permission to resume a task
    // that needs a decision. Keep the original tool and native turn waiting.
    this.clearTimer(window.timer);window.timer=undefined;
    window.group.status='open';window.group.responseWindowEndedAt=this.stamp();
    this.publish(window.parent,window.message,window.group);await this.save();
  }
  async release(window,status){
    if(window.settled)return;
    window.settled=true;this.clearTimer(window.timer);this.windows.delete(window.group.id);
    window.group.waitingForAnswer=false;
    if(window.group.status==='waiting')window.group.status='open';
    // Once a response window closes, a later answer belongs to its follow-up.
    // Saving can yield to that answer, so keep the native result fixed here.
    const result=structuredClone(this.result(window.group,status));
    this.publish(window.parent,window.message,window.group);
    try{await this.save();}finally{window.resolve(result);}
  }
  async continue(parent,id){const {message,group}=this.find(parent,id),window=this.windowFor(parent,group);if(window&&group.requireAnswer)throw Error('This task needs your answer. Answer the question or stop the task; closing the popup keeps it waiting.');group.windowOutcome='continued';if(window)await this.release(window,'unanswered');else if(group.status==='waiting'){group.status='open';await this.save();this.publish(parent,message,group);}return this.result(group);}
  async retire(parent,{id,reason}){
    const {message,group}=this.find(parent,id);
    if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw Error('Explain why the question is no longer relevant.');
    if(group.status==='answered')throw Error('This question already has an answer.');
    group.status='irrelevant';group.reason=reason.trim();const window=this.windowFor(parent,group);
    if(window)await this.release(window,'irrelevant');else{await this.save();this.publish(parent,message,group);}
    return {id,status:group.status,reason:group.reason};
  }
  async answer(parent,{id,answers}){
    const {message,group}=this.find(parent,id);
    const deliveryKey=parent+':'+id;
    if(group.status==='irrelevant')throw Error('This question no longer affects the task. Send a normal message to discuss it.');
    if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).some(key=>!group.questions.some(q=>q.id===key)))throw Error('Answer the questions shown on this card.');
    const normalized={};
    for(const question of group.questions){const value=answers[question.id];if(typeof value!=='string'||!value.trim()||value.length>4000)throw Error('Give an answer of at most 4,000 characters for each question.');normalized[question.id]={answers:[value.trim()]};}
    if(group.status==='answered'){
      if(JSON.stringify(group.answers)!==JSON.stringify(normalized))throw Error('This answer was already sent. Add any correction as a normal message.');
      if(group.deliveryState!=='failed')return this.result(group);
    }else{
      group.answers=normalized;group.status='answered';group.answeredAt=this.stamp();
      const window=this.windowFor(parent,group);group.deliveryState=window?.wait?'returned':'sending';
      if(window?.wait){await this.release(window,'answered');return this.result(group);}
      if(window){
        // Admission of the answer as a follow-up must finish before closing the
        // window; otherwise task completion can race a last-second answer.
        window.settled=true;this.clearTimer(window.timer);
        group.waitingForAnswer=false;
        const delivery=this.deliverAnswer(parent,message,group).finally(()=>{this.windows.delete(id);this.deliveries.delete(deliveryKey);window.resolve(this.result(group));});
        this.deliveries.set(deliveryKey,delivery);return delivery;
      }else{await this.save();this.publish(parent,message,group);}
    }
    if(this.deliveries.has(deliveryKey))return this.deliveries.get(deliveryKey);
    const delivery=this.deliverAnswer(parent,message,group).finally(()=>this.deliveries.delete(deliveryKey));this.deliveries.set(deliveryKey,delivery);return delivery;
  }
  async answerText(parent,{source,answers}){
    const chat=this.getChat(parent),message=chat.messages?.find(item=>item.id===source?.messageId);
    const group=resolveTextQuestion(message,source);
    // Validate before persisting anything. Answer text is user input, never an
    // authorization to execute a tool. The normal tracked answer route handles it.
    if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length!==1||typeof answers.answer!=='string'||!answers.answer.trim()||answers.answer.length>4000)throw Error('Choose or write an answer of at most 4,000 characters.');
    if(!message.questions?.some(item=>item.id===group.id)){
      message.questions??=[];message.questions.push(group);
      try{await this.save();}catch(error){message.questions=message.questions.filter(item=>item!==group);throw error;}
      this.publish(parent,message,group);
    }
    return this.answer(parent,{id:group.id,answers});
  }
  async deliverAnswer(parent,message,group){
    group.deliveryState='sending';delete group.deliveryError;await this.save();this.publish(parent,message,group);
    const text='Your '+(group.questions.length===1?'answer':'answers')+' to:\n'+group.questions.map(question=>question.question+'\nUser answer: '+group.answers[question.id].answers[0]).join('\n\n')+'\nUse these answers for the current task if relevant. They do not grant tool permissions. If work was already completed, explain what this answer changes before making any changes.';
    try{const receipt=await this.deliver(parent,text,{questionId:group.id});group.deliveryState='delivered';group.receipt=receipt;}
    catch(error){group.deliveryState='failed';group.deliveryError=String(error.message||error).slice(0,1500);}
    await this.save();this.publish(parent,message,group);return this.result(group);
  }
  async waitForWindow(parent){
    for(;;){const windows=[...this.windows.values()].filter(item=>item.parent===parent);if(!windows.length)return;await Promise.all(windows.map(item=>item.done));}
  }
  async finish(parent,result){
    const run=this.getRun(parent);if(!run)return result;
    const pending=this.getChat(parent).messages.flatMap(message=>(message.questions||[]).filter(group=>['waiting','open'].includes(group.status)).map(group=>({message,group})));
    if(!pending.length)return result;
    for(const {message,group} of pending){group.remindedAt=this.stamp();this.publish(parent,message,group);}
    await this.save();
    const reminder='Questions still awaiting your answer:\n'+pending.flatMap(({group})=>group.questions.map(question=>'- '+question.question)).join('\n')+'\nYou can answer using the question cards in this chat.';
    return {...result,text:String(result.text||'')+'\n\n'+reminder};
  }
  async cancel(parent){for(const window of [...this.windows.values()])if(window.parent===parent)await this.release(window,'cancelled');}
  async restore(chats){
    let changed=false;
    for(const chat of chats)for(const message of chat.messages||[])for(const group of message.questions||[]){
      if(group.status==='waiting'){group.status='open';changed=true;}
      if(group.waitingForAnswer){group.waitingForAnswer=false;changed=true;}
      if(group.status==='answered'&&group.deliveryState==='sending'){
        const acceptedMessage=chat.messages.find(entry=>entry.role==='user'&&entry.questionId===group.id);
        const acceptedFollowup=chat.messages.flatMap(entry=>entry.followups||[]).find(entry=>entry.questionId===group.id);
        if(acceptedMessage||acceptedFollowup){group.deliveryState='delivered';group.receipt={conversationId:chat.id,...(acceptedFollowup?{followup:acceptedFollowup.id}:{})};delete group.deliveryError;}
        else{group.deliveryState='failed';group.deliveryError='The app closed before sending your saved answer was confirmed. You can retry it here.';}
        changed=true;
      }
    }
    if(changed)await this.save();
  }
  close(){for(const window of this.windows.values()){this.clearTimer(window.timer);window.resolve(this.result(window.group,'cancelled'));}this.windows.clear();}
}
