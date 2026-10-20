// Phone task counts come from saved records, independently of its bounded chat history.
export const phoneNeedsAnswer = group => ['waiting', 'open'].includes(group?.status) || group?.status === 'answered' && ['failed', 'sending'].includes(group.deliveryState);

export function phonePendingQuestions(chat) {
  const groups = new Map();
  for (const message of chat.messages || []) for (const group of message.questions || []) groups.set(group.id, group);
  return [...groups.values()].filter(phoneNeedsAnswer);
}

export function phoneWorkCounts(chat) {
  const followups = (chat.messages || []).flatMap(message => message.followups || []);
  return {
    pendingQuestions: phonePendingQuestions(chat).length,
    pendingFollowups: followups.filter(item => !['handled', 'blocked', 'cancelled'].includes(item.taskStatus) && (item.taskStatus || ['sending', 'answering', 'delivered'].includes(item.status))).length,
    blockedFollowups: followups.filter(item => item.taskStatus === 'blocked').length,
  };
}

export function phoneFollowupLabel(item) {
  const task = { working: 'Handling in the task', handled: 'Handled by the task', blocked: 'Needs attention', cancelled: 'Follow-up stopped' };
  const answer = { sending: 'Sending follow-up', delivered: 'Delivered to the active task', answering: 'Answering alongside the task', answered: 'Answered alongside the task', failed: 'Follow-up answer failed' };
  return task[item.taskStatus] || (item.taskStatus === 'pending' && item.status === 'answered' ? 'Answered · waiting for the task' : answer[item.status] || 'Follow-up');
}
