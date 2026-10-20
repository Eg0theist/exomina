// Starting suggestions, not benchmarks. Only models and efforts reported by the
// selected connection, and left visible by the user, may be offered by the UI.
export const MODEL_TASKS = [
  { id: 'quick', title: 'Small, clear task', example: 'Extract a few figures, tidy a short draft or make a small edit.', role: 'light', efforts: ['low', 'minimal', 'none', 'medium'] },
  { id: 'everyday', title: 'Everyday work', example: 'Draft, explain, code or compare options with room to revise.', role: 'balanced', efforts: ['medium', 'high', 'low'] },
  { id: 'difficult', title: 'Difficult problem', example: 'Investigate a stubborn bug, weigh conflicting evidence or build a complex plan.', role: 'deep', efforts: ['high', 'xhigh', 'max', 'ultra', 'medium', 'low'] },
];

export function modelTaskRole(model) {
  const name = `${model.id || ''} ${model.label || ''}`.toLowerCase();
  if (/\b(luna|haiku|mini|nano|flash|small)\b/.test(name)) return 'light';
  if (/\b(astra|terra|opus)\b/.test(name)) return 'deep';
  if (/\b(sol|sonnet)\b/.test(name)) return 'balanced';
  return '';
}

export function modelTaskChoice(models, taskId, { allowDefault = true } = {}) {
  const task = MODEL_TASKS.find(item => item.id === taskId);
  if (!task) return null;
  const named = models.filter(item => !['auto', 'default'].includes(item.id) && modelTaskRole(item) === task.role);
  const match = named.find(item => item.isDefault) || named[0];
  const fallback = models.find(item => item.id === 'auto' || item.isDefault || item.id === 'default');
  if (!match && (!allowDefault || !fallback)) return null;
  const model = match || fallback;
  const efforts = (model.efforts || []).map(item => typeof item === 'string' ? item : item.id);
  const effort = task.efforts.find(id => efforts.includes(id)) || (efforts.includes(model.defaultEffort) ? model.defaultEffort : '');
  return { model: match ? model.id : 'auto', label: match ? model.label || model.id : 'Provider default', effort, defaultModel: !match };
}
