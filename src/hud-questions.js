import { questionFlowMessage } from './question-flow.js';
import { findTextQuestions, textQuestionGroup } from '../desktop/text-questions.mjs';

/** Preserve the questions inside the work log without showing the log itself.
 * Questions still present in final reply prose are rendered there by AssistantText. */
export function hudQuestionGroups(message) {
  if (message?.role !== 'assistant') return [];
  const groups = [], seen = new Set();
  const add = group => { if (group && !seen.has(group.id)) { seen.add(group.id); groups.push(group); } };
  for (const step of questionFlowMessage(message).activity) {
    if (step.kind === 'question') add(message.questions?.find(group => group.id === step.questionId));
    else if (step.kind === 'note') {
      for (const question of findTextQuestions(step.text)) add(textQuestionGroup(message, step.id, question));
    }
  }
  return groups;
}
