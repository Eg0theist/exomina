import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X } from 'lucide-react';
import { QuestionAnswerForm } from './QuestionCards.jsx';

export default function QuestionPopup({ group, chatTitle, pendingCount, busy, onAnswer, onContinue, onClose }) {
  const dialog = useRef(null), close = useRef(onClose), sending = useRef(busy);
  close.current = onClose; sending.current = busy;
  useLayoutEffect(() => {
    const previous = document.activeElement, frame = document.querySelector('.app-frame'), wasInert = frame?.inert;
    if (frame) frame.inert = true;
    (dialog.current?.querySelector('input:not(:disabled),textarea,button:not(:disabled)') || dialog.current)?.focus({ preventScroll: true });
    const keyboard = event => {
      if ((event.ctrlKey || event.metaKey) && ['n', ',', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!sending.current) close.current(); return; }
      if (event.key !== 'Tab') return;
      const candidates = [...(dialog.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])].filter(element => !element.closest('fieldset:disabled') && element.getClientRects().length);
      const first = candidates[0], last = candidates.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus({ preventScroll: true }); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      if (frame) frame.inert = wasInert;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [group.id]);
  return createPortal(<div className="modal-backdrop question-popup-backdrop"><section className="modal question-popup" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="question-popup-title" aria-describedby="question-popup-chat" tabIndex={-1} data-question-id={group.id}>
    <button type="button" className="modal-close icon-button" aria-label="Close question popup" disabled={busy} onClick={onClose}><X size={18} /></button>
    <div className="modal-icon"><MessageSquare size={23} /></div><h2 id="question-popup-title">Your input</h2>
    <p id="question-popup-chat">{chatTitle}{pendingCount > 1 ? ' · ' + pendingCount + ' questions awaiting your answer' : ''}</p>
    <QuestionAnswerForm key={group.id} group={group} onAnswer={onAnswer} onContinue={onContinue} />
    <div className="question-popup-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Later</button><span>The question stays in the conversation, where it was asked.</span></div>
  </section></div>, document.body);
}
