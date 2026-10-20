import {randomUUID} from 'node:crypto';

const blockedKeys=new Set(['__proto__','prototype','constructor']);
const secretName=/(?:password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|recovery[_ -]?key)/i;
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const label=(value,fallback,limit=2000)=>typeof value==='string'?value.slice(0,limit):fallback;
const present=value=>value!==undefined&&value!==null;
function keys(value,allowed){for(const key of Object.keys(value))if(!allowed.includes(key)&&present(value[key]))throw Error('Unsupported connector form constraint: '+key);}
function integerLimit(value,key,fallback,max){if(!present(value))return fallback;if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('Unsupported '+key+' limit.');return value;}
function options(value,titles){
  if(!Array.isArray(value)||!value.length||value.length>50)throw Error('Use between one and fifty connector choices.');
  if(titles!=null&&(!Array.isArray(titles)||titles.length!==value.length||titles.some(title=>typeof title!=='string')))throw Error('Invalid connector choice labels.');
  const rows=value.map((entry,index)=>{
    if(typeof entry==='string')return {value:entry,label:titles?.[index]||entry};
    if(!object(entry)||typeof entry.const!=='string'||typeof entry.title!=='string')throw Error('Unsupported connector choice.');
    keys(entry,['const','title']);return {value:entry.const,label:entry.title};
  });
  if(rows.some(row=>row.value.length>2000||row.label.length>2000)||new Set(rows.map(row=>row.value)).size!==rows.length)throw Error('Invalid or duplicate connector choices.');
  return rows;
}

/** A bounded, flat primitive form. Unknown constraints are refused, never silently dropped. */
export function normalizeConnectorForm(params){
  if(!['form','openai/form','openaiForm'].includes(params?.mode))throw Error('This connector request mode is not supported: '+String(params?.mode||'unknown'));
  if(typeof params.serverName!=='string'||!params.serverName||params.serverName.length>200||typeof params.message!=='string'||params.message.length>8000)throw Error('Invalid connector form identity or message.');
  const schema=params.requestedSchema;
  if(!object(schema)||schema.type!=='object'||!object(schema.properties))throw Error('This connector needs an unsupported form structure.');
  keys(schema,['$schema','type','properties','required','additionalProperties','title','description']);
  if(present(schema.additionalProperties)&&schema.additionalProperties!==false)throw Error('Open-ended connector forms are not supported.');
  const entries=Object.entries(schema.properties);
  if(entries.length>20||JSON.stringify(schema).length>40000)throw Error('This connector form is too large.');
  const required=schema.required??[];
  if(!Array.isArray(required)||new Set(required).size!==required.length||required.some(key=>typeof key!=='string'||!own(schema.properties,key)))throw Error('Invalid required connector fields.');
  const fields=entries.map(([name,field])=>{
    if(!name||name.length>100||blockedKeys.has(name)||!object(field))throw Error('Invalid connector field.');
    if(secretName.test(name+' '+(field.title||'')))throw Error('Use the connector’s secure sign-in page for passwords and keys.');
    const result={name,label:label(field.title,name,500),description:label(field.description,'',2000),required:required.includes(name),type:field.type};
    const common=['type','title','description','default'];
    if(field.type==='string'){
      if(present(field.enum)||present(field.oneOf)){
        keys(field,[...common,'enum','enumNames','oneOf']);
        if(present(field.enum)&&present(field.oneOf))throw Error('Ambiguous connector choices.');
        result.options=options(field.oneOf??field.enum,field.enumNames);
      }else{
        keys(field,[...common,'minLength','maxLength','format']);
        result.minLength=integerLimit(field.minLength,'minLength',0,4000);
        result.maxLength=integerLimit(field.maxLength,'maxLength',4000,4000);
        if(result.minLength>result.maxLength)throw Error('Invalid connector text limits.');
        if(present(field.format)&&!['email','uri','date','date-time'].includes(field.format))throw Error('Unsupported connector text format.');
        if(field.format)result.format=field.format;
      }
    }else if(['number','integer'].includes(field.type)){
      keys(field,[...common,'minimum','maximum']);
      for(const key of ['minimum','maximum'])if(present(field[key])){if(typeof field[key]!=='number'||!Number.isFinite(field[key]))throw Error('Invalid connector number limits.');result[key]=field[key];}
      if(present(result.minimum)&&present(result.maximum)&&result.minimum>result.maximum)throw Error('Invalid connector number limits.');
    }else if(field.type==='boolean')keys(field,common);
    else if(field.type==='array'){
      keys(field,[...common,'items','minItems','maxItems']);
      if(!object(field.items))throw Error('Unsupported connector list.');
      keys(field.items,['type','enum','anyOf']);
      if(present(field.items.enum)&&field.items.type!=='string'||present(field.items.enum)&&present(field.items.anyOf))throw Error('Unsupported connector list choices.');
      result.options=options(field.items.anyOf??field.items.enum);
      result.minItems=integerLimit(field.minItems,'minItems',0,50);result.maxItems=integerLimit(field.maxItems,'maxItems',result.options.length,50);
      if(result.minItems>result.maxItems||result.minItems>result.options.length)throw Error('Invalid connector selection limits.');
    }else throw Error('Unsupported connector field type: '+String(field.type));
    // Defaults are suggestions only. The UI starts empty and requires explicit submission.
    return result;
  });
  return {serverName:params.serverName,message:params.message,fields};
}

export function validateConnectorContent(form,content){
  if(!object(content)||Object.keys(content).some(key=>blockedKeys.has(key)||!form.fields.some(field=>field.name===key)))throw Error('Answer only the fields on this connector form.');
  const normalized={};
  for(const field of form.fields){
    if(!own(content,field.name)){if(field.required)throw Error(field.label+' is required.');continue;}
    const value=content[field.name];
    if(field.type==='string'){
      if(typeof value!=='string'||value.length>8000)throw Error(field.label+' must be text.');
      if(field.required&&!value.trim())throw Error(field.label+' is required.');
      if(field.options){if(!field.options.some(option=>option.value===value))throw Error('Choose an option for '+field.label+'.');}
      else{
        const length=Array.from(value).length;
        if(length<field.minLength||length>field.maxLength)throw Error(field.label+' has an invalid length.');
        if(field.format==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw Error('Enter an email address for '+field.label+'.');
        if(field.format==='uri'){try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{throw Error('Enter a web address for '+field.label+'.');}}
        if(field.format==='date'){const date=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw Error('Enter a date for '+field.label+'.');}
        if(field.format==='date-time'){
          const match=/^(\d{4}-\d\d-\d\d)[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value),date=new Date(value.slice(0,10)+'T00:00:00Z');
          if(!match||!Number.isFinite(Date.parse(value))||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==match[1])throw Error('Enter a date and time with a timezone for '+field.label+'.');
        }
      }
    }else if(['number','integer'].includes(field.type)){
      if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isSafeInteger(value)||present(field.minimum)&&value<field.minimum||present(field.maximum)&&value>field.maximum)throw Error('Enter a valid number for '+field.label+'.');
    }else if(field.type==='boolean'){if(typeof value!=='boolean')throw Error('Choose Yes or No for '+field.label+'.');}
    else if(field.type==='array'){
      if(!Array.isArray(value)||value.length<field.minItems||value.length>field.maxItems||new Set(value).size!==value.length||value.some(entry=>typeof entry!=='string'||!field.options.some(option=>option.value===entry)))throw Error('Choose valid options for '+field.label+'.');
    }
    Object.defineProperty(normalized,field.name,{value,enumerable:true,writable:true,configurable:true});
  }
  return normalized;
}

/** Transient values go directly back to the originating connector, never into chat history. */
export class ConnectorForms{
  constructor({getRun,getChat,emit,timeoutMs=300000,setTimer=setTimeout,clearTimer=clearTimeout}){Object.assign(this,{getRun,getChat,emit,timeoutMs,setTimer,clearTimer});this.pending=new Map();}
  view(){return [...this.pending.values()].map(item=>structuredClone(item.request));}
  async request(conversationId,params,{isActive=()=>true}={}){
    const run=this.getRun(conversationId),chat=this.getChat(conversationId);
    if(!run||run.cancelled||chat?.background||chat?.channel||!isActive())return {action:'cancel'};
    let form;try{form=normalizeConnectorForm(params);}catch(error){this.emit({type:'chat.notice',conversationId,text:error.message+' The connector request was declined.'});return {action:'decline'};}
    if(this.pending.size>=8){this.emit({type:'chat.notice',conversationId,text:'Too many connector forms are waiting. The connector request was declined.'});return {action:'decline'};}
    const id=randomUUID(),request={id,conversationId,...form};
    return new Promise(resolve=>{
      const item={request,run,isActive,resolve,threadId:params.threadId};this.pending.set(id,item);
      item.timer=this.setTimer(()=>this.finish(item,{action:'cancel'}),this.timeoutMs);item.timer?.unref?.();
      this.emit({type:'connector.form',request});
    });
  }
  live(item){return this.pending.get(item.request.id)===item&&this.getRun(item.request.conversationId)===item.run&&!item.run.cancelled&&item.isActive();}
  finish(item,result){if(!this.pending.delete(item.request.id))return;this.clearTimer(item.timer);this.emit({type:'connector.resolved',id:item.request.id});item.resolve(result);}
  respond({id,action,content}){
    const item=this.pending.get(id);if(!item)throw Error('This connector form is no longer waiting.');
    if(!this.live(item)){this.finish(item,{action:'cancel'});throw Error('The task that requested this connector form has ended.');}
    if(!['accept','decline','cancel'].includes(action))throw Error('Choose Send, Decline or Cancel.');
    const result=action==='accept'?{action,content:validateConnectorContent(item.request,content)}:{action};
    this.finish(item,result);return {action};
  }
  cancel(conversationId){for(const item of [...this.pending.values()])if(item.request.conversationId===conversationId)this.finish(item,{action:'cancel'});}
  cancelThread(threadId){for(const item of [...this.pending.values()])if(item.threadId===threadId)this.finish(item,{action:'cancel'});}
  close(){for(const item of [...this.pending.values()])this.finish(item,{action:'cancel'});}
}
