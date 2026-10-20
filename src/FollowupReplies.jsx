import { MessageSquare, LoaderCircle, Square } from 'lucide-react';
import Markdown from './Markdown.jsx';
import SelectableText from './SelectableText.jsx';

const labels = { sending: 'Sending follow-up…', delivered: 'Delivered to the active task · work continues', answering: 'Answering alongside the task…', answered: 'Answered alongside the task', failed: 'Follow-up could not be answered' };
const taskLabels = { working: 'Handling in the task…', handled: 'Handled by the task', blocked: 'Needs attention', cancelled: 'Follow-up stopped' };
export function FollowupCard({ item, onLink, onCancel }) {
  const label = taskLabels[item.taskStatus] || (item.taskStatus === 'pending' && item.status === 'answered' ? 'Answered · waiting for the task' : labels[item.status] || item.status);
  return <div className="live-followup" data-status={item.status} data-task-status={item.taskStatus} data-followup-id={item.id}>
    <div className="live-followup-head" role="status">{item.taskStatus === 'working' || ['sending', 'answering'].includes(item.status) ? <LoaderCircle size={14} className="spin"/> : <MessageSquare size={14}/>}<span>{label}</span><small>{item.model && item.model !== 'auto' ? item.model : item.provider}</small>{item.status === 'answering' && onCancel && <button className="icon-button" type="button" aria-label="Stop this follow-up answer" title="Stop this follow-up; the original task continues" onClick={() => onCancel(item.id)}><Square size={12}/></button>}</div>
    <SelectableText as="p" className="live-followup-question">{item.text || 'Attached files'}</SelectableText>
    {item.attachments?.length > 0 && <small>{item.attachments.map(a => a.name).join(', ')}</small>}
    {item.reads?.length > 0 && <details className="live-followup-earlier"><summary>Sources checked · {item.reads.length}</summary><ul>{item.reads.map((read, index) => <li key={index}>{read.name.replaceAll('_', ' ')} · {read.status === 'done' ? 'checked' : read.status === 'error' ? 'unavailable' : 'reading…'}</li>)}</ul></details>}
    {item.summary && <SelectableText as="div" className="live-followup-resolution"><Markdown text={item.summary} onLink={onLink}/></SelectableText>}
    {item.answer && (item.summary ? <details className="live-followup-earlier"><summary>Earlier answer while work continued</summary><SelectableText as="div" className="live-followup-answer"><Markdown text={item.answer} onLink={onLink}/></SelectableText></details> : <SelectableText as="div" className="live-followup-answer"><Markdown text={item.answer} onLink={onLink}/></SelectableText>)}
    {item.error && item.taskStatus !== 'handled' && <p className="inline-error">{item.error}</p>}
  </div>;
}
export default function FollowupReplies({ message, items = message?.followups || [], onLink, onCancel }) {
  if (!items.length) return null;
  return <section className="live-followups" aria-label="Follow-ups during this task">{items.map(item => <FollowupCard key={item.id} item={item} onLink={onLink} onCancel={onCancel}/>)}</section>;
}
