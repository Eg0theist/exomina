import React, {useState} from 'react';
import {Bot, Check, ChevronRight, Circle, FileCode2, ListChecks, LoaderCircle, Sparkles, Gauge} from 'lucide-react';
import {helperStepRows,helperStepTitle} from '../desktop/helper-step.mjs';
import {HelperIdentity} from './HelperContribution.jsx';
import SelectableText from './SelectableText.jsx';
import {reportedCacheRate} from '../desktop/context-metrics.mjs';

export function NativeHelperActivity({step,helpers,provider,live=false}){
  const [open,setOpen]=useState(false),rows=helperStepRows(step,helpers,provider),details=step.input||step.output||step.detail;
  return <li className="activity-step native native-kind-helper"><span className="step-icon"><Bot size={14}/></span><div className="step-main"><button type="button" className="step-head" onClick={()=>setOpen(!open)} aria-expanded={open}><span className="step-title">{helperStepTitle(step)}</span><ChevronRight size={13} className="step-caret"/></button><div className="native-helper-identities">{rows.map(helper=><HelperIdentity key={helper.id} helper={helper} live={live}/>)}</div>{open&&<div className="step-details native-details">{step.helper?.omitted?<p className="native-context-note">Earlier helper activity fields were omitted to keep saved history bounded.</p>:rows.some(helper=>helper.id.startsWith('unlinked:'))&&<p className="native-context-note">A matching helper receipt was not available. Only the identity fields supplied with this activity are shown.</p>}{step.detail&&<p>{step.detail}</p>}{step.input&&<><span className="step-label">Request</span><SelectableText>{step.input}</SelectableText></>}{step.output&&<><span className="step-label">Result</span><SelectableText>{step.output}</SelectableText></>}{!details&&<p className="native-context-note">This is a recorded helper lifecycle event.</p>}</div>}</div></li>;
}

const count=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'Unknown';
export function nativeActivitySummary(data){
  if(!data||data.omitted)return '';
  if(data.kind==='plan')return `${data.steps.filter(step=>step.status==='completed').length}/${data.steps.length} plan steps complete`;
  if(data.kind==='diff')return data.text?'File changes available':'';
  if(data.kind==='usage')return `Latest input ${count(data.last.inputTokens)}${data.modelContextWindow?` / ${count(data.modelContextWindow)}`:''} tokens`;
  return '';
}

function TokenBreakdown({usage}){
  return <dl className="native-token-breakdown"><div><dt>Input</dt><dd>{count(usage.inputTokens)}</dd></div><div><dt>Cached input</dt><dd>{count(usage.cachedInputTokens)}</dd></div>{Number.isSafeInteger(usage.cacheWriteInputTokens)&&<div><dt>Cache writes</dt><dd>{count(usage.cacheWriteInputTokens)}</dd></div>}<div><dt>Output</dt><dd>{count(usage.outputTokens)}</dd></div><div><dt>Reasoning output</dt><dd>{count(usage.reasoningOutputTokens)}</dd></div><div><dt>Total reported</dt><dd>{count(usage.totalTokens)}</dd></div></dl>;
}

function Usage({data}){
  const providerRun=data.totalScope==='providerRun',totals=providerRun?'Provider reported totals':'Thread totals';
  const cacheRate=reportedCacheRate(data.last);
  return <div className="native-usage"><p className="native-context-label">{data.modelContextWindow?`Latest reported input: ${count(data.last.inputTokens)} tokens. Model context window: ${count(data.modelContextWindow)} tokens.`:'The provider has not reported a model context window.'}</p><p className="native-context-note">The latest input is a request snapshot. Live context occupancy is not reported. {totals} accumulate across requests and are not the amount currently in context.{providerRun?' Claude’s totals may include earlier saved work, helpers and compaction.':''}</p><p className="native-context-label">Latest reported cache reads: {cacheRate===null?'Unknown':`${(cacheRate*100).toFixed(1)}% of input (${count(data.last.cachedInputTokens)} of ${count(data.last.inputTokens)} tokens)`}.</p><div className="native-usage-groups"><section><h4>Latest reported request</h4><TokenBreakdown usage={data.last}/></section><section><h4>{totals}</h4><TokenBreakdown usage={data.total}/></section></div><p className="native-context-note">Counters are shown as reported; do not add the rows together. The cache-read share describes this request and does not measure saved time, subscription allowance or charges.</p></div>;
}

function Plan({data}){
  return <div className="native-plan">{data.explanation&&<p>{data.explanation}</p>}{data.steps.length?<ol aria-label="Native task plan">{data.steps.map((step,index)=><li key={index} className={`native-plan-step status-${step.status}`}>{step.status==='completed'?<Check size={14}/>:step.status==='inProgress'?<LoaderCircle size={14} className="spin"/>:<Circle size={13}/>}<span>{step.text}</span><small>{step.status==='completed'?'Complete':step.status==='inProgress'?'In progress':'Pending'}</small></li>)}</ol>:<p>The provider cleared the plan.</p>}{data.truncated&&<p className="native-truncation">The provider plan was shortened for display.</p>}</div>;
}

function Diff({data}){
  return <div className="native-diff">{data.text?<SelectableText aria-label="Native unified diff">{data.text.split('\n').map((line,index)=><span key={index} className={line.startsWith('+')&&!line.startsWith('+++')?'diff-added':line.startsWith('-')&&!line.startsWith('---')?'diff-removed':line.startsWith('@@')?'diff-hunk':''}>{line}{'\n'}</span>)}</SelectableText>:<p>The provider reports no file changes in this snapshot.</p>}{data.truncated&&<p className="native-truncation">This diff was shortened for display. Inspect the workspace for the full changes.</p>}<p className="native-context-note">The provider's latest aggregated diff for this turn. It is a recorded snapshot and does not verify the current files or test results.</p></div>;
}

export default function NativeActivity({step}){
  const [open,setOpen]=useState(false),data=step.native;
  if(!data)return null;
  const Icon={plan:ListChecks,diff:FileCode2,usage:Gauge,reroute:Sparkles}[data.kind]||Sparkles;
  return <li className={`activity-step native native-kind-${data.kind}`}><span className="step-icon"><Icon size={14}/></span><div className="step-main"><button type="button" className="step-head" onClick={()=>setOpen(!open)} aria-expanded={open}><span className="step-title">{step.title}</span><span className="native-step-summary">{nativeActivitySummary(data)}</span><ChevronRight size={13} className="step-caret"/></button>{open&&<div className="step-details native-details">{data.omitted?<p>Earlier provider details were omitted to keep this long task's saved history bounded.</p>:data.kind==='plan'?<Plan data={data}/>:data.kind==='diff'?<Diff data={data}/>:data.kind==='usage'?<Usage data={data}/>:<><p>From {data.fromModel} to {data.toModel}.</p><p>{data.reason==='highRiskCyberActivity'?'The provider reported a high-risk cybersecurity classification.':`Provider reason: ${data.reason}`}</p></>}</div>}</div></li>;
}
