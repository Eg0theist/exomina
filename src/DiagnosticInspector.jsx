import React, {memo,useId,useMemo,useState} from 'react';
import {ChevronRight,Clock3,Gauge,Search} from 'lucide-react';
import {toolActivityState} from '../desktop/activity-visibility.mjs';
import {formatDuration} from '../desktop/describe.mjs';
import './diagnostic-inspector.css';
import {contextMetricsView} from '../desktop/context-metrics.mjs';

const FIELD_LIMIT=24000, PAGE_SIZE=30;
const textOf=value=>{if(value===undefined||value===null)return '';try{return typeof value==='string'?value:JSON.stringify(value,null,2);}catch{return '[This field could not be displayed.]';}};
// chat.activity replaces the changed step object; unchanged records keep identity.
const fieldCache=new WeakMap(),searchCache=new WeakMap();
const fieldsOf=step=>{
 let fields=fieldCache.get(step);
 if(!fields){fields=[['Request',step.input],['Result',step.output],['Detail',step.detail],['Update',step.text],['Provider data',step.native],['Permission',step.permission]].map(([label,value])=>({label,text:textOf(value)})).filter(field=>field.text);fieldCache.set(step,fields);}
 return fields;
};
const searchText=step=>{let text=searchCache.get(step);if(text===undefined){text=[step.kind,step.status,step.name,step.title,step.target,...fieldsOf(step).map(field=>field.text.slice(0,FIELD_LIMIT))].join(' ').toLocaleLowerCase();searchCache.set(step,text);}return text;};
const typeOf=step=>step.kind==='native'||step.kind==='reroute'?'provider':step.kind==='tool'?'tool':step.kind==='thinking'?'thinking':'update';
const byteCount=value=>Number.isSafeInteger(value)&&value>=0?`${value.toLocaleString()} bytes`:'Unknown';

function HostContextMetrics({value}){
 const latest=value.snapshots.at(-1);
 return <section aria-label="Host request context"><h4>Host request context</h4><p className="diagnostic-note">Text Exomina supplied before each host request to an adapter. Internal model requests and tool loops are not measured here. This excludes provider instructions, native tool schemas, images and earlier session state. Cache markers are hints supplied to the adapter, which may ignore them; they do not establish a cache hit, token use or savings.</p><dl className="diagnostic-timing"><div><dt>Latest prompt</dt><dd>{byteCount(latest.promptBytes)}</dd></div><div><dt>Conversation memory view</dt><dd>{byteCount(latest.treeViewBytes)}</dd></div><div><dt>Session resumed</dt><dd>{latest.resumedSession?'Yes':'No'}</dd></div><div><dt>Cache-marked text</dt><dd>{byteCount(latest.cacheMarkedBytes)}</dd></div></dl><details><summary>{value.requests.toLocaleString()} host {value.requests===1?'attempt':'attempts'} recorded{value.omitted?` · ${value.omitted.toLocaleString()} older snapshots omitted`:''}</summary><ol className="diagnostic-events">{value.snapshots.map(snapshot=><li className="diagnostic-event" key={snapshot.sequence}><p>Attempt {snapshot.sequence} · {snapshot.provider} · {snapshot.lane} · {byteCount(snapshot.promptBytes)} · {snapshot.resumedSession?'resumed session':'new session'}</p><p className="diagnostic-note">Memory view: {byteCount(snapshot.treeViewBytes)}. Cache-marked text: {byteCount(snapshot.cacheMarkedBytes)}{snapshot.cacheMarkedBlocks!==null?` in ${snapshot.cacheMarkedBlocks} blocks`:''}.</p></li>)}</ol></details></section>;
}

const EventRow=memo(function EventRow({step,index}){
 const [open,setOpen]=useState(false),state=step.kind==='tool'?toolActivityState(step):step.status||'recorded';
 const started=Date.parse(step.startedAt||''),ended=Date.parse(step.endedAt||''),duration=ended-started;
 const time=Number.isFinite(started)?new Date(started).toLocaleTimeString():'';
 const fields=open?fieldsOf(step):[];
 return <li className={`diagnostic-event diagnostic-${state}`}>
  <button type="button" className="diagnostic-event-head" aria-expanded={open} onClick={()=>setOpen(!open)}><span className="diagnostic-index">{index+1}</span><span><strong>{step.name||step.title||step.kind||'Event'}</strong><small>{step.kind||'event'} · {state}{time?' · '+time:''}{Number.isFinite(duration)&&duration>=0?' · '+(formatDuration(duration)||'under 1s'):''}</small></span><ChevronRight size={14} className={open?'is-open':''}/></button>
  {open&&<div className="diagnostic-event-body">{step.title&&step.name&&<p>{step.title}</p>}{step.target&&<p className="diagnostic-target">{step.target}</p>}{fields.map(({label,text})=><section key={label}><h4>{label}</h4><pre tabIndex={0} aria-label={label+' payload'}>{text.slice(0,FIELD_LIMIT)}</pre>{text.length>FIELD_LIMIT&&<p className="diagnostic-limit">Showing the first {FIELD_LIMIT.toLocaleString()} of {text.length.toLocaleString()} recorded characters.</p>}</section>)}{!fields.length&&<p>No additional payload was recorded for this event.</p>}</div>}
 </li>;
});

/** Inspects existing presentation records. It does not request provider internals. */
export default function DiagnosticInspector({message}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[kind,setKind]=useState('all'),[limit,setLimit]=useState(PAGE_SIZE),resultId=useId();
 const steps=Array.isArray(message?.activity)?message.activity:[],terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 const searchable=useMemo(()=>open?steps.map((step,index)=>({step,index})):[],[open,steps]);
 const rows=searchable.filter(row=>(kind==='all'||typeOf(row.step)===kind)&&terms.every(term=>searchText(row.step).includes(term)));
 const timings=[['Preparation',message?.timing?.prepareMs],['Runtime ready',message?.timing?.runtimeMs],['First output',message?.timing?.firstOutputMs]].filter(([,value])=>Number.isFinite(value)&&value>=0);
 const context=open?contextMetricsView(message?.contextMetrics):null;
 return <details className="diagnostic-inspector" onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary><Gauge size={14}/><strong>Diagnostics</strong><span>{steps.length} recorded events</span></summary>
  {open&&<div className="diagnostic-content"><p className="diagnostic-note">Recorded details for this reply. Provider internals and fields that were never supplied are unavailable. Saved history may omit older events.</p>
   {context&&<HostContextMetrics value={context}/>}
   {!!timings.length&&<dl className="diagnostic-timing">{timings.map(([label,value])=><div key={label}><dt><Clock3 size={11}/>{label}</dt><dd>{(value/1000).toFixed(2)}s</dd></div>)}</dl>}
   <div className="diagnostic-filters"><label><Search size={13}/><input aria-label="Search recorded events" aria-describedby={resultId} type="search" maxLength={200} placeholder="Tool, command, error or text…" value={query} onChange={event=>{setQuery(event.target.value);setLimit(PAGE_SIZE);}}/></label><select aria-label="Recorded event type" value={kind} onChange={event=>{setKind(event.target.value);setLimit(PAGE_SIZE);}}><option value="all">All events</option><option value="tool">Tools</option><option value="provider">Provider data</option><option value="thinking">Thinking</option><option value="update">Progress & decisions</option></select></div>
   <p className="diagnostic-count" id={resultId}>{rows.length} matching {rows.length===1?'event':'events'}. Search checks up to {FIELD_LIMIT.toLocaleString()} characters per payload field.</p>
   <ol className="diagnostic-events" aria-label="Recorded events">{rows.slice(0,limit).map(({step,index})=><EventRow key={(step.id||'event')+':'+index} step={step} index={index}/>)}</ol>
   {!rows.length&&<p className="diagnostic-note">No recorded events match these filters.</p>}{rows.length>limit&&<button type="button" className="text-button" onClick={()=>setLimit(value=>value+PAGE_SIZE)}>Show {Math.min(PAGE_SIZE,rows.length-limit)} more events</button>}
  </div>}
 </details>;
}
