import React from 'react';
import { QuestionCard } from './QuestionCards.jsx';
import { hudQuestionGroups } from './hud-questions.js';

export default function HudQuestions({ message, onAnswer, onContinue }) {
  const groups = hudQuestionGroups(message);
  if (!groups.length) return null;
  return <div className="hud-questions" aria-label="Questions during this task">{groups.map(group => <QuestionCard key={group.id} group={group} inlineOnly onAnswer={(id, answers) => onAnswer(id, answers, group.source)} onContinue={onContinue} />)}</div>;
}
