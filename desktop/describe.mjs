/** Plain-language descriptions of what an agent is doing, shared by the main
 * process (approval requests, activity steps) and the renderer (timeline). No
 * jargon: a non-technical reader should understand every title.
 */
const short = (value, limit = 160) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? text.slice(0, limit - 1) + '…' : text; };
const fileName = value => { const text = String(value || ''); return text.split(/[\\/]/).filter(Boolean).pop() || text; };
const first = (input, ...keys) => { for (const key of keys) if (input?.[key] !== undefined && input[key] !== '') return input[key]; return ''; };
const command = value => Array.isArray(value) ? value.join(' ') : String(value || '');

/** kind groups steps visually: read, write, execute, search, web, browser, desktop, memory, image, agent, app, tool. */
const HOST = {
  ghidra_status: ['read', 'Checking the Ghidra project', 'Checked the Ghidra project'],
  ghidra_query: ['read', 'Reading the Ghidra project', 'Read the Ghidra project', input => input.operation],
  ghidra_edit: ['write', 'Updating the Ghidra project', 'Updated the Ghidra project', input => input.operation],
  analysis_select: ['read', 'Choosing the app to analyse', 'Chose the app to analyse', input => input.path],
  analysis_status: ['read', 'Checking the selected app', 'Checked the selected app'],
  analysis_run: ['read', 'Inspecting app files', 'Inspected app files', input => input.operation],
  analysis_report: ['read', 'Reading analysis evidence', 'Read analysis evidence'],
  analysis_read: ['read', 'Reading selected app code', 'Read selected app code', input => input.path],
  analysis_search: ['search', 'Searching selected app code', 'Searched selected app code', input => input.query],
  model_available: ['agent', 'Checking available helpers', 'Checked available helpers'],
  github_search: ['search', 'Searching GitHub', 'Searched GitHub', input => input.query],
  github_repo: ['read', 'Reading a GitHub repository', 'Read a GitHub repository', input => [input.repo, input.path].filter(Boolean).join('/')],
  github_issues: ['read', 'Reading GitHub issues', 'Read GitHub issues', input => input.repo + (input.number ? '#' + input.number : '')],
  extension_add: ['app', 'Adding an extension', 'Added an extension', input => input.name],
  github_write: ['app', 'Changing something on GitHub', 'Changed something on GitHub', input => input.repo + (input.number ? '#' + input.number : '')],
  conversation_find: ['search', 'Searching chat memory', 'Searched chat memory', input => input.query],
  conversation_zoom: ['memory', 'Reading a summary’s source', 'Read a summary’s source', input => `${input.id}+${input.count || 1}`],
  conversation_date: ['memory', 'Checking when a message was written', 'Checked when a message was written', input => `${input.id}+${input.count || 1}`],
  model_consult: ['agent', 'Asking another AI for help', 'Received another AI’s contribution', input => input.provider],
  memory_note: ['memory', 'Saving a memory', 'Saved a memory', input => input.text],
  memory_recall: ['memory', 'Searching memory', 'Searched memory', input => input.query],
  memory_wake: ['memory', 'Loading saved context', 'Loaded saved context'],
  memory_nap: ['memory', 'Summarising older memories', 'Summarised older memories'],
  memory_zoom: ['memory', 'Opening a memory summary', 'Opened a memory summary'],
  memory_forget: ['memory', 'Removing a memory', 'Removed a memory'],
  archive_search: ['search', 'Searching your imported history', 'Searched your imported history', input => input.query],
  archive_read: ['read', 'Reading an imported conversation', 'Read an imported conversation'],
  conversation_search: ['search', 'Searching earlier chats', 'Searched earlier chats', input => input.query],
  conversation_read: ['read', 'Reading an earlier chat', 'Read an earlier chat'],
  conversation_set_title: ['app', 'Naming this chat', 'Named this chat', input => input.title],
  followup_update: ['app', 'Updating follow-up progress', 'Updated follow-up progress'],
  notes_list: ['read', 'Listing approved notes', 'Listed approved notes'],
  notes_read: ['read', 'Reading an approved note', 'Read an approved note'],
  notes_remove_completed: ['write', 'Removing completed note items', 'Removed completed note items'],
  notes_annotate: ['write', 'Annotating a note', 'Annotated a note', input=>input.id],
  notes_overview_cleanup: ['write', 'Cleaning overview and source notes', 'Cleaned overview and source notes'],
  browser_open: ['browser', 'Opening a page in the browser', 'Opened a page in the browser', input => input.url],
  browser_click: ['browser', 'Clicking in the browser', 'Clicked in the browser', input => input.text || input.selector],
  browser_type: ['browser', 'Typing in the browser', 'Typed in the browser'],
  browser_key: ['browser', 'Pressing a key in the browser', 'Pressed a key in the browser', input => input.key],
  browser_snapshot: ['browser', 'Looking at the browser page', 'Looked at the browser page'],
  browser_inspect: ['browser','Inspecting page source','Inspected page source',input=>input.operation],
  browser_tabs: ['browser', 'Listing browser tabs', 'Listed browser tabs'],
  browser_tab_new: ['browser', 'Opening a browser tab', 'Opened a browser tab', input => input.url],
  browser_tab_select: ['browser', 'Switching browser tab', 'Switched browser tab'],
  browser_tab_close: ['browser', 'Closing a browser tab', 'Closed a browser tab'],
  desktop_screenshot: ['desktop', 'Taking a screenshot', 'Took a screenshot'],
  desktop_click: ['desktop', 'Clicking on your screen', 'Clicked on your screen'],
  desktop_type: ['desktop', 'Typing on your computer', 'Typed on your computer'],
  desktop_key: ['desktop', 'Pressing a key on your computer', 'Pressed a key on your computer', input => input.key],
  workspace_list: ['read', 'Listing project files', 'Listed project files', input => input.path],
  workspace_read: ['read', 'Reading a file', 'Read a file', input => fileName(input.path)],
  workspace_write: ['write', 'Writing a file', 'Wrote a file', input => fileName(input.path)],
  workspace_shell: ['execute', 'Running a command', 'Ran a command', input => input.command],
  image_generate: ['image', 'Creating an image', 'Created an image', input => input.prompt],
  image_read: ['image', 'Looking at an image', 'Looked at an image'],
  personalization_update: ['app', 'Adjusting how it responds', 'Adjusted how it responds', input => input.instruction || input.tone],
  soul_reflect: ['app', 'Reflecting on how to meet you', 'Reflected on how to meet you', input => input.text || input.id],
  app_update_status: ['app', 'Checking for an Exomina update', 'Checked for an Exomina update'],
  app_restart_to_update: ['app', 'Asking to restart Exomina', 'Asked to restart Exomina'],
  app_update_prepare: ['app','Preparing a customized update','Prepared a customized update'],
  app_update_resolve: ['app','Recording a reviewed conflict','Recorded a reviewed conflict',input=>input.path],
  app_update_verify: ['app','Checking the merged update','Checked the merged update'],
};
const CLAUDE = {
  Bash: ['execute', 'Running a command', 'Ran a command', input => input.command],
  PowerShell: ['execute', 'Running a command', 'Ran a command', input => input.command],
  BashOutput: ['execute', 'Checking command output', 'Checked command output'],
  KillShell: ['execute', 'Stopping a command', 'Stopped a command'], KillBash: ['execute', 'Stopping a command', 'Stopped a command'],
  Read: ['read', 'Reading a file', 'Read a file', input => fileName(input.file_path)],
  NotebookRead: ['read', 'Reading a notebook', 'Read a notebook', input => fileName(input.notebook_path)],
  Write: ['write', 'Creating a file', 'Created a file', input => fileName(input.file_path)],
  Edit: ['write', 'Editing a file', 'Edited a file', input => fileName(input.file_path)],
  MultiEdit: ['write', 'Editing a file', 'Edited a file', input => fileName(input.file_path)],
  NotebookEdit: ['write', 'Editing a notebook', 'Edited a notebook', input => fileName(input.notebook_path)],
  Glob: ['search', 'Finding files', 'Found files', input => input.pattern],
  Grep: ['search', 'Searching inside files', 'Searched inside files', input => input.pattern],
  LS: ['read', 'Listing a folder', 'Listed a folder', input => input.path],
  WebFetch: ['web', 'Reading a web page', 'Read a web page', input => input.url],
  WebSearch: ['web', 'Searching the web', 'Searched the web', input => input.query],
  Task: ['agent', 'Handing a task to a helper agent', 'A helper agent worked on a task', input => input.description],
  Agent: ['agent', 'Handing a task to a helper agent', 'A helper agent worked on a task', input => input.description],
  TodoWrite: ['app', 'Updating its to-do list', 'Updated its to-do list'],
  ToolSearch: ['app', 'Looking up a tool', 'Looked up a tool'],
  Skill: ['app', 'Using a skill', 'Used a skill', input => input.skill || input.name],
  ExitPlanMode: ['app', 'Presenting a plan', 'Presented a plan'],
};
const CODEX = {
  codexApprovalReview: ['app', 'Reviewing an action', 'Reviewed an action'],
  codexGuardianWarning: ['app', 'Reading a provider warning', 'Read a provider warning'],
  commandExecution: ['execute', 'Running a command', 'Ran a command', input => command(input.command)],
  fileChange: ['write', 'Changing files', 'Changed files', input => (input.changes || []).map(change => fileName(change.path)).filter(Boolean).join(', ')],
  webSearch: ['web', 'Searching the web', 'Searched the web', input => input.query],
  imageView: ['image', 'Looking at an image', 'Looked at an image', input => fileName(input.path)],
  imageGeneration: ['image', 'Creating an image', 'Created an image'],
  contextCompaction: ['app', 'Condensing the conversation so far', 'Condensed the conversation so far'],
  todoList: ['app', 'Updating its plan', 'Updated its plan'], plan: ['app', 'Updating its plan', 'Updated its plan'],
  collabAgentToolCall: ['agent', 'Working with a helper agent', 'Worked with a helper agent'],
  subAgentActivity: ['agent', 'Working with a helper agent', 'Helper activity'],
};

const ALIAS = { command: 'commandExecution', shell: 'commandExecution', execute: 'commandExecution', edit: 'fileChange', write: 'fileChange', delete: 'fileChange', move: 'fileChange', read: 'Read', search: 'Grep', fetch: 'WebFetch', url: 'WebFetch', network: 'WebFetch' };
const humanize = name => short(String(name || 'a tool').replace(/^mcp__[^_]+__/, '').replace(/^external_([a-z0-9-]+)_/i, '$1 ').replace(/_[0-9a-f]{6,}$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), 60);

/** @returns {{kind:string, active:string, done:string, target:string}} */
export function describeTool(name, input = {}) {
  const raw = String(name || '');
  const args = input && typeof input === 'object' ? input : {};
  // Permission actions are named provider.kind (codex.command, gemini.execute, copilot.shell).
  const bare = raw.replace(/^mcp__exomina__/, '').replace(/^[a-z]+\.(?=\w)/, '');
  const entry = HOST[bare] || CLAUDE[bare] || CODEX[bare] || CODEX[ALIAS[bare]] || CLAUDE[ALIAS[bare]];
  if (entry) { const [kind, active, done, target] = entry; return { kind, active, done, target: short(target ? target(args) : '') }; }
  if (/^external_cua_|^mcp__cua/i.test(bare)) return { kind: 'desktop', active: `Using computer control (${humanize(bare.replace(/^external_cua_/i, ''))})`, done: `Used computer control (${humanize(bare.replace(/^external_cua_/i, ''))})`, target: '' };
  if (bare.startsWith('mcpToolCall') || args.server) return { kind: 'tool', active: `Using ${humanize(args.tool || bare)}`, done: `Used ${humanize(args.tool || bare)}`, target: short(args.server || '') };
  if (bare === 'dynamicToolCall') return describeTool(args.tool, args.arguments || {});
  return { kind: 'tool', active: `Using ${humanize(bare)}`, done: `Used ${humanize(bare)}`, target: short(first(args, 'command', 'path', 'file_path', 'url', 'query', 'pattern')) };
}

const WHY = {
  read: { headline: 'read files', why: 'It will only look at these files, not change them.', risk: 'low' },
  write: { headline: 'change files', why: 'Files will be created or changed. Exomina backs up files it overwrites with its own file tool, but changes made by the AI’s own tools are not automatically undone.', risk: 'medium' },
  execute: { headline: 'run a command on your computer', why: 'Commands run with your Windows account’s rights. They can change or delete files, install software or reach the internet. Allow it if it matches what you asked for.', risk: 'high' },
  network: { headline: 'connect to the internet', why: 'It will fetch or send data to the address below. Avoid this if your files or chat contain something private.', risk: 'medium' },
  browser: { headline: 'use the browser', why: 'It acts in the embedded browser you can see, including on websites where you are signed in.', risk: 'medium' },
  desktop: { headline: 'see or control your computer', why: 'It can look at your screen and use the mouse and keyboard like you would. Watch what it does, and stop it if anything looks wrong.', risk: 'high' },
  external: { headline: 'use an add-on tool', why: 'This tool comes from an add-on (MCP server) you connected. Exomina cannot see what the add-on does internally.', risk: 'medium' },
  image: { headline: 'create an image', why: 'This uses the image allowance of your ChatGPT subscription.', risk: 'low' },
  elevate: { headline: 'get extra access', why: 'It wants more access than this chat’s permission level allows, for example outside the project folder.', risk: 'high' },
  memory: { headline: 'remember something', why: 'This note is kept across chats and shared with your AIs as background. You can delete it later under Memory.', risk: 'low' },
  restart: { headline: 'restart Exomina to install an update', why: 'Exomina closes after this reply and reopens on the new version. Windows will ask once for administrator approval.', risk: 'medium' },
  other: { headline: 'use a tool', why: 'Check the details below if you are unsure what it does.', risk: 'medium' },
};
const RISK_LABEL = { low: 'Low impact', medium: 'Check first', high: 'Can change your computer' };

/** Plain-language summary for an approval card. `reason` is the agent's own
 * explanation when it gave one (Claude's Bash `description`, Codex's reason). */
export function explainAction({ kind = 'other', tool = '', target = '', input = {}, agent = 'The AI', reason = '' } = {}) {
  const base = tool==='notes_remove_completed'?{headline:'remove completed items from your note',why:'Only the quoted passages below will be removed. The last cleanup is kept in Notes so you can undo it or copy passages back after further edits.',risk:'medium'}:tool==='model_consult'?{headline:'ask another AI for help',why:'The selected AI receives the task and context shown below and uses its subscription or your local hardware. Its contribution stays in this chat.',risk:'low'}:WHY[kind] || WHY.other;
  const described = describeTool(tool, input);
  return {
    headline: `${agent} wants to ${base.headline}`,
    // The specific step ("Editing a file"), when Exomina recognises the tool.
    action: described.kind !== 'tool' ? described.active : '',
    target: short(target || described.target, 400),
    why: base.why,
    reason: short(reason || (typeof input?.description === 'string' ? input.description : ''), 400),
    risk: base.risk,
    riskLabel: RISK_LABEL[base.risk],
  };
}

/** "1m 05s", "12s", "0.4s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Totals for the timeline header. */
export function activitySummary(message) {
  const steps=Array.isArray(message?.activity)?message.activity:[];
  const span=step=>Date.parse(step.endedAt||'')-Date.parse(step.startedAt||'');
  const thinkingMs=steps.filter(step=>step.kind==='thinking').reduce((sum,step)=>sum+(Number.isFinite(span(step))?span(step):0),0);
  const total=Date.parse(message?.finishedAt||'')-Date.parse(message?.startedAt||'');
  return {steps:steps.length,tools:steps.filter(step=>step.kind==='tool').length,thinkingMs,totalMs:Number.isFinite(total)?total:null};
}
