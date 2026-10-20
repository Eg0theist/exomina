import React, { useEffect, useId, useState } from 'react';
import { Ban, Bot, Brain, Check, ChevronRight, Circle, CircleAlert, FilePen, FileText, Globe2, Image, LoaderCircle, Monitor, Search, ShieldCheck, Sparkles, Terminal, Wrench } from 'lucide-react';
import Markdown from './Markdown.jsx';
import SelectableText from './SelectableText.jsx';
import AssistantText from './AssistantText.jsx';
import { activitySummary, formatDuration } from '../desktop/describe.mjs';
import './activity.css';
import { FollowupCard } from './FollowupReplies.jsx';
import {QuestionCard} from './QuestionCards.jsx';
import NativeActivity, {NativeHelperActivity,nativeActivitySummary} from './NativeActivity.jsx';
import {isHelperStep} from '../desktop/helper-step.mjs';
import { useStandardView, useDiagnosticsView } from './InterfaceView.jsx';
import DiagnosticInspector from './DiagnosticInspector.jsx';
import {activityProblem, activityVisibility, toolActivityState, toolActivityTitle} from '../desktop/activity-visibility.mjs';

// Standard view describes the work in one plain sentence instead of a step log.
const PLAIN = [['read', 'read', 'file', 'files'], ['write', 'changed', 'file', 'files'], ['web', 'checked', 'web page', 'web pages'], ['browser', 'checked', 'web page', 'web pages'], ['search', 'ran', 'search', 'searches'], ['execute', 'ran', 'command', 'commands'], ['desktop', 'took', 'desktop action', 'desktop actions'], ['image', 'worked with', 'image', 'images'], ['agent', 'asked', 'helper', 'helpers'], ['memory', 'used memory', '', '']];
export function plainActivity(steps = []) {
  const tools = steps.filter(step => step.kind === 'tool' && toolActivityState(step) === 'done');
  const counts = new Map();
  for (const step of tools) { const row = PLAIN.find(item => item[0] === step.category) || ['tool', 'used', 'tool', 'tools']; const key = row[1] + '|' + row[2]; counts.set(key, { row, n: (counts.get(key)?.n || 0) + 1 }); }
  const parts = [...counts.values()].map(({ row, n }) => row[2] ? `${row[1]} ${n} ${n === 1 ? row[2] : row[3]}` : row[1]);
  if (!parts.length) return '';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ICON = { read: FileText, write: FilePen, execute: Terminal, search: Search, web: Globe2, browser: Globe2, desktop: Monitor, memory: Brain, image: Image, agent: Bot, app: Sparkles, tool: Wrench };
const span = step => { const ms = Date.parse(step.endedAt || '') - Date.parse(step.startedAt || ''); return Number.isFinite(ms) ? ms : null; };

/** Ticks once a second while something is running. */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}

function StatusIcon({ status }) {
  if (status === 'running') return <LoaderCircle size={13} className="spin step-state running" aria-label="In progress" />;
  if (status === 'error') return <CircleAlert size={13} className="step-state error" aria-label="Failed" />;
  if (status === 'denied' || status === 'stopped') return <Ban size={13} className="step-state denied" aria-label={status === 'denied' ? 'Not allowed' : 'Stopped'} />;
  if (status === 'unknown') return <CircleAlert size={13} className="step-state denied" aria-label="Result not confirmed" />;
  if (status === 'recorded') return <Circle size={13} className="step-state" aria-label="Recorded" />;
  return <Check size={13} className="step-state done" aria-label="Done" />;
}

function ThinkingStep({ step, now, live }) {
  const running = step.status === 'running';
  const elapsed = running ? now - Date.parse(step.startedAt) : span(step);
  const text = String(step.text || '').trim();
  const [open, setOpen] = useState(null);
  const expanded = open ?? false;
  const label = running ? `Thinking${elapsed > 1500 ? ` · ${formatDuration(elapsed)}` : '…'}` : `Thought for ${formatDuration(elapsed) || 'a moment'}`;
  return <li className={`activity-step thinking ${running ? 'is-running' : ''}`}>
    <span className="step-icon"><Brain size={14} /></span>
    <div className="step-main">
      {text ? <button type="button" className="step-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}><span className="step-title">{label}</span><ChevronRight size={13} className="step-caret" /></button> : <div className="step-head static"><span className="step-title">{label}</span></div>}
      {text && expanded && <SelectableText as="div" className="thinking-text"><Markdown text={text} /></SelectableText>}
    </div>
  </li>;
}

function ToolStep({ step, now, recovered = false }) {
  const [open, setOpen] = useState(false);
  const state = toolActivityState(step), running = state === 'running';
  const Icon = ICON[step.category] || Wrench;
  const elapsed = running ? now - Date.parse(step.startedAt) : span(step);
  const title = toolActivityTitle(step);
  const details = step.input || step.output || step.detail;
  return <li className={`activity-step tool status-${state} kind-${step.category || 'tool'}`}>
    <span className="step-icon"><Icon size={14} /></span>
    <div className="step-main">
      <button type="button" className="step-head" onClick={() => details && setOpen(!open)} aria-expanded={details ? open : undefined} disabled={!details}>
        <span className="step-title">{title}</span>
        {step.target && <code className="step-target" title={step.target}>{step.target}</code>}
        <span className="step-meta">{elapsed !== null && elapsed >= 1000 && formatDuration(elapsed)}<StatusIcon status={state} />{details && <ChevronRight size={13} className="step-caret" />}</span>
      </button>
      {recovered && <p className="step-recovery">The same action succeeded on a later attempt.</p>}
      {step.permission && <p className="step-permission"><ShieldCheck size={12} />{step.permission}</p>}
      {open && <div className="step-details">
        {step.detail && <p>{step.detail}</p>}
        {step.input && <><span className="step-label">Request</span><SelectableText>{step.input}</SelectableText></>}
        {step.output && <><span className="step-label">Result</span><SelectableText>{step.output}</SelectableText></>}
      </div>}
    </div>
  </li>;
}

/** A reply's work: thinking, narration, tool steps and permission decisions. */
export default function ActivityTimeline({ message, streaming = false, providerName = 'The AI', onLink, onFollowupCancel,onQuestionAnswer,onQuestionContinue }) {
  const steps = Array.isArray(message?.activity) ? message.activity : [];
  const running = streaming && !message?.finishedAt;
  const now = useNow(running);
  const [open, setOpen] = useState(null);
  const expanded = open ?? false;
  const detailId=useId();
  const standard = useStandardView();
  const diagnostics = useDiagnosticsView();
  if (!steps.length && !running) return null;
  const {updates, details, recovered} = activityVisibility(message, {standard, running});
  const needsAttention = !!message.error || updates.some(step => activityProblem(step) || step.kind === 'status' && ['error', 'denied', 'stopped'].includes(step.status));
  const summary = activitySummary(message);
  const total = running ? now - Date.parse(message?.startedAt || '') : summary.totalMs;
  const current = [...steps].reverse().find(step => step.status === 'running');
  const plain = standard && plainActivity(steps);
  const head = running
    ? (current?.kind === 'thinking' ? 'Thinking' : standard && current?.title ? current.title : `${providerName} is working`)
    : standard ? (message.error ? 'Work stopped.' : plain ? plain + '.' : needsAttention ? 'Work has recorded problems.' : `Done in ${formatDuration(total) || 'a moment'}.`)
    : `Worked for ${formatDuration(total) || 'a moment'}`;
  const timing = message?.timing || {};
  const parts = [Number.isFinite(timing.firstOutputMs) && `first response ${formatDuration(timing.firstOutputMs) || 'under 1s'}`, summary.thinkingMs >= 1000 && `thought for ${formatDuration(summary.thinkingMs)}`, summary.tools && `${summary.tools} ${summary.tools === 1 ? 'step' : 'steps'}`].filter(Boolean);
  const handled = (message.followups || []).filter(item => item.taskStatus === 'handled').length;
  const blocked = (message.followups || []).filter(item => item.taskStatus === 'blocked').length;
  if (handled) parts.push(`${handled} ${handled === 1 ? 'follow-up' : 'follow-ups'} handled`);
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? 'follow-up needs' : 'follow-ups need'} attention`);
  // Where the wait before the first response went, for anyone comparing speed.
  const timingTitle = [Number.isFinite(timing.prepareMs) && `Exomina prepared the request in ${(timing.prepareMs / 1000).toFixed(1)}s`, Number.isFinite(timing.runtimeMs) && `the runtime was ready after ${(timing.runtimeMs / 1000).toFixed(1)}s`, Number.isFinite(timing.firstOutputMs) && `the model responded after ${(timing.firstOutputMs / 1000).toFixed(1)}s`].filter(Boolean).join(', ');
  const nativeSummary=['plan','usage','diff'].map(kind=>nativeActivitySummary([...steps].reverse().find(step=>step.native?.kind===kind&&!step.native.omitted)?.native)).filter(Boolean);
  if (standard && !running) { parts.length = 0; if (plain) parts.push(`took ${formatDuration(total) || 'a moment'}`); if (handled) parts.push(`${handled} ${handled === 1 ? 'follow-up' : 'follow-ups'} handled`); if (blocked) parts.push(`${blocked} ${blocked === 1 ? 'follow-up needs' : 'follow-ups need'} attention`); }
  const renderUpdate = step => step.kind === 'followup' ? <li key={step.id} className="activity-step followup-step">{message.followups?.find(item => item.id === step.followupId) && <FollowupCard item={message.followups.find(item => item.id === step.followupId)} onLink={onLink} onCancel={onFollowupCancel}/>}</li>
    : step.kind==='question'?<li key={step.id} className="activity-step question-step">{message.questions?.find(item=>item.id===step.questionId)&&<QuestionCard group={message.questions.find(item=>item.id===step.questionId)} onAnswer={onQuestionAnswer} onContinue={onQuestionContinue}/>}</li>
    : step.kind==='reroute'?<NativeActivity key={step.id} step={step}/>
    : step.kind === 'tool' ? <li key={step.id} className={`activity-step status status-${toolActivityState(step)}`}><span className="step-icon"><CircleAlert size={14}/></span><div className="step-main"><p className="step-permission">{step.status === 'denied' ? `${step.title || step.name} was not allowed.` : step.status === 'stopped' ? `${step.title || step.name} stopped before completion was confirmed.` : toolActivityState(step) === 'unknown' ? `${step.title || step.name} returned a result without confirming success.` : `${step.title || step.name} encountered a problem.`}</p><button type="button" className="activity-problem-details" onClick={()=>setOpen(!expanded)} aria-expanded={expanded} aria-controls={detailId}>{expanded?'Hide details':'View details'}</button></div></li>
    : step.kind === 'note' ? <li key={step.id} className="activity-step note"><span className="step-icon"><span className="note-dot" /></span><div className="step-main note-text"><AssistantText text={step.text} message={message} stepId={step.id} onLink={onLink} onAnswer={onQuestionAnswer} /></div></li>
    : <li key={step.id} className={`activity-step status status-${step.status}`}><span className="step-icon"><ShieldCheck size={14} /></span><div className="step-main"><p className="step-permission">{step.text}</p></div></li>;
  return <section className={`activity ${running ? 'is-running' : ''} ${expanded ? 'is-open' : ''} ${standard ? 'is-plain' : ''} ${needsAttention ? 'has-problems' : ''}`} aria-label="What the AI did">
    <button type="button" className="activity-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded} aria-controls={detailId}>
      {running ? <span className="activity-pulse" aria-hidden="true" /> : needsAttention ? <CircleAlert size={14} className="activity-warning" aria-label="Work has recorded problems" /> : <Check size={14} className="activity-done" />}
      <span className="activity-title">{head}</span>
      <span className="activity-sub" title={!running && timingTitle ? timingTitle.charAt(0).toUpperCase() + timingTitle.slice(1) + '.' : undefined}>{running && Number.isFinite(total) ? formatDuration(total) : parts.join(' · ')}</span>
      <span className="activity-details-label">{expanded ? 'Hide details' : standard ? 'See what it did' : 'Work details'}</span><ChevronRight size={14} className="activity-caret" />
    </button>
    {!standard&&!!nativeSummary.length&&<div className="activity-native-summary" aria-label="Provider work summary">{nativeSummary.map((text,index)=><span key={index}>{text}</span>)}</div>}
    {!!updates.length && <ol className="activity-steps activity-updates" aria-label="Progress updates">
      {updates.map(renderUpdate)}
    </ol>}
    {expanded && <ol id={detailId} className="activity-steps activity-work-details" aria-label="Commands, plans and provider details">{details.map(step => step.kind==='native'?<NativeActivity key={step.id} step={step}/>:step.kind === 'thinking' ? <ThinkingStep key={step.id} step={step} now={now} live={running}/>:step.kind!=='tool'?renderUpdate(step):isHelperStep(step)?<NativeHelperActivity key={step.id} step={step} helpers={message.helpers||[]} provider={message.provider} live={running}/>: <ToolStep key={step.id} step={step} now={now} recovered={recovered.has(step.id)}/>)}</ol>}
    {diagnostics&&<DiagnosticInspector message={message}/>}
  </section>;
}
