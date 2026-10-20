// Chat or tools, decided per message. Ordinary conversation runs lean: no shell, file,
// browser or desktop tools, so the runtime starts lighter and the request is smaller.
// When a lean answer turns out to need real tools, the model calls request_tools and
// Exomina reruns the same request with the full suite, in the same chat.

export const ROUTING_MODES = ['auto', 'chat', 'tools'];
/** Runtimes that can run lean: their built-in tools can be switched off per run. */
export const LEAN_PROVIDERS = new Set(['codex', 'claude']);
/** Host tools that stay available in chat mode: memory, history and conversation help. */
export const LEAN_TOOLS = /^(memory_|archive_|notes_overview$|conversation_(search|read|find|set_title|zoom|date)$|followup_update$|handoff_save$|ask_user_question(?:_async)?$|request_user_input(?:_async)?$|question_update$|personalization_update$|soul_reflect$|image_(generate|read)$|model_(available|consult)$|app_update_status$|app_inspect$)/;

export const REQUEST_TOOLS = {
  name: 'request_tools',
  description: 'This turn runs in chat mode without file, shell, code, browser, desktop or native image tools. If answering well needs any of them, call this first, before writing an answer, with a short reason. Exomina then reruns the same request with the full tool suite. Do not call it for questions you can answer from knowledge, memory or chat history.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 300 } }, required: ['reason'], additionalProperties: false },
};

export const LEAN_INSTRUCTIONS = 'This turn runs in Exomina chat mode: memory, chat history, archive and image tools are available; file, shell, code, browser and desktop tools are switched off to keep replies fast. If the request needs those, call request_tools with a short reason before answering, and stop. Otherwise answer directly.\n';

// Signals that a message is about work rather than conversation. English and German.
const TOOL_HINTS = new RegExp([
  '```', '\\b[a-z]:\\\\', '(^|\\s)[.~]?/[\\w.-]+/', 'https?://', 'www\\.',
  '\\.(m?js|jsx|tsx?|py|json|md|css|html?|ps1|sh|txt|csv|xlsx?|pdf|docx?|pptx?|ya?ml|toml|sql|zip)\\b',
  '\\b(code|coding|bug|debug|fix|implement|refactor|compile|install|deploy|repo|github|commit|script|terminal|command line|npm|pip|git)\\b',
  '\\b(file|files|folder|directory|workspace|screenshot|browser|website|web page|webpage|search the web|look up online|google|download|upload|open the|desktop app|spreadsheet|document)\\b',
  '\\b(datei|dateien|ordner|verzeichnis|installier\\w*|programmier\\w*|skript|webseite|website|im (internet|web) such\\w*|herunterlad\\w*|öffne)\\b',
].join('|'), 'i');

export const sessionKey = (provider, lane) => lane === 'chat' ? provider + ':chat' : provider;
const hostName = name => String(name || '').replace(/^mcp__exomina__/, '');

// Carry tools forward for a short instruction to continue the work. A new
// reflective question should return to chat even after a coding turn.
const CONTINUE_WORK = /^(?:yes[,!\s]|yep\b|go ahead\b|do (?:it|that|this)\b|continue\b|keep (?:going|working)\b|carry on\b|proceed\b|and now\??$|what(?:'s| is) next\??$|try again\b|make (?:it|that|this)\b|add (?:it|that|this)\b|change (?:it|that|this)\b|looks? good[,!\s]|weiter\b|mach weiter\b|mach (?:das|es)\b|ja[,!\s]|nochmal\b)/i;

/** True when a reply did real tool work (anything beyond chat-mode tools). */
export function usedTools(message) {
  return (message?.activity || []).some(step => step.kind === 'tool' && !LEAN_TOOLS.test(hostName(step.name)) && hostName(step.name) !== 'request_tools');
}

/** 'chat' or 'tools' for one message. Explicit choices win; Auto follows the conversation. */
export function chooseLane({ requested = 'auto', text = '', attachments = [], provider, channel = false, background = false, previousUsedTools = false }) {
  if (!LEAN_PROVIDERS.has(provider) || background) return 'tools';
  if (channel) return 'chat';
  if (requested === 'chat' || requested === 'tools') return requested;
  if (attachments.some(item => item?.kind !== 'image')) return 'tools';
  return TOOL_HINTS.test(text) || (previousUsedTools && CONTINUE_WORK.test(text.trim())) ? 'tools' : 'chat';
}
