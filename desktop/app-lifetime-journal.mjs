import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';

const EVENTS=new Set(['begin','memory','before-quit','will-quit','quit','exit','main-window-close','main-window-closed','window-all-closed','query-session-end','session-end','uncaught-exception','render-process-gone','child-process-gone']);
const REASONS=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure']);
const TYPES=new Set(['Utility','GPU','Sandbox helper','zygote','renderer','browser']);
const STATUSES=new Set(['not-required','independent','failed']);
const ERROR_NAMES=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','AggregateError']);
const ERROR_CODES=new Set(['EPIPE','ECONNRESET','ECONNABORTED','EINVAL','EIO','EPERM','EACCES','ENOENT','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END','ERR_UNHANDLED_ERROR']);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)&&Number.isFinite(Date.parse(value));
function metadata(value){
  const result={};
  for(const key of ['heapMiB','rssMiB','pendingSaves','completedWrites'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<1000000000)result[key]=value[key];
  if(Number.isSafeInteger(value.code))result.code=value.code;
  if(REASONS.has(value.reason))result.reason=value.reason;
  if(TYPES.has(value.processType))result.processType=value.processType;
  if(STATUSES.has(value.lifetimeStatus))result.lifetimeStatus=value.lifetimeStatus;
  if(ERROR_NAMES.has(value.errorName))result.errorName=value.errorName;
  if(ERROR_CODES.has(value.errorCode))result.errorCode=value.errorCode;
  return result;
}
function sanitizeSession(value){
  if(!value||!/^[a-f0-9-]{36}$/.test(value.id||'')||!positive(value.pid)||!positive(value.ppid)||!date(value.startedAt)||!Array.isArray(value.events))return null;
  const events=value.events.filter(item=>item&&EVENTS.has(item.event)&&date(item.at)).slice(-200).map(item=>({event:item.event,at:item.at,...metadata(item)}));
  return {id:value.id,pid:value.pid,ppid:value.ppid,startedAt:value.startedAt,events};
}

/** Small local exit evidence. It never stores error messages, paths or commands. */
export function createAppLifetimeJournal({directory,pid=process.pid,ppid=process.ppid,now=()=>new Date().toISOString(),lifetimeStatus}={}){
  const file=path.join(directory,'app-lifetime.json');let sessions=[];
  try{const text=readFileSync(file,'utf8');if(text.length<=131072){const previous=JSON.parse(text);if(previous.version===1&&Array.isArray(previous.sessions))sessions=previous.sessions.slice(-19).map(sanitizeSession).filter(Boolean);}}catch{}
  const session={id:randomUUID(),pid,ppid,startedAt:now(),events:[]};sessions.push(session);
  function record(event,detail={}){
    if(!EVENTS.has(event))return false;
    session.events.push({event,at:now(),...metadata(detail)});
    let count=sessions.reduce((sum,item)=>sum+item.events.length,0);
    while(count>200){const first=sessions[0];if(!first.events.length){sessions.shift();continue;}first.events.shift();count--;if(!first.events.length&&first!==session)sessions.shift();}
    sessions=sessions.slice(-20);
    try{mkdirSync(directory,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify({version:1,sessions}),{mode:0o600});renameSync(file+'.tmp',file);return true;}catch{return false;}
  }
  record('begin',{lifetimeStatus});
  return {record};
}
