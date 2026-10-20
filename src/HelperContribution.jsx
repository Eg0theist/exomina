import React from 'react';
import {ArrowRight,Bot} from 'lucide-react';
import Markdown from './Markdown.jsx';
import SelectableText from './SelectableText.jsx';
import {getProvider} from '../desktop/provider-catalog.mjs';
import './helper-contribution.css';

const provider=value=>getProvider(value)?.name||value||'Provider not reported';
const model=value=>value&&value!=='auto'?value:null;
const states={running:'Running',waiting:'Waiting',complete:'Completed',failed:'Failed',cancelled:'Stopped',stopped:'Stopped'};
const source=helper=>model(helper.sourceModel)?`${helper.sourceModel}${helper.sourceModelSource==='reported'?' (reported)':helper.sourceModelSource==='configured'?' (configured)':' (selected)'}`:'Model not reported';
function targetModel(helper){
  if(model(helper.effectiveModel))return `${helper.effectiveModel} (reported)`;
  if(helper.effectiveProvider&&helper.requestedProvider&&helper.effectiveProvider!==helper.requestedProvider)return 'Runtime model not reported';
  if(model(helper.configuredModel))return `${helper.configuredModel} (configured)`;
  if(model(helper.requestedModel||helper.model))return `${helper.requestedModel||helper.model} (requested)`;
  return 'Runtime model not reported';
}

const helperState=(helper,live)=>!live&&['running','waiting'].includes(helper.status)?'Interrupted':states[helper.status]||'Status not reported';
function HelperModel({helper}){
  const label=targetModel(helper);
  return <><span className="helper-model">{label}</span>{!model(helper.effectiveModel)&&label!=='Runtime model not reported'&&<span className="helper-runtime-missing">Runtime model not reported</span>}</>;
}

/** Compact identity also used beside a precisely matched native activity step. */
export function HelperIdentity({helper,live=false}){
  const task=helper.task||(helper.taskTruncated?'Earlier task text was omitted.':'Task not reported');
  return <div className={`helper-identity status-${helper.status||'unknown'}`}><div className="helper-headline"><strong className="helper-route">{provider(helper.effectiveProvider||helper.provider||helper.requestedProvider)}</strong><HelperModel helper={helper}/><span className="helper-state">{helperState(helper,live)}</span></div>{helper.name&&<p className="helper-identity-name">{helper.name}</p>}<p className="helper-task-preview" title={task}>{task.length>220?task.slice(0,220)+'…':task}</p></div>;
}

export default function HelperContribution({helper,onLink,live=false}){
  const effectiveProvider=helper.effectiveProvider||helper.provider||helper.requestedProvider;
  const interrupted=!live&&['running','waiting'].includes(helper.status);
  const task=helper.task||(helper.taskTruncated?'Earlier task text was omitted.':'Task not reported'),state=helperState(helper,live);
  const requestedProvider=helper.requestedProvider||helper.provider;
  return <details className={`helper-contribution helper-card status-${helper.status||'unknown'}`}>
    <summary><div className="helper-headline"><Bot size={15}/><strong className="helper-route">{provider(helper.sourceProvider)}<ArrowRight size={13} aria-hidden="true"/><span className="sr-only"> delegates to </span>{provider(effectiveProvider)}</strong><HelperModel helper={helper}/><span className="helper-state">{state}</span></div><p className="helper-task-preview" title={task}>{task.length>220?task.slice(0,220)+'…':task}</p></summary>
    <div className="helper-card-details"><p className="helper-kind">{helper.kind==='native'?'Native helper':'Model consultation'}{helper.name?` · ${helper.name}`:''}{helper.role?` · ${helper.role}`:''}</p>
      <dl className="helper-metadata"><div><dt>Parent AI</dt><dd>{provider(helper.sourceProvider)}</dd></div><div><dt>Parent model</dt><dd>{source(helper)}</dd></div><div><dt>Helper AI</dt><dd>{provider(effectiveProvider)}</dd></div><div><dt>Helper model</dt><dd>{targetModel(helper)}</dd></div>{helper.kind==='native'&&<div><dt>Helper name</dt><dd>{helper.name||'Name not reported'}</dd></div>}<div><dt>Status</dt><dd>{state}</dd></div>{helper.requestedModel||helper.model?<div><dt>Requested helper</dt><dd>{provider(requestedProvider)} · {helper.requestedModel||helper.model}{helper.requestedEffort||helper.effort?` · ${helper.requestedEffort||helper.effort} effort`:''}</dd></div>:null}{helper.effectiveEffort?<div><dt>Reported effort</dt><dd>{helper.effectiveEffort}</dd></div>:null}{helper.difficulty?<div><dt>Task difficulty</dt><dd>{helper.difficulty}</dd></div>:null}{helper.images?.length?<div><dt>Images shared</dt><dd>{helper.images.length}</dd></div>:null}</dl>
      {helper.sourceRequestedModel&&helper.sourceRequestedModel!==helper.sourceModel&&<p><strong>Requested parent model:</strong> {helper.sourceRequestedModel}</p>}
      {helper.configuredModel&&helper.effectiveModel&&<p><strong>Configured helper model:</strong> {helper.configuredModel}{helper.configuredEffort?` · ${helper.configuredEffort} effort`:''}</p>}
      {interrupted&&<p>The parent reply is no longer active. A helper completion was not recorded.</p>}
      {helper.fallback?.length>0&&<div className="helper-fallback"><strong>Actual delegation attempts</strong><ol>{helper.fallback.map((attempt,index)=><li key={index}>{provider(attempt.provider)}{model(attempt.model)?` · ${attempt.model}`:''}{attempt.effort?` · ${attempt.effort} effort`:''}{attempt.reason?` — ${attempt.reason}`:''}</li>)}</ol></div>}
      {helper.rationale&&<p className="helper-rationale">{helper.rationale}</p>}<div className="helper-task"><strong>Delegated task</strong><p>{task}</p>{helper.taskTruncated&&<small>The saved task text was shortened.</small>}</div>
      {(helper.summary||helper.statusDetail)&&<p>{helper.summary||helper.statusDetail}</p>}{helper.text&&<SelectableText as="div" className="message-content helper-result"><Markdown text={helper.text} onLink={onLink}/></SelectableText>}{helper.textTruncated&&<p className="helper-truncation">Earlier contribution text was shortened or omitted to keep saved task history bounded.</p>}{helper.error&&<p className="inline-error">{helper.error}</p>}
    </div>
  </details>;
}
