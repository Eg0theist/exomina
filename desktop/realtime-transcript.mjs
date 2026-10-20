const MAX_TEXT=100000;
const MAX_ITEMS=256;
const roleOf=role=>role==='user'?'user':['assistant','model'].includes(role)?'assistant':null;
const textOf=value=>typeof value==='string'?value.slice(0,MAX_TEXT):null;
const idOf=value=>typeof value==='string'&&value.length>0&&value.length<=500?value:null;
const itemText=item=>Array.isArray(item?.content)?item.content.map(part=>{
  if(!part||typeof part!=='object')return '';
  return ['audio','input_audio','output_audio'].includes(part.type)?textOf(part.transcript)||'':['text','input_text','output_text'].includes(part.type)?textOf(part.text)||'':'';
}).join('').slice(0,MAX_TEXT):null;

/** Keep only recognized transcript fields; never forward audio, SDP or arbitrary backend objects. */
export function sanitizeRealtimeTranscriptEvent(raw) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const type=raw.method||raw.type;
  const value=raw.params&&typeof raw.params==='object'?raw.params:raw;
  let role=roleOf(value.role),id=idOf(value.id)||idOf(value.item_id)||idOf(value.itemId),text=null,delta=null,done=false;
  if(type==='thread/realtime/item/started'||type==='thread/realtime/item/completed') {
    const item=value.item;
    if(item?.type!=='transcriptSegment')return null;
    role=roleOf(item.role);id=idOf(item.id);text=textOf(item.text);done=type.endsWith('/completed');
  }else if(type==='thread/realtime/item/transcript/delta') {
    delta=textOf(value.delta);
  }else if(type==='thread/realtime/transcript/delta'||type==='transcript.delta') {
    delta=textOf(value.delta);
  }else if(type==='thread/realtime/transcript/done'||type==='transcript.done') {
    text=textOf(value.text);done=true;
  }else if(type==='conversation.item.input_audio_transcription.delta') {
    role='user';delta=textOf(value.delta);
  }else if(type==='conversation.item.input_audio_transcription.completed') {
    role='user';text=textOf(value.transcript);done=true;
  }else if(['response.audio_transcript.delta','response.output_audio_transcript.delta','response.text.delta','response.output_text.delta'].includes(type)) {
    role='assistant';delta=textOf(value.delta);
  }else if(['response.audio_transcript.done','response.output_audio_transcript.done','response.text.done','response.output_text.done'].includes(type)) {
    role='assistant';text=textOf(value.transcript)??textOf(value.text);done=true;
  }else if(type==='response.output_item.done'||type==='conversation.item.done'||type==='thread/realtime/itemAdded') {
    const item=value.item;
    if(item?.type==='transcriptSegment'&&type==='thread/realtime/itemAdded') {
      role=roleOf(item.role);id=idOf(item.id);text=textOf(item.text);done=true;
    }else{
      if(item?.type!=='message'||(type==='thread/realtime/itemAdded'&&item.status!=='completed'))return null;
      role=roleOf(item.role);id=idOf(item.id);text=itemText(item);done=true;
    }
  }else if(type==='transcript') {
    // The renderer may already have sanitized this event. Do not trust extra properties.
    text=textOf(value.text);delta=textOf(value.delta);done=value.done===true;
  }else return null;
  if(!role&&!(id&&delta!==null))return null;
  if(text===null&&delta===null)return null;
  return {type:'transcript',...(id?{id}:{}),...(role?{role}:{}),...(text!==null?{text}:{}),...(delta!==null?{delta}:{}),done};
}

/** Normalize native canonical/flat and WebRTC transcripts into one session timeline. */
export class RealtimeTranscriptCollector {
  constructor({now=()=>Date.now()}={}) {this.now=now;this.sequence=0;this.items=new Map();this.active=new Map();this.seen=new Map();this.completed=[];}
  consume(raw,{source='webrtc'}={}) {
    const event=sanitizeRealtimeTranscriptEvent(raw);
    if(!event)return [];
    const sourceKey=['native-flat','native-canonical','webrtc'].includes(source)?source:'webrtc';
    const key=event.id?`${sourceKey}:${event.id}`:this.active.get(`${sourceKey}:${event.role}`);
    if(key&&this.seen.has(key))return [];
    let item=key?this.items.get(key):null;
    if(!item){
      if(!event.role)return [];
      const id=event.id||`${sourceKey}-${event.role}-${++this.sequence}`;
      item={id,role:event.role,text:'',key:key||`${sourceKey}:${id}`};
      if(this.items.size>=MAX_ITEMS)this.items.delete(this.items.keys().next().value);
      this.items.set(item.key,item);
      this.active.set(`${sourceKey}:${item.role}`,item.key);
    }
    if(event.role&&event.role!==item.role)return [];
    item.text=event.delta!==undefined?(item.text+event.delta).slice(0,MAX_TEXT):event.done&&!event.text?item.text:event.text??item.text;
    if(!event.done)return [{type:'transcript',id:item.id,role:item.role,text:item.text,done:false}];
    this.items.delete(item.key);
    if(this.active.get(`${sourceKey}:${item.role}`)===item.key)this.active.delete(`${sourceKey}:${item.role}`);
    if(this.seen.size>=MAX_ITEMS)this.seen.delete(this.seen.keys().next().value);
    this.seen.set(item.key,true);
    if(!item.text.trim())return [];
    const at=this.now();
    // Pair equivalent final records once per transport. Same-source repeats are distinct utterances.
    const duplicate=this.completed.find(record=>record.role===item.role&&record.text===item.text&&!record.sources.has(sourceKey)&&at-record.at<=15000);
    if(duplicate){duplicate.sources.add(sourceKey);return [];}
    this.completed.push({id:item.id,role:item.role,text:item.text,sources:new Set([sourceKey]),at});
    if(this.completed.length>MAX_ITEMS)this.completed.shift();
    return [{type:'transcript',id:item.id,role:item.role,text:item.text,done:true}];
  }
  clear(){this.items.clear();this.active.clear();this.seen.clear();this.completed=[];}
}
