import React from 'react';
import Markdown from './Markdown.jsx';
import { QuestionCard } from './QuestionCards.jsx';
import { findTextQuestions, textQuestionGroup } from '../desktop/text-questions.mjs';

/** Recover only primary assistant prose, never user text, tool results, quotes,
 * helper contributions or reasoning. Answers still need an explicit submission. */
export default function AssistantText({ text, message, stepId = 'content', mark, onLink, onAnswer }) {
  const questions = onAnswer && message?.role === 'assistant' ? findTextQuestions(text) : [];
  const parts = []; let cursor = 0;
  const prose = (end, key) => {
    const start = cursor, value = text.slice(start, end); cursor = end;
    if (value) parts.push(<Markdown key={key} text={value} mark={mark ? (value, at) => mark(value, start + at) : undefined} onLink={onLink} />);
  };
  for (const question of questions) {
    const group = textQuestionGroup(message, stepId, question); if (!group) continue;
    prose(question.start, 'before:' + question.start);
    parts.push(<div className="text-question" key={group.id}><QuestionCard group={group} inlineOnly onAnswer={(id, answers) => onAnswer(id, answers, group.source)} /></div>);
    cursor = question.end;
  }
  prose(text.length, 'tail');
  return parts;
}
