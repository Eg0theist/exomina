/** Shared by the renderer and tests. Lifts append visible guidance to the user's own words; nothing is added out of sight. */
// After Felix Rieseberg's four kinds of ambition (speed, altitude, depth, range) plus outside validation.
export const LIFTS = [
  { id: 'faster', label: 'Just do it', hint: 'Get the finished result instead of instructions',
    text: 'Don’t explain how I could do this: do it yourself with the tools you have and hand me the finished result. Ask me only if you are truly stuck.' },
  { id: 'bigger', label: 'Think bigger', hint: 'Solve the goal behind the request, not just the request',
    text: 'Before you start, think about what I am really trying to achieve and what should happen next. Solve that larger goal rather than only the literal request, and tell me briefly how you widened it.' },
  { id: 'deeper', label: 'Go deeper', hint: 'Work like a top expert, from original sources',
    text: 'Work the way the best expert in this field would. Start from the rawest sources available (original documents, official websites, the actual data) rather than summaries, use real tools such as spreadsheets or calculations where they help, and hold yourself to a high standard. Point out anything you could not verify.' },
  { id: 'wider', label: 'Bring in a team', hint: 'Several expert viewpoints, including a sceptic',
    text: 'Look at this through the eyes of several different experts, including at least one who would argue against the obvious answer. Combine what each would contribute into one result and note where they would disagree.' },
  { id: 'check', label: 'Second opinion', hint: 'Another AI checks the result, not the one that wrote it',
    text: 'When you are done, ask a different connected AI to critique your result (a critique, not agreement). Fix what holds up and tell me what it found. If no other AI is available, say so rather than reviewing your own work.' },
];
export const LANGUAGE_NOTE = 'Reply in the language of my request above.';

const blocks = () => [...LIFTS.map(lift => lift.text), LANGUAGE_NOTE];

/** Separates the user's own words from recognised lift paragraphs. Edited lift text stays part of the request. */
export function splitAmbition(text = '') {
  const parts = String(text).split(/\n{2,}/);
  const ids = [];
  let end = parts.length;
  while (end > 0 && blocks().includes(parts[end - 1].trim())) {
    const lift = LIFTS.find(item => item.text === parts[end - 1].trim());
    if (lift) ids.unshift(lift.id);
    end -= 1;
  }
  return { base: parts.slice(0, end).join('\n\n').trimEnd(), ids };
}

export function composeAmbition(base = '', ids = []) {
  const chosen = LIFTS.filter(lift => ids.includes(lift.id));
  const own = String(base).trimEnd();
  return chosen.length ? [own, ...chosen.map(lift => lift.text), LANGUAGE_NOTE].join('\n\n') : own;
}

export function toggleLift(text, id) {
  if (!LIFTS.some(lift => lift.id === id)) return String(text);
  const { base, ids } = splitAmbition(text);
  return composeAmbition(base, ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
}

/** After a reply: the same ideas, applied to what the AI has just produced. */
export const FURTHER = [
  { id: 'deeper', label: 'Go deeper', text: 'Take this further: go back to the original sources or data behind your answer, check the important claims and numbers yourself, and improve the result wherever they do not hold up. Tell me what changed.' },
  { id: 'next', label: 'What’s next?', text: 'Step back: given what we have now, what should happen next to reach my actual goal? Suggest the next two or three steps, then start on the most useful one.' },
  { id: 'wider', label: 'Other angles', text: 'Look at your last answer from three other expert perspectives, including one sceptic. Say what each would change, then give me the improved version.' },
  { id: 'check', label: 'Second opinion', text: 'Ask a different connected AI to critique your last answer (a critique, not a vote). Show me what it found and fix what holds up. If no other AI is available, tell me instead of reviewing your own work.' },
];

/** What most people ask, next to what they could ask. Brackets mark details the user fills in. */
export const IDEAS = [
  { area: 'life', lift: 'bigger', before: 'What should I watch out for when switching electricity provider?', headline: 'Find out if switching saves money, then write the letter',
    prompt: 'I’ll attach my last electricity bill. Work out what I really pay per kWh including the base fee, compare it with three current offers for [your postcode] from the providers’ own websites, and if switching saves more than €100 a year, draft the cancellation letter for me.' },
  { area: 'life', lift: 'deeper', before: 'Give me ideas for a weekend in Lisbon.', headline: 'A checked day-by-day plan within your budget',
    prompt: 'Plan 3 days in Lisbon for two people in [month] with a budget of €[amount]. Check opening hours and prices on the official websites, build a day-by-day plan with walking times, and flag everything that has to be booked ahead.' },
  { area: 'life', lift: 'bigger', before: 'How do I write a complaint to my landlord?', headline: 'A letter with a deadline, and a plan if it’s ignored',
    prompt: 'My landlord hasn’t fixed [problem] since [date]. Draft a firm but polite letter that sets a deadline, cite my tenant rights in [country] from official sources, and tell me what I can do if the deadline passes.' },
  { area: 'work', lift: 'wider', before: 'Make this email sound more professional.', headline: 'An email written to get a yes',
    prompt: 'Here is an email I need to send to [recipient]: [paste it]. Rewrite it so they say yes, then read it the way a sceptical [their role] would and fix whatever would make them hesitate.' },
  { area: 'work', lift: 'check', before: 'Summarise this report.', headline: 'The decisions it asks of you, with checked numbers',
    prompt: 'I’ll attach a report. Tell me the three decisions it actually asks of me, check its key numbers against the tables inside it, and draft my reply. Have another AI check the numbers before I see them.' },
  { area: 'work', lift: 'faster', before: 'Explain this spreadsheet formula.', headline: 'Fixed formulas, and how to check them yourself',
    prompt: 'I’ll attach my spreadsheet. Find formulas that are wrong or fragile, fix them, explain each fix in one sentence, and show me how to check it myself.' },
  { area: 'business', lift: 'deeper', before: 'Write an Instagram post for my bar.', headline: 'A month of posts built on what guests love',
    prompt: 'Look at the Google reviews and Instagram of my business [name and link]. Work out what customers genuinely love, then plan a month of posts around it, with drafts I can approve one by one.' },
  { area: 'business', lift: 'wider', before: 'Which software is cheapest for us?', headline: 'What you really pay for, and cheaper options',
    prompt: 'We pay €[amount] a month for [software]. Find out what it actually does for us, list cheaper alternatives that meet the same legal requirements in [country], and compare the total cost over three years in a table.' },
  { area: 'business', lift: 'faster', before: 'Help me answer this customer review.', headline: 'Every open review answered, ready to approve',
    prompt: 'Go through the Google reviews of [business name] from the last three months. Draft a reply to every unanswered one in a warm, personal tone that fits us, flag any I should handle personally, and give me the drafts to approve before anything is posted.' },
  { area: 'learning', lift: 'bigger', before: 'Explain how investing works.', headline: 'A two-week course that adapts to you',
    prompt: 'Teach me the basics of investing over two weeks, 20 minutes a day. Build the plan, start lesson one now, quiz me at the end, and shape the next lesson around what I got wrong.' },
  { area: 'learning', lift: 'bigger', before: 'Help me with my Spanish.', headline: 'A conversation partner that remembers your mistakes',
    prompt: 'Be my Spanish conversation partner for 15 minutes a day at [my level]. Talk with me about everyday topics, correct my mistakes at the end of each session, and keep a list of what I keep getting wrong so the next session focuses on it.' },
  { area: 'learning', lift: 'deeper', before: 'Is this news article true?', headline: 'Trace a claim back to its original source',
    prompt: 'Here is a claim I read: [paste it]. Trace it back to the original study, statistic or statement, compare what the source actually says with how it was reported, and tell me how far I should trust it.' },
];
export const IDEA_AREAS = [['life', 'Everyday life'], ['work', 'Work'], ['business', 'Your business'], ['learning', 'Learning']];
