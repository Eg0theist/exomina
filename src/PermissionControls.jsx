import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Eye, FilePen, Globe2, KeyRound, LoaderCircle, Monitor, Plus, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Sparkles, Terminal, Trash2, Wifi, X, Blocks, Brain } from 'lucide-react';
import useDismiss from './useDismiss.js';
import SelectableText from './SelectableText.jsx';
import { useStandardView } from './InterfaceView.jsx';

// Standard view describes each level by what the person will notice.
const PLAIN = {
  'read-only': 'The AI can look things up and read files, but cannot change anything.',
  ask: 'The AI asks you before it changes a file, runs something or acts on a website or your screen.',
  'auto-edit': 'The AI may edit files in your folder without asking. Everything else still asks first.',
  full: 'The AI acts without asking, with the same rights as your Windows account. Only for work you fully trust.',
};

export const FALLBACK_MODES = [
  { id: 'read-only', label: 'Read only', short: 'Read only', description: 'Agents can read and research. Edits, commands, browser and desktop actions are blocked without asking.' },
  { id: 'ask', label: 'Ask before acting', short: 'Ask', description: 'Reads in your workspace run freely. Every edit, command, browser or desktop action asks first.' },
  { id: 'auto-edit', label: 'Auto-accept edits', short: 'Auto-edit', description: 'File edits in your workspace are applied without asking. Commands, network, browser and desktop actions still ask.' },
  { id: 'full', label: 'Full access', short: 'Full access', description: 'Actions run with your account permissions, without routine prompts. Codex still asks for actions that require native confirmation. Deny rules still apply.' },
];
const LEVEL_ICON = { 'read-only': Eye, ask: ShieldCheck, 'auto-edit': FilePen, full: ShieldAlert };
const KIND = {
  read: { icon: Eye, label: 'Read' }, write: { icon: FilePen, label: 'File change' }, execute: { icon: Terminal, label: 'Command' },
  network: { icon: Wifi, label: 'Network' }, browser: { icon: Globe2, label: 'Browser' }, desktop: { icon: Monitor, label: 'Computer use' },
  external: { icon: Blocks, label: 'External tool' }, image: { icon: Sparkles, label: 'Image generation' }, elevate: { icon: KeyRound, label: 'Extra access' },
  memory: { icon: Brain, label: 'Memory' }, restart: { icon: RefreshCw, label: 'Restart & update' }, other: { icon: ShieldCheck, label: 'Tool' },
};
export const modeInfo = (modes, id) => (modes?.length ? modes : FALLBACK_MODES).find(item => item.id === id) || FALLBACK_MODES[1];

/** Composer chip: sets this chat's own level, or lets it follow the global
 * default. It never changes the default; only Settings does. Full access needs a second click.
 */
export function PermissionPicker({ modes, own = null, defaultMode, onChange, disabled = false, running = false, onManage }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const area = useRef(null);
  const close = useCallback(() => { setOpen(false); setConfirming(false); }, []);
  useDismiss(area, open, close);
  const list = modes?.length ? modes : FALLBACK_MODES;
  const fallback = modeInfo(list, defaultMode);
  const standard = useStandardView();
  const current = own ? modeInfo(list, own) : fallback;
  const Icon = LEVEL_ICON[current.id] || ShieldCheck;
  const FallbackIcon = LEVEL_ICON[fallback.id] || ShieldCheck;
  function choose(id) {
    if (id === 'full' && current.id !== 'full' && !confirming) { setConfirming(true); return; }
    if (id !== own) onChange(id);
    close();
  }
  return <div className="permission-picker" ref={area}>
    <button type="button" className={`composer-chip level-${current.id} ${own ? 'is-own' : ''}`} aria-label={`Permissions: ${current.label}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => (open ? close() : setOpen(true))} title={own ? `This chat: ${current.label} (default is ${fallback.label})` : `This chat follows the default: ${current.label}`}>
      <Icon size={14} /><span>{current.short || current.label}</span><ChevronDown size={12} className="chip-caret" />
    </button>
    {open && <div className="popover permission-popover" role="dialog" aria-label="Permission level for this chat">
      <div className="popover-label">THIS CHAT</div>
      {!confirming && <>
        <button type="button" className={`level-option level-default ${!own ? 'selected' : ''}`} onClick={() => choose(null)} aria-pressed={!own}>
          <span className="level-icon"><FallbackIcon size={15} /></span><span className="level-text"><strong>Follow default · {fallback.short || fallback.label}</strong><small>Uses the level from Settings and changes with it.</small></span>{!own && <Check size={14} className="level-check" />}
        </button>
        <div className="popover-divider" role="separator" />
        {list.map(item => { const ItemIcon = LEVEL_ICON[item.id] || ShieldCheck; return <button type="button" key={item.id} className={`level-option level-${item.id} ${own === item.id ? 'selected' : ''}`} onClick={() => choose(item.id)} aria-pressed={own === item.id}>
          <span className="level-icon"><ItemIcon size={15} /></span><span className="level-text"><strong>{item.label}</strong><small>{standard ? PLAIN[item.id] || item.description : item.description}</small></span>{own === item.id && <Check size={14} className="level-check" />}
        </button>; })}
        {running && <p className="popover-hint">Exomina’s own prompts switch now; ChatGPT’s sandbox and Claude’s plan mode switch with your next message.</p>}
      </>}
      {confirming && <div className="level-confirm standalone" role="alert"><AlertTriangle size={15} /><div><strong>Enable full access in this chat?</strong><p>Agents in this chat can run commands, change files anywhere your account can, browse and control the desktop without routine prompts. Codex can still require your confirmation. Other chats keep their level. Deny rules still apply.</p><div><button type="button" className="secondary-button small" onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="danger-button small" onClick={() => { onChange('full'); close(); }}>Enable for this chat</button></div></div></div>}
      {onManage && <button type="button" className="menu-footer" onClick={() => { close(); onManage(); }}>Default level and rules…</button>}
    </div>}
  </div>;
}

/** Docked above the composer while a run waits for a decision. */
export function ApprovalCard({ approval, onRespond, busy = false, chatTitle, onOpenChat, count = 1 }) {
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(approval.suggestion?.match || '');
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const allowRef = useRef(null);
  useEffect(() => { setPattern(approval.suggestion?.match || ''); setEditing(false); setDenying(false); setReason(''); allowRef.current?.focus(); }, [approval.id]);
  const kind = KIND[approval.kind] || KIND.other;
  const KindIcon = kind.icon;
  const rule = approval.suggestion ? { tool: approval.suggestion.tool, match: pattern.trim() } : undefined;
  const ruleLabel = approval.suggestion ? (pattern.trim() ? `${pattern.trim()}` : approval.suggestion.label || approval.suggestion.tool) : '';
  const respond = (decision, extra = {}) => onRespond({ decision, ...(decision === 'chat' || decision === 'always' ? { rule } : {}), ...extra });
  return <section className={`approval-card kind-${approval.kind || 'other'}`} role="alertdialog" aria-labelledby={`approval-${approval.id}`} onKeyDown={event => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    if (event.key === 'Escape') { event.preventDefault(); respond('deny'); }
  }}>
    <header><span className="approval-kind"><KindIcon size={15} />{kind.label}</span>{chatTitle && onOpenChat ? <button type="button" className="approval-chat" onClick={onOpenChat}>in “{chatTitle}”</button> : null}{count > 1 && <span className="approval-count">+{count - 1} more waiting</span>}</header>
    {approval.requireConfirmation && <p className="approval-reason">{approval.confirmationSource==='terminal'?'Confirm the command you entered. This approval applies once.':'Codex requires your confirmation for this action, even with Full access.'}</p>}
    {approval.explain ? <>
      {/* Plain language first; the exact request stays one click away. */}
      <h2 id={`approval-${approval.id}`}>{approval.explain.headline}</h2>
      {(approval.explain.action || approval.explain.target) && <div className="approval-what">{approval.explain.action && <span>{approval.explain.action}</span>}{approval.explain.target && <code className="approval-target">{approval.explain.target}</code>}</div>}
      {approval.explain.reason && <p className="approval-reason"><strong>Its reason:</strong> {approval.explain.reason}</p>}
      <p className={`approval-why risk-${approval.explain.risk}`}><span className="approval-risk">{approval.explain.riskLabel}</span>{approval.explain.why}</p>
      <details className="approval-details"><summary>Technical details</summary><SelectableText>{typeof approval.detail === 'string' ? approval.detail : JSON.stringify(approval.detail, null, 2)}</SelectableText></details>
    </> : <>
      <h2 id={`approval-${approval.id}`}>{approval.title || 'Allow this action?'}</h2>
      {approval.target && approval.kind !== 'read' && <code className="approval-target">{approval.target}</code>}
      <details className="approval-details" open={!approval.target || approval.kind === 'read'}><summary>Full request</summary><SelectableText>{typeof approval.detail === 'string' ? approval.detail : JSON.stringify(approval.detail, null, 2)}</SelectableText></details>
    </>}
    {denying ? <form className="approval-deny" onSubmit={event => { event.preventDefault(); respond('deny', reason.trim() ? { message: reason.trim() } : {}); }}>
      <input autoFocus value={reason} maxLength={2000} placeholder="Optional: tell the agent what to do instead" onChange={event => setReason(event.target.value)} aria-label="Reason for denying" />
      <button type="button" className="secondary-button" onClick={() => setDenying(false)}>Back</button><button className="danger-button" disabled={busy}>Deny</button>
    </form> : <div className="approval-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => respond('deny')} title="Esc">Deny</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => setDenying(true)}>Deny with note…</button>
      <span className="approval-spacer" />
      {approval.allowSession && <button type="button" className="secondary-button" disabled={busy} onClick={() => respond('chat')} title="Let Codex remember this approval for its current session">Allow for this session</button>}
      {approval.suggestion && <button type="button" className="secondary-button" disabled={busy} onClick={() => respond('chat')} title={`Allow ${ruleLabel} until Exomina restarts, in this chat only`}>Allow for this chat</button>}
      {approval.suggestion && <button type="button" className="secondary-button" disabled={busy} onClick={() => (editing ? respond('always') : setEditing(true))}>{editing ? 'Save rule & allow' : 'Always allow…'}</button>}
      <button type="button" ref={allowRef} className="primary-button" disabled={busy} onClick={() => respond('once')}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Allow once</button>
    </div>}
    {editing && approval.suggestion && !denying && <div className="approval-rule"><label htmlFor={`rule-${approval.id}`}>Always allow <code>{approval.suggestion.tool}</code> when the target starts with</label><input id={`rule-${approval.id}`} value={pattern} onChange={event => setPattern(event.target.value)} placeholder="Leave empty to allow every use of this tool" spellCheck={false} /><small>Use * as a wildcard. Rules are listed under Settings → Permissions.</small></div>}
  </section>;
}

const RULE_PRESETS = [
  { label: 'Exomina terminal', tool: 'workspace_shell' }, { label: 'Exomina file writes', tool: 'workspace_write' },
  { label: 'Claude shell', tool: 'claude.Bash' }, { label: 'Claude edits', tool: 'claude.Edit' }, { label: 'Claude web', tool: 'claude.WebFetch' },
  { label: 'ChatGPT commands', tool: 'codex.command' }, { label: 'ChatGPT file changes', tool: 'codex.edit' }, { label: 'ChatGPT network', tool: 'codex.network' },
  { label: 'Browser actions', tool: 'browser_*' }, { label: 'Desktop actions', tool: 'desktop_*' }, { label: 'Any tool', tool: '*' },
];

export function PermissionSettings({ modes, mode, rules = [], onMode, onRules, busy = false, ownCount = 0, onResetChats }) {
  const standard = useStandardView();
  const list = modes?.length ? modes : FALLBACK_MODES;
  const [draft, setDraft] = useState({ effect: 'deny', tool: 'workspace_shell', match: '' });
  const [error, setError] = useState('');
  const [confirmFull, setConfirmFull] = useState(false);
  async function add(event) {
    event.preventDefault(); setError('');
    if (!draft.tool.trim()) { setError('Choose which tool the rule applies to.'); return; }
    if (draft.effect === 'allow' && draft.tool.trim() === '*' && !draft.match.trim()) { setError('Use the Full access level instead of an allow-everything rule.'); return; }
    try { await onRules([...rules, { effect: draft.effect, tool: draft.tool.trim(), match: draft.match.trim() }]); setDraft(previous => ({ ...previous, match: '' })); }
    catch (failure) { setError(failure.message || String(failure)); }
  }
  return <section className="settings-section" id="settings-permissions">
    <div className="section-title"><h2>Permissions</h2><span>Default level for every chat and AI</span></div>
    <div className="chat-levels-note"><ShieldCheck size={14} /><p>Each chat can set its own level from the shield in the message box. That only affects the chat, never this default.{ownCount > 0 && <> <strong>{ownCount} {ownCount === 1 ? 'chat uses' : 'chats use'} its own level.</strong></>}</p>{ownCount > 0 && onResetChats && <button type="button" className="secondary-button small" disabled={busy} onClick={onResetChats}>Make all follow the default</button>}</div>
    <div className="level-grid" role="radiogroup" aria-label="Permission level">{list.map(item => { const Icon = LEVEL_ICON[item.id] || ShieldCheck; return <button type="button" role="radio" aria-checked={mode === item.id} key={item.id} disabled={busy} className={`level-card level-${item.id} ${mode === item.id ? 'selected' : ''}`} onClick={() => { if (item.id === 'full' && mode !== 'full') setConfirmFull(true); else onMode(item.id); }}>
      <span className="level-card-top"><span className="level-icon"><Icon size={16} /></span>{mode === item.id && <span className="tag mint">Default</span>}</span><strong>{item.label}</strong><small>{standard ? PLAIN[item.id] || item.description : item.description}</small>
    </button>; })}</div>
    {confirmFull && <div className="level-confirm inline" role="alert"><AlertTriangle size={16} /><div><strong>Make full access the default?</strong><p>In every chat without its own level, agents can run commands, edit files anywhere your Windows account can, browse and use the desktop without routine prompts. ChatGPT runs without its sandbox and can still require your confirmation for an action. Deny rules below still apply to Exomina’s tools and runtimes that ask.</p><div><button type="button" className="secondary-button small" onClick={() => setConfirmFull(false)}>Cancel</button><button type="button" className="danger-button small" onClick={() => { onMode('full'); setConfirmFull(false); }}>Enable full access</button></div></div></div>}
    <div className="level-notes advanced-only"><p><ShieldOff size={13} />ChatGPT follows the level with its native sandbox: Read only is a read-only sandbox, Ask and Auto-edit keep writes inside your workspace (Auto-edit lets it run sandboxed commands without asking), Full access removes the sandbox. Codex can still require confirmation for actions this level permits.</p><p><ShieldCheck size={13} />Claude, Kimi, Copilot and API models send each action to Exomina, so rules and per-chat permissions apply to them directly. Antigravity uses Exomina’s shared tools and permission controls; its native file, URL and command actions are disabled.</p></div>
    <div className="rules-heading advanced-only"><h3>Rules</h3><span>Deny rules always win. Allow rules skip Exomina’s routine prompts. Codex-required confirmations still ask.</span></div>
    {rules.length ? <ul className="rule-list advanced-only">{rules.map(rule => <li key={rule.id}><span className={`rule-effect ${rule.effect}`}>{rule.effect === 'deny' ? 'Deny' : 'Allow'}</span><code>{rule.tool}</code><span className="rule-match">{rule.match ? <>starting with <code>{rule.match}</code></> : 'every use'}</span><button type="button" className="icon-button" aria-label={`Remove rule ${rule.effect} ${rule.tool} ${rule.match}`} disabled={busy} onClick={() => onRules(rules.filter(item => item.id !== rule.id)).catch(failure => setError(failure.message))}><Trash2 size={14} /></button></li>)}</ul> : <p className="rules-empty advanced-only">No rules yet. Choose “Always allow…” in an approval, or add one here.</p>}
    <form className="rule-form advanced-only" onSubmit={add}>
      <select aria-label="Rule effect" value={draft.effect} onChange={event => setDraft({ ...draft, effect: event.target.value })}><option value="deny">Deny</option><option value="allow">Allow</option></select>
      <input aria-label="Tool" list="permission-tools" value={draft.tool} onChange={event => setDraft({ ...draft, tool: event.target.value })} placeholder="Tool, e.g. claude.Bash" spellCheck={false} />
      <datalist id="permission-tools">{RULE_PRESETS.map(item => <option key={item.tool} value={item.tool}>{item.label}</option>)}</datalist>
      <input aria-label="Target starts with" value={draft.match} onChange={event => setDraft({ ...draft, match: event.target.value })} placeholder="Starts with… (optional, * wildcard)" spellCheck={false} />
      <button className="secondary-button" disabled={busy}><Plus size={14} />Add rule</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}<button type="button" aria-label="Dismiss" onClick={() => setError('')}><X size={12} /></button></p>}
  </section>;
}
