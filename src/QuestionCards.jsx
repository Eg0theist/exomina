import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, MessageSquare } from 'lucide-react';
import './questions.css';

export const QuestionDraftContext = createContext(null);
export const needsQuestionAnswer = group => ['waiting', 'open'].includes(group.status) || group.status === 'answered' && ['failed', 'sending'].includes(group.deliveryState);
const initialValues = group => Object.fromEntries(group.questions.map(question => [question.id, { choice: question.options.length ? '' : 'custom', selections: [], custom: false, text: '' }]));

export function QuestionAnswerForm({ group, onAnswer, onContinue }) {
  const session = useContext(QuestionDraftContext);
  const [localValues, setLocalValues] = useState(() => initialValues(group));
  const values = session?.drafts[group.id] || localValues;
  const [now, setNow] = useState(Date.now()), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), sending = busy || !!session?.sending.includes(group.id);
  useEffect(() => { if (group.status !== 'waiting') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [group.status]);
  const unanswered = ['waiting', 'open'].includes(group.status), seconds = Math.max(0, Math.ceil((Date.parse(group.expiresAt) - now) / 1000));
  const change = (id, patch) => {
    const update = previous => ({ ...previous, [id]: { ...previous[id], ...patch } });
    if (session) session.change(group.id, update, initialValues(group)); else setLocalValues(update);
  };
  const answers = Object.fromEntries(group.questions.map(question => {
    const value = values[question.id] || {};
    const answer = question.multiSelect && question.options.length
      ? value.custom && !value.text?.trim() ? '' : [...(value.selections || []).map(index => question.options[index]?.label).filter(Boolean), ...(value.custom ? [value.text.trim()] : [])].join(', ')
      : value.choice === 'custom' ? value.text?.trim() || '' : value.choice !== '' && value.choice !== undefined ? question.options[Number(value.choice)]?.label || '' : '';
    return [question.id, answer];
  }));
  const submit = async answersToSend => {
    if (locked.current || sending) return; locked.current = true; setBusy(true); setError('');
    try { const result = await onAnswer(group.id, answersToSend); if (result?.deliveryState === 'failed') throw Error(result.deliveryError || 'Your answer is saved, but sending it failed. Retry when ready.'); }
    catch (failure) { setError(failure.message || String(failure)); } finally { locked.current = false; setBusy(false); }
  };
  const skip = async () => {
    if (locked.current || sending) return; locked.current = true; setBusy(true); setError('');
    try { await onContinue(group.id); } catch (failure) { setError(failure.message || String(failure)); } finally { locked.current = false; setBusy(false); }
  };
  return <div className="question-card-body">
    {unanswered && <p className="question-timer" role="status">{group.source?.kind === 'assistant-text' ? 'Choose an answer below, or write your own.' : group.requireAnswer && group.waitingForAnswer ? 'This task is waiting for your answer. Take your time; closing this popup keeps it waiting.' : group.status === 'waiting' ? 'Optional question. Response window: ' + seconds + 's. You can also answer later.' : group.windowOutcome === 'continued' ? 'Work continues. You can still answer here.' : 'The response window has ended. You can still answer here; no choice was made for you.'}</p>}
    {group.status === 'irrelevant' ? <p>{group.reason}</p> : group.status === 'answered' ? <>
      {group.questions.map(question => <div className="question-answer" key={question.id}><strong>{question.question}</strong><p>{group.answers?.[question.id]?.answers?.join(', ')}</p></div>)}
      {(sending || group.deliveryState === 'sending') && <p className="question-timer" role="status">{sending ? 'Sending…' : 'Sending has not been confirmed yet.'}</p>}
      {group.deliveryState === 'sending' && !sending && <button type="button" className="secondary-button" disabled={!onAnswer} onClick={() => submit(Object.fromEntries(group.questions.map(question => [question.id, group.answers[question.id].answers[0]])))}>Check answer again</button>}
      {group.deliveryState === 'failed' && <><p className="inline-error">Your answer is saved but could not be sent: {group.deliveryError}</p><button type="button" className="secondary-button" disabled={sending || !onAnswer} onClick={() => submit(Object.fromEntries(group.questions.map(question => [question.id, group.answers[question.id].answers[0]])))}>Retry sending answer</button></>}
    </> : <form onSubmit={event => { event.preventDefault(); submit(answers); }}>
      {group.questions.map(question => <fieldset key={question.id} disabled={sending}>
        <legend>{question.question}</legend>
        {question.multiSelect && question.options.length > 0 && <p className="question-selection-hint">Choose one or more answers.</p>}
        {question.options.map((option, index) => {
          const checked = question.multiSelect ? values[question.id]?.selections?.includes(index) || false : values[question.id]?.choice === String(index);
          return <label className={'question-option' + (checked ? ' is-selected' : '')} key={index}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={group.id + ':' + question.id} value={String(index)} checked={checked} onChange={event => change(question.id, question.multiSelect ? { selections: event.target.checked ? [...(values[question.id]?.selections || []), index].sort((a, b) => a - b) : (values[question.id]?.selections || []).filter(value => value !== index) } : { choice: String(index) })} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>;
        })}
        {question.options.length > 0 && <label className={'question-option' + ((question.multiSelect ? values[question.id]?.custom : values[question.id]?.choice === 'custom') ? ' is-selected' : '')}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={group.id + ':' + question.id} value="custom" checked={question.multiSelect ? values[question.id]?.custom || false : values[question.id]?.choice === 'custom'} onChange={event => change(question.id, question.multiSelect ? { custom: event.target.checked } : { choice: 'custom' })} /><span>Write my own answer</span></label>}
        {(values[question.id]?.choice === 'custom' || question.multiSelect && values[question.id]?.custom) && <textarea aria-label={'Your answer: ' + question.question} placeholder="Type your answer…" rows={2} maxLength={4000} value={values[question.id]?.text || ''} onChange={event => change(question.id, { text: event.target.value })} />}
      </fieldset>)}
      <div className="question-actions"><button type="submit" className="primary-button" disabled={sending || !onAnswer || Object.values(answers).some(value => !value)}>{sending ? 'Sending…' : 'Send answer'}</button>{group.status === 'waiting' && !group.requireAnswer && onContinue && <button type="button" className="text-button" disabled={sending} onClick={skip}>Continue while I decide</button>}</div>
      {!sending && Object.values(answers).some(value => !value) && <p className="question-selection-hint">Choose or write an answer for each question, then send it.</p>}
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}

export function QuestionCard({ group, onAnswer, onContinue, inlineOnly = false }) {
  const session = useContext(QuestionDraftContext);
  const [open, setOpen] = useState(group.status !== 'answered' && group.status !== 'irrelevant');
  useEffect(() => {
    // A live form becomes the same compact record shown when the chat reopens.
    if ((group.status === 'answered' && !needsQuestionAnswer(group)) || group.status === 'irrelevant') setOpen(false);
    else if (needsQuestionAnswer(group)) setOpen(true);
  }, [group.status, group.deliveryState]);
  const title = group.status === 'answered' ? 'Your answer' : group.status === 'irrelevant' ? 'Question resolved' : group.remindedAt ? 'Question still awaiting your answer' : 'Your input';
  const preview = group.status === 'answered'
    ? group.questions.map(question => (group.answers?.[question.id]?.answers || []).join(', ') + ' · ' + question.question).join(' · ')
    : group.questions[0]?.question;
  return <section className="question-card" data-question-id={group.id} data-status={group.status} aria-label="Question for you">
    <button type="button" className="question-card-head" aria-expanded={open} onClick={() => { if (!inlineOnly && needsQuestionAnswer(group) && session?.open) session.open(group.id); else setOpen(!open); }}>
      {group.status === 'answered' ? <Check size={15} /> : <MessageSquare size={15} />}<strong>{title}</strong><span className="question-preview" title={preview}>{preview}</span><ChevronRight size={14} />
    </button>
    {open && <QuestionAnswerForm group={group} onAnswer={onAnswer} onContinue={onContinue} />}
  </section>;
}
export default function QuestionCards({ groups = [], onAnswer, onContinue }) { return groups.length ? <div className="question-cards">{groups.map(group => <QuestionCard key={group.id} group={group} onAnswer={onAnswer} onContinue={onContinue} />)}</div> : null; }
