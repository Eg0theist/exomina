// Conservative recovery for a direct assistant question followed by choices.
// This only describes UI. It never invokes tools or grants permissions.
const directQuestion = /^(?:how|which|what|when|where|why|who|do you|did you|does your|are you|is your|would you|could you|can you|have you|will you|wie|welche\w*|was|wann|wo|warum|wer|hast du|haben sie|möchtest du|möchten sie)\b/i;
const consentQuestion = /\b(?:permission|approve|approval|authorize|authorization|consent|allow me|may i|shall i|should i|can i|darf ich|soll ich|genehmig\w*|erlaub\w*)\b/i;
const choiceLine = /^( {0,3})(?:[-*+] |\d{1,2}[.)] )(\S.*)$/;

export function findTextQuestions(value) {
  if (typeof value !== 'string' || value.length > 100000) return [];
  const lines = []; let offset = 0, fence = null;
  for (const raw of value.split('\n')) {
    const text = raw.replace(/\r$/, ''), marker = text.match(/^ {0,3}(`{3,}|~{3,})/);
    const excluded = !!fence || !!marker || /^\s*>|^(?: {4}|\t)/.test(text);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; }
    lines.push({ text, offset, excluded }); offset += raw.length + 1;
  }
  const found = [];
  for (let i = 0; i < lines.length && found.length < 6; i++) {
    const line = lines[i], question = line.text.trim().replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/, '$1');
    if (line.excluded || !question.endsWith('?') || question.length > 1000 || !directQuestion.test(question) || consentQuestion.test(question)) continue;
    let j = i + 1; while (j < lines.length && !lines[j].text.trim()) j++;
    const options = []; let end = j, invalid = false, indent;
    while (j < lines.length && !lines[j].excluded) {
      const match = lines[j].text.match(choiceLine); if (!match) break;
      if (indent === undefined) indent = match[1];
      else if (indent !== match[1]) { invalid = true; break; }
      const label = match[2].trim();
      if (label.length > 500 || /^\[[ xX]\]|[<>]|https?:\/\//.test(label)) { invalid = true; break; }
      options.push(label); end = ++j;
    }
    // Nested lists, wrapped explanations and seven-choice lists stay Markdown.
    if (invalid || options.length < 2 || options.length > 6 || new Set(options).size !== options.length || /^\s+\S/.test(lines[j]?.text || '')) continue;
    found.push({ start: line.offset, end: end < lines.length ? lines[end].offset : value.length, question, options });
    i = j - 1;
  }
  return found;
}

export const textQuestionSignature = question => JSON.stringify([question.question, question.options.map(option => typeof option === 'string' ? option : option.label)]);

export function textQuestionGroup(message, stepId, question) {
  const signature = textQuestionSignature(question);
  const source = { kind: 'assistant-text', messageId: message.id, stepId, start: question.start, signature };
  const id = 'text-question:' + JSON.stringify([message.id, stepId, question.start]);
  const saved = (message.questions || []).find(group => group.id === id && group.source?.signature === signature);
  if (saved) return saved;
  // A real question-tool card already supplies these controls. An exact manual
  // choice admitted as a follow-up is user evidence, so don't ask it again.
  if ((message.questions || []).some(group => !group.source && group.questions?.some(item => textQuestionSignature(item) === signature)) ||
      (message.followups || []).some(item => question.options.includes(item.question?.trim()))) return null;
  return { id, source, status: 'open', createdAt: message.startedAt, questions: [{ id: 'answer', question: question.question, options: question.options.map(label => ({ label })) }] };
}

export function resolveTextQuestion(message, source) {
  if (message?.role !== 'assistant' || source?.kind !== 'assistant-text' || source.messageId !== message.id ||
      typeof source.stepId !== 'string' || !Number.isInteger(source.start) || typeof source.signature !== 'string') throw Error('This question is not part of an assistant reply.');
  const text = source.stepId === 'content' ? message.content : message.activity?.find(step => step.id === source.stepId && step.kind === 'note')?.text;
  const question = findTextQuestions(text).find(item => item.start === source.start && textQuestionSignature(item) === source.signature);
  if (!question) throw Error('This question changed while the reply was updating. Select your answer on the current question.');
  const group = textQuestionGroup(message, source.stepId, question);
  if (!group) throw Error('This question already has an answer or a question card. Use that card or send a normal message.');
  return group;
}
