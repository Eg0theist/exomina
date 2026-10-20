/** Questions remain in their conversation position even when a bounded work
 * history drops their activity row or a live card arrives before that row. */
import {findTextQuestions,textQuestionSignature} from '../desktop/text-questions.mjs';
export function questionFlowMessage(message) {
  const activity = [...(Array.isArray(message.activity) ? message.activity : [])];
  const present = new Set(activity.filter(step => step.kind === 'question').map(step => step.questionId));
  for (const group of message.questions || []) {
    if (group.source?.kind === 'assistant-text') {
      const text = group.source.stepId === 'content' ? message.content : activity.find(step => step.id === group.source.stepId && step.kind === 'note')?.text;
      if (findTextQuestions(text).some(question => question.start === group.source.start && textQuestionSignature(question) === group.source.signature)) continue;
    }
    if (present.has(group.id)) continue;
    const step = { id: 'question:' + group.id, kind: 'question', questionId: group.id, status: 'done', startedAt: group.createdAt };
    const anchored = group.activityAfterId ? activity.findIndex(item => item.id === group.activityAfterId) : -1;
    const stamp = Date.parse(group.createdAt || '');
    const dated = Number.isFinite(stamp) ? activity.findIndex(item => Date.parse(item.startedAt || '') > stamp) : -1;
    const index = anchored >= 0 ? anchored + 1 : dated >= 0 ? dated : activity.length;
    activity.splice(index, 0, step);
    present.add(group.id);
  }
  return { ...message, activity };
}
