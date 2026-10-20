import {createHash, randomUUID} from 'node:crypto';
import {describeTool} from './describe.mjs';
import {mergeHelperActivity} from './helper-activity.mjs';

const MAX_STEPS=400,MAX_THINKING=40000,MAX_OUTPUT=4000,MAX_NOTE=20000,MAX_SAVED=400000;
const clip=(value,limit)=>{const text=String(value??'');return text.length>limit?text.slice(0,limit)+'…':text;};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
// Avoid comparing clipped command previews or display labels. Missing arguments
// provide no operation identity, so they never establish a later recovery.
const operationKey=(name,input,context)=>name&&input&&typeof input==='object'&&Object.keys(input).length?createHash('sha256').update(String(name)+'\0'+JSON.stringify(canonical(input))+'\0'+JSON.stringify(canonical(context))).digest('hex'):undefined;

/** Builds a reply's work timeline from provider events and keeps the final answer
 * separate. Text written before a tool call is narration ("note"), not the answer:
 * only text after the last tool call stays in message.content. Steps are stored on
 * the message (persisted with the chat) and mirrored to the renderer as
 * chat.activity / chat.segment events.
 */
export class RunActivity {
  constructor(message,{conversationId,emit,now=()=>Date.now()}){
    Object.assign(this,{message,conversationId,emit,now});
    message.activity=Array.isArray(message.activity)?message.activity:[];
    message.startedAt??=new Date(now()).toISOString();
    this.block=null;
  }
  get steps(){return this.message.activity;}
  stamp(){return new Date(this.now()).toISOString();}
  send(step,extra={}){const {text,...meta}=step;this.emit({type:'chat.activity',conversationId:this.conversationId,step:extra.append!==undefined?meta:step,...extra});}
  add(step){
    if(this.steps.length>=MAX_STEPS){const index=this.steps.findIndex(item=>item.kind!=='thinking'&&item.status!=='running');if(index>=0)this.steps.splice(index,1);}
    this.steps.push(step);this.send(step);return step;
  }
  find(id){return id?this.steps.find(step=>step.id===id):null;}
  /** Helper cards belong to the originating assistant message, including late
   * lifecycle receipts. They are separate from the parent's answer text.
   */
  helper(value){
    const result=mergeHelperActivity(this.message.helpers,value);
    this.message.helpers=result.helpers;
    if(result.omitted)this.message.helpersOmitted=(this.message.helpersOmitted||0)+result.omitted;
    const helper=result.helpers.find(item=>item.id===value?.id);if(!helper)return;
    this.emit({type:'chat.helper',conversationId:this.conversationId,messageId:this.message.id,helper,helpersOmitted:this.message.helpersOmitted||0});return helper;
  }
  /** Replaces native turn snapshots without splitting answer text or ending
   * reasoning. A plan notification is a snapshot, not proof its tasks finished.
   */
  native(data){
    if(!data||!['plan','diff','usage','reroute'].includes(data.kind))return;
    const id=`native:${data.threadId}:${data.turnId}:${data.kind}${data.kind==='reroute'?`:${data.fromModel}:${data.toModel}`:''}`;
    let step=this.find(id);
    const title=data.kind==='plan'?'Task plan':data.kind==='diff'?'File changes':data.kind==='usage'?'Tokens and context':`Model changed to ${data.toModel}`;
    if(step){step.native=data;step.title=title;step.updatedAt=this.stamp();this.send(step);}
    else step=this.add({id,kind:data.kind==='reroute'?'reroute':'native',title,native:data,status:'done',startedAt:this.stamp(),updatedAt:this.stamp(),endedAt:this.stamp()});
    // Multiple continuations can accumulate snapshots. Preserve the current one
    // and a visible record of older snapshots while bounding persisted details.
    let size=this.steps.reduce((sum,item)=>sum+(item.native?JSON.stringify(item.native).length:0),0);
    if(size>200000)for(const previous of this.steps){
      if(previous===step||!previous.native||previous.native.omitted)continue;
      const oldSize=JSON.stringify(previous.native).length;
      previous.native={kind:previous.native.kind,threadId:previous.native.threadId,turnId:previous.native.turnId,omitted:true};
      size-=oldSize-JSON.stringify(previous.native).length;this.send(previous);if(size<=200000)break;
    }
    return step;
  }
  /** Ends any open thinking block; something else is happening now. */
  settleThinking(except){for(const step of this.steps)if(step.kind==='thinking'&&step.status==='running'&&step.id!==except){step.status='done';step.endedAt=this.stamp();this.send(step);}}

  /** Answer text. A new text block after another one gets a paragraph break, so
   * consecutive blocks never run together ("…theme code.The composer…"). */
  delta(text,block){
    if(!text)return '';
    this.settleThinking();
    let value=text;
    if(block&&this.block&&block!==this.block&&this.message.content&&!/\n\s*$/.test(this.message.content))value='\n\n'+value.replace(/^\s+/,'');
    if(block)this.block=block;
    this.message.content+=value;return value;
  }
  /** Moves narration written so far into the timeline. */
  cut(){
    const text=this.message.content.trim();
    if(!text)return;
    const step={id:randomUUID(),kind:'note',text:clip(text,MAX_NOTE),status:'done',startedAt:this.stamp(),endedAt:this.stamp()};
    this.message.content='';this.block=null;
    if(this.steps.length>=MAX_STEPS)this.steps.shift();
    this.steps.push(step);
    this.emit({type:'chat.segment',conversationId:this.conversationId,step});
  }
  thinking({id,text='',done=false,start=false}){
    const key=id||'thinking';
    let step=this.find(key);
    if(!step||step.status!=='running'&&(text||start)){
      if(!text&&!start)return;
      this.cut();this.settleThinking();
      step=this.add({id:step?`${key}:${randomUUID().slice(0,8)}`:key,kind:'thinking',text:'',status:'running',startedAt:this.stamp()});
    }
    if(text&&step.text.length<MAX_THINKING){const append=text.slice(0,MAX_THINKING-step.text.length);step.text+=append;this.send(step,{append});}
    if(done&&step.status==='running'){step.status='done';step.endedAt=this.stamp();this.send(step);}
  }
  /** Provider tool events: {id?, name, input?, status?, output?, detail?}. */
  tool({id,name,input,status,output,detail,helper,nativeToolUseId,nativeThreadId,executionContext,outcomeConfirmed,observational}){
    const legacyDone=!status&&/^(completed|done)$/i.test(String(detail||''));
    const state=status||(legacyDone?'done':'running');
    // Events without an ID complete the newest running step of the same tool.
    let step=this.find(id)||(!id&&state!=='running'?[...this.steps].reverse().find(item=>item.kind==='tool'&&item.status==='running'&&item.name===name):null);
    if(!step){
      if(state!=='running'&&!name)return;
      this.cut();this.settleThinking();
      const described=describeTool(name,input);
      const note=detail&&!/^(working…|working\.\.\.|completed|done)$/i.test(String(detail))?clip(detail,MAX_OUTPUT):undefined;
      step=this.add({id:id||randomUUID(),kind:'tool',name:String(name||'tool').slice(0,120),category:described.kind,title:described.active,doneTitle:described.done,target:described.target,input:input&&typeof input==='object'?clip(JSON.stringify(input,null,2),MAX_OUTPUT):undefined,operationKey:operationKey(name,input,{provider:this.message.provider||'',executionContext:executionContext||null,nativeThreadId:nativeThreadId||null}),detail:note,...(observational===true?{observational:true}:{}),...(helper?{helper}:{}),...(typeof nativeToolUseId==='string'&&nativeToolUseId.length<=300?{nativeToolUseId}:{}),status:'running',startedAt:this.stamp()});
      if(state==='running')return step;
    }
    if(state!=='running'&&step.status==='running'){step.status=state;step.outcomeConfirmed=state==='done'&&outcomeConfirmed===true;step.endedAt=this.stamp();}
    if(observational===true)step.observational=true;
    if(helper)step.helper={...step.helper,...helper};
    if(output!==undefined&&output!==null&&output!=='')step.output=clip(typeof output==='string'?output:JSON.stringify(output,null,2),MAX_OUTPUT);
    this.send(step);return step;
  }
  /** Records how a permission question was settled, on the step it belongs to. */
  permission(text,{denied=false}={}){
    const step=[...this.steps].reverse().find(item=>item.kind==='tool'&&item.status==='running');
    if(step){step.permission=clip(text,400);if(denied){step.status='denied';step.endedAt=this.stamp();}this.send(step);return;}
    this.cut();
    this.add({id:randomUUID(),kind:'status',text:clip(text,400),status:denied?'denied':'done',startedAt:this.stamp(),endedAt:this.stamp()});
  }
  /** Closes the timeline. The provider's final text wins; narration that turns out
   * to be the last thing written becomes the answer instead of a duplicate note. */
  handoff(text){
    this.settleThinking();
    for(const step of this.steps)if(step.status==='running'){step.status='stopped';step.outcomeConfirmed=false;step.endedAt=this.stamp();this.send(step);}
    this.cut();this.add({id:randomUUID(),kind:'status',notice:'handoff',text:clip(text,400),status:'done',startedAt:this.stamp(),endedAt:this.stamp()});this.block=null;
  }
  finish(finalText,{failed=false}={}){
    this.settleThinking();
    for(const step of this.steps)if(step.status==='running'){step.status='stopped';step.outcomeConfirmed=false;step.endedAt=this.stamp();this.send(step);}
    const answer=typeof finalText==='string'?finalText.trim():'';
    const index=this.steps.findLastIndex(step=>step.kind==='note'),last=this.steps[index];
    if(!this.message.content.trim()&&last&&(!answer||last.text.trim()===answer)){this.steps.splice(index,1);this.message.content=last.text;}
    else if(answer)this.message.content=finalText;
    this.message.finishedAt=this.stamp();
    if(!this.steps.length)delete this.message.activity;
    // The timeline is saved with the chat: keep a long run's details from bloating it.
    else if(JSON.stringify(this.steps).length>MAX_SAVED){
      for(const step of this.steps){delete step.input;delete step.output;}
      for(const step of this.steps)if(step.text&&step.text.length>4000)step.text=step.text.slice(0,4000)+'…';
      let saved=JSON.stringify(this.steps).length;
      for(const step of this.steps){
        if(saved<=MAX_SAVED)break;
        if(!step.helper||step.helper.omitted)continue;
        const before=JSON.stringify(step.helper).length;
        step.helper={provider:step.helper.provider,type:step.helper.type,omitted:true};
        saved-=before-JSON.stringify(step.helper).length;
      }
    }
  }
}
