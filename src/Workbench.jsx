import React, { useState } from 'react';
import { FolderOpen, Plus, Pencil, Play, Trash2, Pause, ArrowRight } from 'lucide-react';
import { api } from './transport.js';
import CodexCloud from './CodexCloud.jsx';
import WorkPlans from './WorkPlans.jsx';
import './workbench.css';

const blankTask = { name: '', prompt: '', provider: 'codex', model: 'auto', frequency: 'daily', time: '09:00', day: 1, delivery: 'desktop', projectId: '', recipient: '', enabled: true, onceAt: '' };
export default function Workbench({ value = {}, conversations = [], catalog = [], messaging = {}, onOpen, onNew, onPrompt, refresh, standard = false, onView }) {
  const [tab, setTab] = useState('projects'), [form, setForm] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [recoveryEvidence,setRecoveryEvidence] = useState({});
  const projects = value.projects || [], prompts = value.prompts || [], tasks = value.schedules || [], workflowRuns = value.workflowRuns || [];
  const taskBlocked = id => tasks.some(task=>task.id===id&&task.recoveryRequired)||workflowRuns.some(run => run.taskId===id && !['complete','failed','cancelled'].includes(run.status));
  const action = async fn => { setError(''); setBusy(true); try { await fn(); await refresh(); } catch(e) { setError(e.message); } finally { setBusy(false); } };
  const edit = item => { setError(''); setForm(item); };
  const patch = changes => setForm(previous => ({ ...previous, ...changes }));
  const save = event => { event.preventDefault(); action(async () => { await api.invoke(tab === 'projects' ? 'projects.save' : tab === 'prompts' ? 'prompts.save' : 'schedules.save', form); setForm(null); }); };
  const create = () => edit(tab==='projects' ? { name:'', instructions:'' } : tab==='prompts' ? { name:'', shortcut:'', text:'' } : { ...blankTask, provider:catalog[0]?.id || 'codex' });
  const createLabel=tab==='projects'?'New project':tab==='prompts'?'New prompt':'New scheduled task';
  const items=tab==='projects'?projects:tab==='prompts'?prompts:tasks;
  return <div className="content-page workbench-page">
    <div className="page-heading"><div><h1>Library</h1><p>Projects, reusable prompts and ongoing work.</p></div>{['projects','prompts','tasks'].includes(tab)&&<button className="primary-button" disabled={busy} onClick={create}><Plus size={15}/>{createLabel}</button>}</div>
    <div className="workbench-tabs" role="tablist" aria-label="Work library" onKeyDown={event=>{const buttons=[...event.currentTarget.querySelectorAll('[role=tab]')],index=buttons.indexOf(event.target);if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].click();buttons[next].focus();}}>{[['projects','Projects'],['prompts','Saved prompts'],['plans','Work plans'],['tasks','Scheduled tasks'],['workflows','Workflow runs'],['cloud','Codex Cloud']].map(([id,label]) => <button key={id} type="button" role="tab" tabIndex={tab===id?0:-1} aria-selected={tab===id} onClick={() => { setTab(id); setForm(null); setError(''); }}>{label}</button>)}</div>
    {tab==='plans'?<WorkPlans catalog={catalog} projects={projects} conversations={conversations} onOpen={onOpen}/>:tab==='cloud' ? <CodexCloud /> : tab==='workflows' ? <>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <WorkflowRuns runs={workflowRuns} busy={busy} action={action} onOpen={onOpen} conversations={conversations}/>
    </> : <>
    <div className="workbench-intro"><p>{tab==='projects' ? `${projects.length} ${projects.length===1?'project':'projects'} · Shared files and instructions for related chats` : tab==='prompts' ? `${prompts.length} saved ${prompts.length===1?'prompt':'prompts'} · Type / in any message to use one` : `${tasks.length} scheduled ${tasks.length===1?'task':'tasks'} · Runs while Exomina is open`}</p><details className="view-help"><summary>{tab==='tasks'?'How schedules run':'How it works'}</summary><p>{tab==='projects'?'A project shares its folder, files and instructions with its chats. Each chat keeps its own history.':tab==='prompts'?'Choosing a saved prompt adds its text to the message box. You can edit it before sending.':'Your PC must be awake, Exomina open and your AI connected with available usage. Times follow this computer’s time zone. Generation uses Read only permissions. External delivery waits for your review in Workflow runs. Resolve or cancel an unfinished workflow before the next run.'}</p></details></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {form && <form className="workbench-editor" onSubmit={save}>
      <label>{tab==='projects'?'Project name':tab==='prompts'?'Prompt name':'Task name'}<input aria-label={tab==='projects'?'Project name':tab==='prompts'?'Prompt name':'Task name'} value={form.name} required maxLength={80} onChange={e=>patch({name:e.target.value})}/></label>
      {tab==='projects' ? <label>Instructions for every chat in this project<textarea aria-label="Project instructions" value={form.instructions} rows={5} maxLength={30000} onChange={e=>patch({instructions:e.target.value})} placeholder="For example: Write in German. Use the attached brand guide. Ask before changing existing files."/></label> : <>
        {tab==='prompts' && <label>Shortcut<input aria-label="Prompt shortcut" placeholder="rewrite" value={form.shortcut} maxLength={30} required onChange={e=>patch({shortcut:e.target.value})}/></label>}
        <label>{tab==='prompts'?'Reusable prompt':'What should the AI do?'}<textarea aria-label={tab==='prompts'?'Reusable prompt':'Scheduled task prompt'} value={tab==='prompts'?form.text:form.prompt} required rows={5} onChange={e=>patch(tab==='prompts'?{text:e.target.value}:{prompt:e.target.value})} placeholder={tab==='prompts'?'Rewrite the following text for…':'Summarise the week’s project progress using our project chats.'}/></label>
      </>}
      {tab==='tasks' && <div className="workbench-form-grid">
        <label>AI<select aria-label="Scheduled task AI" value={form.provider} onChange={e=>patch({provider:e.target.value})}>{catalog.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Model<input aria-label="Scheduled task model" value={form.model} onChange={e=>patch({model:e.target.value})} placeholder="auto"/></label>
        <label>Repeat<select aria-label="Task repetition" value={form.frequency} onChange={e=>patch({frequency:e.target.value})}><option value="daily">Every day</option><option value="weekly">Every week</option><option value="once">Once</option></select></label>
        {form.frequency!=='once'&&<label>Time<input aria-label="Task time" type="time" required value={form.time} onChange={e=>patch({time:e.target.value})}/></label>}
        {form.frequency==='weekly' && <label>Day<select aria-label="Task day" value={form.day} onChange={e=>patch({day:Number(e.target.value)})}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label>}
        {form.frequency==='once' && <label>Date and time<input aria-label="Task date" type="datetime-local" required value={form.onceAt ? new Date(new Date(form.onceAt).getTime()-new Date(form.onceAt).getTimezoneOffset()*60000).toISOString().slice(0,16):''} onChange={e=>patch({onceAt:e.target.value?new Date(e.target.value).toISOString():''})}/></label>}
        <label>Project<select aria-label="Task project" value={form.projectId} onChange={e=>patch({projectId:e.target.value})}><option value="">No project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Send result to<select aria-label="Task delivery" value={form.delivery} onChange={e=>patch({delivery:e.target.value,recipient:''})}><option value="desktop">Exomina only</option>{['telegram','discord'].filter(c=>messaging[c]?.enabled).map(c=><option value={c} key={c}>{c==='telegram'?'Telegram':'Discord'} and Exomina</option>)}</select></label>
        {form.delivery!=='desktop' && <label>Paired recipient<select aria-label="Task recipient" required value={form.recipient} onChange={e=>patch({recipient:e.target.value})}><option value="">Choose a paired chat</option>{(messaging[form.delivery]?.recipients||[]).map(r=><option key={r.chatKey} value={r.chatKey}>{r.name}</option>)}</select></label>}
      </div>}
      <div className="workbench-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setForm(null)}>Cancel</button><button className="primary-button" disabled={busy}>{busy?'Saving…':'Save'}</button></div>
    </form>}
    <div className="workbench-cards">
      {tab==='projects' && projects.map(p=><section className="workbench-card" key={p.id}><div className="workbench-card-title"><h2>{p.name}</h2><button className="icon-button" aria-label={`Edit ${p.name}`} onClick={()=>edit(p)}><Pencil size={15}/></button><button className="icon-button" aria-label={`Remove project ${p.name}`} disabled={busy} onClick={()=>action(()=>api.invoke('workbench.remove',{kind:'projects',id:p.id}))}><Trash2 size={15}/></button></div><p>{p.instructions||'Add instructions to guide every chat in this project.'}</p><small className="path-text">{p.folder||'Uses your default workspace'}</small><div className="workbench-actions"><button className="secondary-button" disabled={busy} onClick={()=>action(()=>api.invoke('projects.folder',{id:p.id}))}><FolderOpen size={14}/>Choose folder</button><button className="secondary-button" disabled={busy||!p.folder} onClick={()=>action(()=>api.invoke('projects.files',{id:p.id}))}>Add shared files</button><button className="primary-button" onClick={()=>onNew(p.id)}><Plus size={14}/>New project chat</button></div>{p.files?.map(f=><div className="workbench-file" key={f}><span>{f}</span><button aria-label={`Remove shared file ${f}`} className="icon-button" onClick={()=>action(()=>api.invoke('projects.removeFile',{id:p.id,file:f}))}><XIcon/></button></div>)}<div className="project-chats">{conversations.filter(c=>c.projectId===p.id&&!c.archived).map(c=><button key={c.id} onClick={()=>onOpen(c)}>{c.title}<ArrowRight size={13}/></button>)}</div></section>)}
      {tab==='prompts' && prompts.map(p=><section className="workbench-card" key={p.id}><div className="workbench-card-title"><h2>{p.name}</h2><code>/{p.shortcut}</code><button className="icon-button" aria-label={`Edit ${p.name}`} onClick={()=>edit(p)}><Pencil size={15}/></button><button className="icon-button" aria-label={`Remove prompt ${p.name}`} disabled={busy} onClick={()=>action(()=>api.invoke('workbench.remove',{kind:'prompts',id:p.id}))}><Trash2 size={15}/></button></div><p>{p.text}</p><button className="secondary-button" onClick={()=>onPrompt(p.text)}>Use this prompt<ArrowRight size={14}/></button></section>)}
      {tab==='tasks' && tasks.map(t=><section className="workbench-card" key={t.id}>
        <div className="workbench-card-title"><h2>{t.name}</h2><span className="tag">{t.enabled?'Active':'Paused'}</span><button className="icon-button" aria-label={`Edit ${t.name}`} disabled={busy||taskBlocked(t.id)} onClick={()=>edit(t)}><Pencil size={15}/></button></div>
        <p>{t.prompt}</p><small>{t.frequency==='once'?'Once':t.frequency==='daily'?'Every day':'Every '+['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][t.day]} at {t.frequency==='once'?new Date(t.onceAt).toLocaleString():t.time} · {t.timezone} · {catalog.find(p=>p.id===t.provider)?.name||t.provider}</small>
        {t.enabled && <small>Next: {new Date(t.nextRun).toLocaleString()}</small>}
        {t.last && <div className="task-result" role="status"><strong>{t.last.status}</strong>{t.last.error&&<span>{t.last.error}</span>}{t.last.deliveryError&&<span>Delivery: {t.last.deliveryError}. Inspect the workflow before continuing.</span>}{t.last.conversationId&&conversations.some(c=>c.id===t.last.conversationId)&&<button className="text-button" onClick={()=>onOpen(conversations.find(c=>c.id===t.last.conversationId))}>Open result<ArrowRight size={13}/></button>}{t.last.workflowId&&<button className="text-button" onClick={()=>setTab('workflows')}>Inspect workflow<ArrowRight size={13}/></button>}</div>}
        {t.recoveryRequired&&<form className="workflow-reconciliation" onSubmit={event=>{event.preventDefault();action(async()=>{await api.invoke('workflows.reviewRecovery',{taskId:t.id,evidence:(recoveryEvidence[t.id]||'').trim()});setRecoveryEvidence(previous=>({...previous,[t.id]:''}));});}}><p role="alert">Recovered history may omit earlier deliveries. Check this destination before running again.</p><small>Destination: {t.delivery} · {t.recipient||'No recipient recorded'}</small><label>What did you check?<textarea aria-label={`Recovery review evidence for ${t.name}`} value={recoveryEvidence[t.id]||''} required minLength={8} maxLength={2000} rows={3} placeholder="Record the destination and earlier deliveries you checked." onChange={event=>setRecoveryEvidence(previous=>({...previous,[t.id]:event.target.value}))}/></label><small>Use at least 8 characters. Reviewing keeps the schedule paused. You can choose Run now or Resume afterward.</small><div className="workbench-actions"><button className="secondary-button" disabled={busy||(recoveryEvidence[t.id]||'').trim().length<8}>Record recovery review</button></div></form>}
        {!t.recoveryRequired&&taskBlocked(t.id)&&<small>Resolve or cancel the unfinished workflow before starting another run.</small>}
        <div className="workbench-actions"><button className="secondary-button" disabled={busy||t.last?.status==='running'||taskBlocked(t.id)} onClick={()=>action(()=>api.invoke('schedules.run',{id:t.id}))}><Play size={14}/>Run now</button><button className="secondary-button" disabled={busy||t.recoveryRequired} onClick={()=>action(()=>api.invoke('schedules.toggle',{id:t.id,enabled:!t.enabled}))}>{t.enabled?<Pause size={14}/>:<Play size={14}/>} {t.enabled?'Pause':'Resume'}</button><button className="icon-button" aria-label={`Remove task ${t.name}`} disabled={busy||t.last?.status==='running'||taskBlocked(t.id)} onClick={()=>action(()=>api.invoke('workbench.remove',{kind:'schedules',id:t.id}))}><Trash2 size={15}/></button></div>
      </section>)}
    </div>
    {!items.length&&!form&&<div className="workbench-empty"><FolderOpen size={28} strokeWidth={1.3}/><h2>{tab==='projects'?'Give your next project a home':tab==='prompts'?'Keep your best prompts close':'Put recurring work on a schedule'}</h2><p>{tab==='projects'?'Keep its chats, files and instructions together.':tab==='prompts'?'Save the instructions you use again and again.':'Daily briefings, weekly summaries or a one-time task.'}</p></div>}
    </>}
  </div>;
}
const workflowLabel = run => {
  const delivery=run.delivery?.status;
  if(delivery==='unknown')return 'Delivery outcome unknown';
  if(delivery==='sending')return 'Sending';
  if(delivery==='confirmed')return 'Delivery confirmed by you';
  if(delivery==='sent')return 'Connector acknowledged delivery';
  if(delivery==='blocked')return 'Delivery blocked';
  if(delivery==='cancelled'||run.status==='cancelled')return 'Cancelled';
  if(run.status==='ready')return 'Ready for review';
  if(run.status==='complete')return 'Complete';
  if(run.status==='interrupted')return 'Generation interrupted';
  if(run.status==='failed')return 'Generation failed';
  return 'Generating';
};
function WorkflowRuns({runs,busy,action,onOpen,conversations}) {
  return <div className="workflow-runs">
    <div className="workbench-intro"><p>Inspect saved reports and delivery history. Resuming uses the saved report and asks for approval of the exact destination and content. Saved reports and history remain here if you delete their result chat.</p></div>
    {!runs.length?<div className="workbench-empty"><FolderOpen size={28}/><h2>No workflow runs yet</h2><p>Run a scheduled task to create its report and recovery record.</p></div>:<div className="workbench-cards">{[...runs].reverse().map(run=><WorkflowRun key={run.id} run={run} busy={busy} action={action} onOpen={onOpen} conversations={conversations}/>)}</div>}
  </div>;
}
function WorkflowRun({run,busy,action,onOpen,conversations}) {
  const [evidence,setEvidence]=useState('');
  const delivery=run.delivery||{},unknown=delivery.status==='unknown';
  const canResume=run.status==='ready'&&['pending','blocked'].includes(delivery.status);
  const canCancel=!['unknown','sending'].includes(delivery.status)&&(run.status==='interrupted'||canResume);
  const resolve=resolution=>action(async()=>{await api.invoke('workflows.resolve',{id:run.id,resolution,evidence:evidence.trim()});setEvidence('');});
  return <section className="workbench-card workflow-run" aria-label={`Workflow ${run.name}`}>
    <div className="workbench-card-title"><h2>{run.name}</h2><span className="tag" role="status">{workflowLabel(run)}</span></div>
    <small>Started: {run.startedAt?new Date(run.startedAt).toLocaleString():'Unknown'}{run.finishedAt?` · Finished: ${new Date(run.finishedAt).toLocaleString()}`:''}</small>
    <small>Destination: {delivery.channel==='desktop'?'Exomina only':`${delivery.channel||'Unknown'} · ${delivery.recipient||'No recipient recorded'}`}</small>
    {run.error&&<p className="inline-error" role="alert">{run.error}</p>}
    {delivery.error&&<p className="inline-error" role="alert">{delivery.error}</p>}
    <DeliveryReceipts delivery={delivery}/>
    {run.artifact&&<details className="workflow-artifact"><summary>Saved report · {Number(run.artifact.bytes||0).toLocaleString()} bytes</summary><pre>{run.artifact.text}</pre><small>SHA-256: <code>{run.artifact.sha256}</code></small><small>The hash checks saved content integrity. Review the report for accuracy before delivery.</small></details>}
    {unknown&&<div className="workflow-reconciliation"><p>The connector may have sent this report before the interruption. Inspect the destination before continuing. Exomina will not send it again while the outcome is unknown.</p><label>What did you check?<textarea aria-label={`Reconciliation evidence for ${run.name}`} value={evidence} minLength={8} maxLength={2000} rows={3} placeholder="Record a message reference or how you established the delivery result." onChange={event=>setEvidence(event.target.value)}/></label><small>This records your assessment separately from a connector receipt. Use at least 8 characters. Confirming it was not sent only enables a new, explicitly approved delivery. A new delivery sends the whole report, so any earlier messages left at the destination could be duplicated. Check every recorded part before choosing.</small><div className="workbench-actions"><button className="secondary-button" disabled={busy||evidence.trim().length<8} onClick={()=>resolve('delivered')}>I confirmed it was delivered</button><button className="secondary-button" disabled={busy||evidence.trim().length<8} onClick={()=>resolve('not_sent')}>I confirmed it was not sent</button></div></div>}
    {delivery.status==='confirmed'&&<small>Human confirmation: {delivery.receipt?.evidence||delivery.receipt?.reference||'Recorded in history'}</small>}
    {run.status==='interrupted'&&<p>Open the original result chat before deciding whether to start again. Generation is never automatically replayed.</p>}
    <div className="workbench-actions">
      {run.conversationId&&(conversations.some(chat=>chat.id===run.conversationId)?<button className="secondary-button" onClick={()=>onOpen(conversations.find(chat=>chat.id===run.conversationId))}>Open result<ArrowRight size={13}/></button>:<small>Result chat is no longer in the library</small>)}
      {canResume&&<button className="primary-button" disabled={busy} onClick={()=>action(()=>api.invoke('workflows.resume',{id:run.id}))}>Review and send saved report</button>}
      {canCancel&&<button className="secondary-button" disabled={busy} onClick={()=>action(()=>api.invoke('workflows.cancel',{id:run.id}))}>Cancel workflow</button>}
    </div>
    <details className="workflow-history"><summary>Run history</summary><ol>{(run.events||[]).map((event,index)=><li key={index}><time dateTime={event.at}>{event.at?new Date(event.at).toLocaleString():'Time unavailable'}</time><span>{event.type}</span>{event.detail&&<span>{typeof event.detail==='string'?event.detail:JSON.stringify(event.detail)}</span>}</li>)}</ol></details>
  </section>;
}
function DeliveryReceipts({delivery}) {
  if(delivery.channel==='desktop')return null;
  const attempts=Array.isArray(delivery.attempts)?delivery.attempts:[];
  if(!attempts.length)return ['sent','unknown','sending','confirmed'].includes(delivery.status)?<small>Per-message receipts were not recorded for this earlier run.</small>:null;
  const current=attempts.find(attempt=>attempt.id===delivery.attemptId)||attempts.at(-1);
  const count=attempt=>{
    const parts=Array.isArray(attempt.parts)?attempt.parts:[],acknowledged=parts.filter(part=>part.status==='acknowledged').length;
    const total=Math.max(parts.length,...parts.map(part=>Number.isSafeInteger(part.total)?part.total:0));
    return {parts,total,acknowledged,pending:parts.length-acknowledged,remaining:Math.max(0,total-parts.length)};
  };
  const latest=count(current);
  return <div className="workflow-delivery-receipts" aria-label="Delivery message receipts">
    <small role="status">{latest.acknowledged} of {latest.total||'unknown number of'} messages acknowledged by {current.channel||delivery.channel} in the latest attempt{latest.pending?` · ${latest.pending} ${delivery.status==='sending'?'awaiting acknowledgement':'with outcome unknown'}`:''}{latest.remaining?` · ${latest.remaining} not dispatched`:''}.</small>
    <small>A provider acknowledgement records acceptance of a message. It does not establish that the recipient read it.</small>
    <details className="workflow-history"><summary>Delivery attempts ({attempts.length})</summary>
      {[...attempts].reverse().map((attempt,reverseIndex)=>{
        const progress=count(attempt),number=attempts.length-reverseIndex;
        return <section key={attempt.id||number} aria-label={`Delivery attempt ${number}`}>
          <h3>Attempt {number}{attempt.id===current.id?' · latest':''}</h3>
          <small>{attempt.startedAt?new Date(attempt.startedAt).toLocaleString():'Time unavailable'} · {attempt.channel||delivery.channel} · {progress.acknowledged} of {progress.total||'unknown number of'} messages acknowledged</small>
          {attempt.contract?.automaticReplay===false&&<small>Automatic replay is disabled. An uncertain result requires destination review.</small>}
          {!progress.parts.length?<small>No message dispatch was recorded.</small>:<ol>{progress.parts.map((part,index)=><li key={part.index??index}>
            <strong>Message {(Number.isSafeInteger(part.index)?part.index:index)+1} of {part.total||progress.total||'?'} · {part.status==='acknowledged'?'Provider acknowledged':'Outcome unknown until acknowledged'}</strong>
            {part.messageId&&<small>Provider message ID: <code>{part.messageId}</code></small>}
            <small>{Number(part.bytes||0).toLocaleString()} bytes · SHA-256: <code>{part.sha256||'Not recorded'}</code></small>
            {part.at&&<small><time dateTime={part.at}>{new Date(part.at).toLocaleString()}</time></small>}
          </li>)}</ol>}
        </section>;
      })}
    </details>
  </div>;
}
function XIcon(){return <span aria-hidden="true">×</span>;}
export function PromptSuggestions({ draft, prompts = [], onPick }) {
  if (!/^\/[\w-]*$/.test(draft.trim())) return null;
  const query=draft.trim().slice(1).toLowerCase(), matches=prompts.filter(p=>p.shortcut.startsWith(query));
  return <div className="prompt-suggestions" aria-label="Saved prompt suggestions">{matches.length?matches.slice(0,8).map(p=><button key={p.id} type="button" onClick={()=>onPick(p.text)}><code>/{p.shortcut}</code><span>{p.name}</span></button>):<p>No saved prompt matches. Add one in Library → Saved prompts.</p>}</div>;
}
