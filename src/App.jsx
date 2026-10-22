import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MemoryCaptureControl from './MemoryCaptureControl.jsx';
import ChatMemorySettings from './ChatMemorySettings.jsx';
import MemoryNotes from './MemoryNotes.jsx';
import MemoryContextDialog from './MemoryContextDialog.jsx';
import SelectableText from './SelectableText.jsx';
import MessageImages from './MessageImages.jsx';
import FollowupReplies from './FollowupReplies.jsx';
import HudQuestions from './HudQuestions.jsx';
import { QuestionDraftContext, needsQuestionAnswer } from './QuestionCards.jsx';
import { questionFlowMessage } from './question-flow.js';
import { questionAnswerDisplayMessages } from '../desktop/question-answer-display.mjs';
import QuestionPopup from './QuestionPopup.jsx';
import ConnectorForm from './ConnectorForm.jsx';
import { AttachmentDraft, MessageFiles, fileBase64 } from './ChatAttachments.jsx';
import { mediaAttachment, mergeChatAsset } from './image-assets.js';
import { createDraftStore, updateDraft, restoreDraft, moveDraft } from './chat-drafts.js';
import {quotePaste} from './quote-paste.js';
import { createPortal } from 'react-dom';
import BrandMark from './BrandMark.jsx';
import WindowHeader, { hasWindowHeader } from './WindowHeader.jsx';
import ProviderConnections, { DEFAULT_PROVIDERS, ProviderMark, providerReady, providerModeLabel } from './ProviderConnections.jsx';
import BrowserConnection from './BrowserConnection.jsx';
import AppAnalysis from './AppAnalysis.jsx';
import SidebarNav from './SidebarNav.jsx';
import WorkspaceMap from './WorkspaceMap.jsx';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Blocks, Brain, Check, ChevronDown, ChevronRight, CircleHelp, Eye, ShieldAlert, Download, ExternalLink, FileCode2, Folder, FolderOpen, Globe2, HardDrive, KeyRound, Layers3, ListPlus, LoaderCircle, LockKeyhole, Menu, MessageSquare, Monitor, Moon, Orbit, Paperclip, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, StickyNote, Sun, Terminal, Trash2, Unplug, X, Zap } from 'lucide-react';

import { api, isDesktop, signOut } from './transport.js';
import CloudSettings, { syncLabel } from './CloudSettings.jsx';
import RemoteSettings from './RemoteSettings.jsx';
import HostedTools from './HostedTools.jsx';
import ModelPicker from './ModelPicker.jsx';
import ModelSettings from './ModelSettings.jsx';
import { normalizeModelPreferences, providerVisible, preferredModel, modelVisible } from '../desktop/model-preferences.mjs';
import DataExport from './DataExport.jsx';
import PairedDevices from './PairedDevices.jsx';
import ChatSidebar from './ChatSidebar.jsx';
import Scratchpad from './Scratchpad.jsx';
import Workbench, {PromptSuggestions} from './Workbench.jsx';
import Tutorials, {TUTORIALS,TutorialGuide} from './Tutorials.jsx';
import GithubConnection from './GithubConnection.jsx';
import ChatFind from './ChatFind.jsx';
import { findTextMatches } from './chat-search.js';
import {conversationSummary} from '../desktop/library-view.mjs';
import { officialLoginUrl } from '../desktop/provider-auth.mjs';
import RecoveryAudit from './RecoveryAudit.jsx';
import LocalStorageSettings from './LocalStorageSettings.jsx';
import Markdown, { CopyButton } from './Markdown.jsx';
import ReplyExport from './ReplyExport.jsx';
import AssistantText from './AssistantText.jsx';
import ComposerDraft, { DraftPresence } from './ComposerDraft.jsx';
import useMessageWindow from './useMessageWindow.js';
import { stripNextPrompt } from '../desktop/next-prompt.mjs';
import { PROVIDER_PRIVACY, temporarySupported } from '../desktop/privacy.mjs';
import './privacy.css';
import './chat-memory-delete.css';
import './import-chats.css';
import { ApprovalCard, PermissionPicker, PermissionSettings, modeInfo } from './PermissionControls.jsx';
import AppearanceSettings from './AppearanceSettings.jsx';
import MatrixRain from './MatrixRain.jsx';
import { applyAppearance, watchArtworkFrame } from './appearance.js';
import useChatScroll from './useChatScroll.js';
import BrowserTabs from './BrowserTabs.jsx';
import { browserAddressUrl } from '../desktop/browser-address.mjs';
import { createChatEventBuffer } from './chat-event-buffer.js';
import { createCoalescedRefresh } from './coalesced-refresh.js';
import useBrowserResize from './useBrowserResize.js';
import './browser-panel.css';
import HelperContribution from './HelperContribution.jsx';
import {mergeHelperActivity} from '../desktop/helper-activity.mjs';
import { parseChatLink } from '../desktop/chat-links.mjs';
import { THEMES, normalizeAppearance } from '../desktop/themes.mjs';
import SpellcheckSettings from './SpellcheckSettings.jsx';
import UpdateSettings from './UpdateSettings.jsx';
import UpdateButton from './UpdateButton.jsx';
import SoundSettings from './SoundSettings.jsx';
import VoiceControls, { useVoice, VoiceStatus, VoiceSettings } from './VoiceControls.jsx';
import ActivityTimeline from './ActivityTimeline.jsx';
import Welcome, { WelcomeHero } from './Welcome.jsx';
import TaskStart, { TaskActions } from './TaskStart.jsx';
import TaskRefinements from './TaskRefinements.jsx';
import { CHECK_TASK_REQUEST, REPEAT_TASK_REQUEST } from '../desktop/task-guide.mjs';
import { notify } from './sounds.js';
import { UsageBanner, UsageSettings, UsageSidebar } from './Usage.jsx';
import SafetyLimits from './SafetyLimits.jsx';
import Extensions from './Extensions.jsx';
import Recommendations from './Recommendations.jsx';
import { AmbitionBar, FurtherActions } from './Ambition.jsx';
import PersonalizationSettings from './PersonalizationSettings.jsx';
import Companion from './Companion.jsx';
import LibraryBackup from './LibraryBackup.jsx';
import MemoryEvidence from './MemoryEvidence.jsx';
import {mergeChatSnapshot} from './chat-snapshot.js';
import AgentSpending from './AgentSpending.jsx';
import './priorities.css';
import TerminalPanel from './TerminalPanel.jsx';
import WorkflowWorkspace, {useWorkflowWorkspace, WorkflowControls} from './WorkflowWorkspace.jsx';
import ChatStyle from './ChatStyle.jsx';
import MessagingSettings from './MessagingSettings.jsx';
import SettingsLayout, { SettingsPanel } from './SettingsLayout.jsx';
import SkillLibrary from './SkillLibrary.jsx';
import WorkerSettings from './WorkerSettings.jsx';
import LocalAISettings from './LocalAISettings.jsx';
import MarketingSettings from './MarketingSettings.jsx';
import DiskSpace from './DiskSpace.jsx';
import { useHud, useHudChrome, isHudShortcut, HudToggle, HudPulse } from './HudMode.jsx';
import InterfaceView, { useInterfaceView, AdvancedViewHint, InterfaceViewContext, StandardHome, effortTierLabel } from './InterfaceView.jsx';
import useDismiss from './useDismiss.js';
import { effortText, modelText, resolveModel } from './ModelPicker.jsx';
import './memory-review.css';
const hudChromeInvoke = (method, payload) => Promise.resolve(api.invoke(method, payload));
const initialSettings = { workspace: '', provider: 'codex', model: 'auto', memoryEnabled: true, memoryCapture: 'automatic', chatMemoryEnabled: true, chatMemorySummaries: true, desktopEnabled: false, browserEnabled: false };
// Chats live in the list below, Tutorials on the welcome screen.
const navigation = [{ id:'workbench',label:'Projects & prompts',icon:Layers3 }, { id: 'tools', label: 'Tools', icon: Blocks }, {id:'storage',label:'Storage',icon:HardDrive}];
const SIDEBAR_COLLAPSED_KEY = 'exomina.sidebarCollapsed';
const byteCount = text => new TextEncoder().encode(text).length;
const readable = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const displayError = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const questionSessionKey = (chatId, questionId) => JSON.stringify([chatId, questionId]);
const signInCode = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 -]{0,127}$/.test(value.trim()) ? value.trim() : '';
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const folderLabel = path => path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'Choose a project';

function Logo({ small = false }) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><BrandMark /></span>; }
function CloudIcon() { return <Globe2 size={15} />; }
function Spinner({ size = 17 }) { return <LoaderCircle size={size} className="spin" aria-hidden="true" />; }
function Toggle({ checked, onChange, label, disabled = false }) { return <button type="button" role="switch" aria-checked={!!checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>; }
function EmptyState({ icon: Icon = Layers3, title, children, action }) { return <div className="empty-state"><div className="empty-icon"><Icon size={25} strokeWidth={1.4} /></div><h3>{title}</h3><p>{children}</p>{action}</div>; }

function MessageContent({ content, query = '', activeHit, onLink, message, onQuestionAnswer }) {
  const text = message ? stripNextPrompt(content) : String(content || ''), matches = findTextMatches(text, query);
  // Highlights search hits inside a rendered fragment that starts at `start` in the raw message.
  function marked(value, start) {
    if (!matches.length) return value;
    const output = []; let cursor = 0;
    for (const hit of matches) {
      const from = Math.max(0, hit.start - start), to = Math.min(value.length, hit.end - start);
      if (to <= from || from < cursor) continue;
      output.push(value.slice(cursor, from));
      output.push(<mark key={hit.start} className={activeHit?.start === hit.start ? 'chat-match current' : 'chat-match'} data-search-start={hit.start}>{value.slice(from, to)}</mark>);
      cursor = to;
    }
    output.push(value.slice(cursor)); return output;
  }
  return <SelectableText as="div" className="message-content markdown">{message ? <AssistantText text={text} message={message} mark={marked} onLink={onLink} onAnswer={onQuestionAnswer} /> : <Markdown text={text} mark={marked} onLink={onLink} />}</SelectableText>;
}

/** Event handlers use current chat state without invalidating every saved row. */
function useLatestCallback(callback) {
  const latest = useRef(callback); latest.current = callback;
  return useCallback((...args) => latest.current(...args), []);
}

/** Completed messages retain their rendered Markdown while another reply streams. */
const ChatMessage = memo(function ChatMessage(props) {
  const {message, index, streaming, activeHit, eager} = props;
  const row = useMessageWindow({eager, active: streaming || !!activeHit,
    estimate: message.role === 'user' ? 100 : 360});
  if (!row.visible) return <article ref={row.ref} className={`message ${message.role} message-placeholder`} data-message-index={index} aria-hidden="true" style={{height:row.height,boxSizing:'border-box',overflow:'hidden',contain:'strict'}} />;
  return React.cloneElement(renderChatMessage(props), {ref:row.ref});
});

function renderChatMessage({ message, index, defaultProvider, info, catalog, connections, streaming, query, activeHit, onLink, onAsk, onEdit, onBranch, onSpeak, onFollowupCancel, onQuestionAnswer, onQuestionContinue, onFurther, hud = false, temporary = false }) {
  if (message.role === 'user') return <article className="message user" data-message-index={index}><div className="user-bubble"><MessageContent content={message.content} query={query} activeHit={activeHit} onLink={onLink} /><MessageImages attachments={message.attachments} /><MessageFiles attachments={message.attachments} /></div><div className="message-actions"><CopyButton text={String(message.content || '')} label="Copy message" />{!temporary && <button type="button" className="copy-button" onClick={() => onEdit(message, index)}>Edit &amp; branch</button>}{api && !temporary && <AskAnother text={String(message.content || '')} current={message.provider || defaultProvider} catalog={catalog} connections={connections} onAsk={onAsk} />}</div></article>;
  return <article className={`message assistant ${message.error ? 'has-error' : ''} ${streaming ? 'is-streaming' : ''}`} data-message-index={index}><div className="message-meta"><ProviderMark provider={message.provider || defaultProvider} info={info} small /><strong>{info?.name || 'Assistant'}</strong><span>{info?.engine ? `via ${info.engine}` : ''}</span>{message.lane === 'chat' && <span className="lane-tag" title="Answered in chat mode: memory and chat history, without file, code or browser tools">Chat</span>}{message.lane === 'tools' && <span className="lane-tag tools" title={message.escalated ? 'Started in chat mode, then switched to the full tool suite' : 'Answered with file, code and browser tools available'}>Tools</span>}</div><div className="message-body">{message.helpersOmitted > 0 && <p className="helper-history-note">{message.helpersOmitted} earlier helper cards were omitted to keep this task's saved history bounded.</p>}{(message.helpers || []).map(helper => <HelperContribution key={helper.id} helper={helper} live={streaming} onLink={onLink} />)}{!hud && <ActivityTimeline message={questionFlowMessage(message)} streaming={streaming} providerName={info?.name} onLink={onLink} onFollowupCancel={onFollowupCancel} onQuestionAnswer={onQuestionAnswer} onQuestionContinue={onQuestionContinue} />}{hud && <HudQuestions message={message} onAnswer={onQuestionAnswer} onContinue={onQuestionContinue} />}<FollowupReplies items={hud ? message.followups || [] : (message.followups || []).filter(item => !message.activity?.some(step => step.kind === 'followup' && step.followupId === item.id))} onLink={onLink} onCancel={onFollowupCancel} />{message.content ? <MessageContent content={message.content} query={query} activeHit={activeHit} onLink={onLink} message={message} onQuestionAnswer={onQuestionAnswer} /> : null}{message.continuationError && <div className="continuation-error" role="alert"><strong>Could not continue this task</strong><p>{message.continuationError}</p><p>Your completed reply is preserved above. Follow-ups needing attention remain in the work timeline.</p></div>}<MessageImages attachments={message.attachments} /><MessageFiles attachments={message.attachments} />{!streaming && message.content && <div className="message-actions"><CopyButton text={String(message.content)} label="Copy reply" className="labelled" />{isDesktop && !temporary && !message.error && <ReplyExport text={String(message.content)}/>}{isDesktop && !temporary && <button className="copy-button" type="button" onClick={() => onSpeak(message.content)}>Read aloud</button>}{!temporary && <button className="copy-button" type="button" onClick={() => onBranch(message, index)}>Branch from here</button>}</div>}{!streaming && message.content && !message.error && onFurther && <FurtherActions onPick={onFurther} />}</div></article>;
}

// Composer edits must not rebuild the element tree for the whole conversation.
const ChatMessageList = memo(function ChatMessageList({messages, defaultProvider, providers, running, hit, onFurther, ...props}) {
  return messages.map((message, index) => <ChatMessage {...props} key={message.id || index}
    message={message} index={index} defaultProvider={defaultProvider} info={providers[message.provider || defaultProvider]}
    eager={index >= messages.length - 8} streaming={running && index === messages.length - 1}
    activeHit={hit?.messageIndex === index ? hit : null}
    onFurther={!props.temporary && !running && index === messages.length - 1 ? onFurther : undefined} />);
});

/** Computer use in one click: the driver ships with Exomina, and its agent skill
 * is installed into Exomina's own Claude and ChatGPT runtimes. */
/** Compare: put the same question to another connected AI. */
function AskAnother({ text, current, catalog, connections, onAsk }) {
  const [open, setOpen] = useState(false);
  const area = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(area, open, close);
  const ready = catalog.filter(item => item.id !== current && providerReady(connections.find(connection => connection.id === item.id)));
  if (!ready.length || !text.trim()) return null;
  return <span className="ask-another" ref={area}><button type="button" className="copy-button" onClick={() => setOpen(!open)} aria-expanded={open} title="Send this message to another AI in a new chat"><Orbit size={13} />Ask another AI</button>
    {open && <div className="popover ask-another-menu" role="menu">{ready.map(item => <button type="button" role="menuitem" key={item.id} onClick={() => { close(); onAsk(text, item.id); }}><ProviderMark provider={item.id} info={item} small /><span>{item.name}</span></button>)}</div>}
  </span>;
}

function DriverPanel({ settings, status, busyAction, act, refresh, openExternal }) {
  const driver = (status || []).find(item => item.id === 'cua');
  const enabled = settings.externalMcpServers?.some(item => item.id === 'cua' && item.enabled) || false;
  const [setup, setSetup] = useState(null);
  const load = useCallback(() => api?.invoke('computer.status').then(setSetup).catch(() => setSetup(null)), []);
  useEffect(() => { load(); }, [load, driver?.connected]);
  if (setup?.bundled) {
    const ready = driver?.connected && setup.skill?.current;
    return <section className="driver-panel"><div className="driver-panel-heading"><div className="driver-symbol"><Monitor size={22} /><span className="driver-plug"><Unplug size={10} /></span></div><div><span className="eyebrow">COMPUTER USE</span><h2>Let your AI use this computer</h2></div><span className={`tag ${driver?.connected ? 'mint' : ''}`}>{driver?.connected ? `On · ${driver.toolCount || 0} tools` : enabled ? 'On · disconnected' : 'Off'}</span></div>
      <p>Your AI can look at the screen and use the mouse and keyboard to work in other apps. Everything needed is included with Exomina, and you approve each action before it happens.</p>
      <ul className="setup-checklist">
        <li className={setup.usingBundled || driver?.connected ? 'done' : ''}><Check size={13} />Cua Driver, included with Exomina{setup.skill?.bundled ? ` (version ${setup.skill.bundled})` : ''}</li>
        <li className={setup.skill?.current ? 'done' : ''}><Check size={13} />{setup.skill?.current ? 'Computer-use skill installed for Claude and ChatGPT' : setup.skill?.installed ? 'Computer-use skill needs an update' : 'Computer-use skill for Claude and ChatGPT'}</li>
        <li className={driver?.connected ? 'done' : ''}><Check size={13} />Connected to your chats</li>
      </ul>
      {driver?.error && <div className="inline-error" role="alert">{driver.error}</div>}
      <div className="driver-actions">
        {!ready && <button className="primary-button" disabled={!!busyAction} onClick={() => act('computer-setup', async () => { await api.invoke('computer.setup'); await refresh(); await load(); })}>{busyAction === 'computer-setup' ? <Spinner size={14} /> : <Monitor size={14} />}{driver?.connected ? 'Finish setup' : 'Set up computer use'}</button>}
        {enabled && <button className="secondary-button" disabled={!!busyAction} onClick={() => act('driver-disconnect', async () => { await api.invoke('mcp.disconnectDriver'); await refresh(); await load(); })}><Unplug size={14} />Turn off</button>}
        <details className="driver-advanced"><summary>Advanced</summary><p>Use a different Cua Driver executable instead of the included one.</p><div className="driver-path"><FileCode2 size={14} /><span title={settings.cuaDriverPath}>{settings.cuaDriverPath || 'Included driver'}</span><button onClick={() => act('driver-choose', async () => { await api.invoke('mcp.chooseDriver'); await refresh(); await load(); })}>Choose file</button></div><button className="text-button" onClick={() => openExternal('https://cua.ai/docs/cua-driver/quickstart')}>About Cua Driver <ExternalLink size={12} /></button></details>
      </div>
      <p className="setup-note">Once activated, computer use stays on across restarts and updates until you turn it off. Exomina reconnects the driver automatically; each action still uses your approval settings.</p>
    </section>;
  }
  return <section className="driver-panel"><div className="driver-panel-heading"><div className="driver-symbol"><Monitor size={22} /><span className="driver-plug"><Unplug size={10} /></span></div><div><span className="eyebrow">COMPUTER USE</span><h2>Computer use with Cua Driver</h2></div><span className={`tag ${driver?.connected ? 'mint' : ''}`}>{driver?.connected ? `${driver.toolCount || 0} tools connected` : 'Optional MCP connection'}</span></div><p>Choose your installed Cua Driver, then connect it. Its desktop tools are available to your connected providers, with approval required for each action.</p><div className="driver-path"><FileCode2 size={14} /><span title={settings.cuaDriverPath}>{settings.cuaDriverPath || 'No driver selected'}</span><button onClick={() => act('driver-choose', async () => { await api.invoke('mcp.chooseDriver'); await refresh(); })}>Choose file</button></div>{driver?.error && <div className="inline-error" role="alert">{driver.error}</div>}<div className="driver-actions"><button className="text-button" onClick={() => openExternal('https://cua.ai/docs/cua-driver/quickstart')}>Get Cua Driver <ExternalLink size={12} /></button>{driver?.connected ? <button className="secondary-button" disabled={!!busyAction} onClick={() => act('driver-disconnect', async () => { await api.invoke('mcp.disconnectDriver'); await refresh(); })}><Unplug size={14} />Disconnect</button> : <button className="secondary-button" disabled={!settings.cuaDriverPath || !!busyAction} onClick={() => act('driver-connect', async () => { await api.invoke('mcp.connectDriver'); await refresh(); })}>{busyAction === 'driver-connect' ? <Spinner size={14} /> : <Plus size={14} />}Connect driver</button>}</div></section>;
}

function AdvancedMcp({ settings, status, act, refresh, busyAction }) {
  const [config, setConfig] = useState(JSON.stringify(settings.externalMcpServers || [], null, 2));
  const [changed, setChanged] = useState(false);
  const [configError, setConfigError] = useState('');
  useEffect(() => { if (!changed) setConfig(JSON.stringify(settings.externalMcpServers || [], null, 2)); }, [settings.externalMcpServers, changed]);
  async function saveConfig(event) {
    event.preventDefault(); setConfigError('');
    let servers;
    try { servers = JSON.parse(config); if (!Array.isArray(servers)) throw new Error('Use a JSON array of MCP server configurations.'); if (servers.some(server => !server || typeof server.id !== 'string' || typeof server.command !== 'string' || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string'))))) throw new Error('Each server needs an id and executable command, with an optional args array of strings.'); }
    catch (error) { setConfigError(error.message); return; }
    await act('mcp-save', async () => { await api.invoke('settings.save', { externalMcpServers: servers }); setChanged(false); await refresh(); });
  }
  return <details className="advanced-mcp"><summary><Blocks size={15} /><span>Other MCP servers</span><span className="tag">Advanced</span><ChevronDown size={14} /></summary><div className="advanced-mcp-body"><p>Add local MCP servers to make their tools available to your connected providers. Configuration is saved locally. Connecting starts the executable after your approval.</p><form onSubmit={saveConfig}><label className="input-label" htmlFor="mcp-config">Server configurations (JSON)</label><textarea id="mcp-config" value={config} spellCheck={false} rows={7} placeholder={'[{"id":"example","name":"My server","command":"C:\\\\tools\\\\server.exe","args":[],"enabled":true}]'} onChange={event => { setConfig(event.target.value); setChanged(true); }} />{configError && <p className="inline-error" role="alert">{configError}</p>}<div className="mcp-config-actions"><span>Fields: id, name, command, args, enabled</span><button type="submit" className="secondary-button" disabled={!changed || !!busyAction}>{busyAction === 'mcp-save' ? <Spinner size={13} /> : <Check size={13} />}Save</button><button type="button" className="secondary-button" disabled={changed || !!busyAction} onClick={() => act('mcp-refresh', async () => { await api.invoke('mcp.refresh'); await refresh(); })}>{busyAction === 'mcp-refresh' ? <Spinner size={13} /> : <RefreshCw size={13} />}Connect servers</button></div></form>{(status || []).length > 0 && <div className="mcp-status-list">{status.map(server => <div key={server.id}><span className={`inline-status ${server.connected ? 'enabled' : ''}`}><span />{server.id}</span><span>{server.connected ? `${server.toolCount || 0} tools connected` : server.error || 'Disconnected'}</span></div>)}</div>}</div></details>;
}

const PROVIDER_LABELS = { chatgpt: 'ChatGPT', codex: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', exomina: 'Exomina' };
const EXPORT_HELP = [
  ['ChatGPT', 'Settings → Data controls → Export data. The download link arrives by email.', 'https://chatgpt.com/#settings/DataControls'],
  ['Claude', 'Settings → Privacy → Export data. The download link arrives by email.', 'https://claude.ai/settings/data-privacy-controls'],
  ['Gemini', 'Google Takeout → deselect all → choose “My Activity” and keep only “Gemini Apps”.', 'https://takeout.google.com/'],
  ['Grok', 'Your xAI account → Data → download your data.', 'https://accounts.x.ai/'],
];
export function importSummary(result = {}) {
  if (!result.documents) return 'No chats were found in that file. Choose a supported export, or a text or Markdown file from any AI.';
  const noun = result.conversationCount === result.documents ? (result.added === 1 ? 'chat' : 'chats') : (result.added === 1 ? 'item' : 'items');
  return `Imported ${result.added} ${noun} from ${result.source}${result.duplicates ? ` (${result.duplicates} were already here)` : ''}. Your AIs can now look things up in them.`;
}
export function ImportChatsHelp({ onClose, onImport, busy }) {
  return createPortal(<div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="import-help-title"><button className="modal-close icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button><div className="modal-icon"><Download size={23} /></div><h2 id="import-help-title">Bring your chats from other AIs</h2><p>First download your data from the AI you used. Then choose the downloaded file (usually a ZIP) here, and Exomina does the rest. Nothing is sent to an AI while importing.</p><ul className="import-help-list">{EXPORT_HELP.map(([name, steps, url]) => <li key={name}><strong>{name}</strong><span>{steps}</span><a href={url} target="_blank" rel="noopener noreferrer">Open {name}</a></li>)}</ul><p>Use another AI, whether local, open-source or hosted? Save your conversation as a text or Markdown file and import it here. These files become searchable saved context; other export formats need to be supported by Exomina.</p><p className="import-dedupe">Importing the same file twice is safe: chats that are already here are skipped. Your downloaded file is not changed.</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Close</button><button className="primary-button" disabled={busy} onClick={onImport}>{busy ? <Spinner size={15} /> : <FolderOpen size={15} />}Choose downloaded file</button></div></section></div>, document.body);
}

function ArchivePanel({ summary = {}, act, refresh, busyAction, onModalChange, onNotice, canImport = true, isWeb = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const [record, setRecord] = useState(null);
  const [localError, setLocalError] = useState('');
  useEffect(() => { onModalChange(open || !!record); return () => onModalChange(false); }, [open, record, onModalChange]);
  async function archiveAction(name, callback) { setLocalError(''); return act(name, async () => { try { return await callback(); } catch (error) { setLocalError(displayError(error)); throw error; } }); }
  const [lastImport, setLastImport] = useState(null);
  async function importNow() { await archiveAction('archive-import', async () => { const result = await api.invoke('archive.importNow'); if (!result || result.canceled) return; await refresh(); setOpen(false); setFound(null); setLastImport(result); onNotice(importSummary(result)); }); }
  async function search(event) { event.preventDefault(); await archiveAction('archive-search', async () => { const result = await api.invoke('archive.search', { query }); setFound(result); }); }
  async function read(item) { setRecord({ ...item, text: '', loading: true }); await archiveAction('archive-read', async () => { const result = await api.invoke('archive.read', { id: item.id }); setRecord(result); }); }
  return <section className="archive-panel"><div className="archive-panel-heading"><div><div className="eyebrow">IMPORTED CHATS</div><h2>Your chats from other AIs</h2><p>Bring over conversations from ChatGPT, Claude, Gemini, Grok or any other AI so every AI here can look things up in them.</p></div>{canImport && <div className="archive-import-actions"><button className="primary-button" disabled={!!busyAction} onClick={importNow}>{busyAction === 'archive-import' ? <Spinner size={15} /> : <Download size={15} />}Import chats</button><button type="button" className="text-button" onClick={() => { setOpen(true); setLocalError(''); }}>Where do I get my chats?</button></div>}</div>{localError && !open && <p className="inline-error" role="alert">{localError}</p>}{lastImport?.warnings?.length > 0 && <details className="import-warnings"><summary>Details about the last import</summary><ul>{lastImport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}{summary.documents > 0 ? <><div className="archive-stats"><span><strong>{summary.conversationCount || 0}</strong> conversations</span><span><strong>{(summary.memoryCount || 0) + (summary.instructionsCount || 0)}</strong> saved context records</span><span><strong>{summary.projectCount || 0}</strong> projects</span><span><strong>{summary.artifactCount || 0}</strong> artifact records</span></div><form className="archive-search" onSubmit={search}><div className="search-field"><Search size={15} /><input aria-label="Search imported context" placeholder="Search imported conversations and context…" value={query} onChange={event => setQuery(event.target.value)} /></div><button className="secondary-button" type="submit" disabled={busyAction === 'archive-search'}>{busyAction === 'archive-search' ? <Spinner size={14} /> : <Search size={14} />}Search archive</button></form>{found && <div className="archive-results"><div className="archive-result-count">{found.total} {found.total === 1 ? 'record' : 'records'} found{found.total > found.results.length ? ` · showing ${found.results.length}` : ''}</div>{found.results.length ? found.results.map(item => <button className="archive-result" key={item.id} onClick={() => read(item)}><span className="archive-result-top"><span className="tag">{PROVIDER_LABELS[item.provider] || 'Imported'}</span><span>{item.kind}</span>{item.updatedAt && <time>{dateLabel(item.updatedAt)}</time>}</span><strong>{item.title}</strong>{query.trim() && <p>{item.excerpt}</p>}<span className="archive-result-open">Open record <ArrowRight size={12} /></span></button>) : <p className="archive-no-results">No matching records. Try another phrase.</p>}</div>}<p className="archive-privacy"><HardDrive size={12} />{isWeb ? 'Imported context is stored on your private server. Relevant search results can be shared with your selected AI.' : 'Conversations, projects, and artifact text stay in the local archive. Relevant search results can be shared with your selected AI.'}</p></> : <div className="archive-empty"><Layers3 size={21} strokeWidth={1.5} /><p>{canImport ? 'No chats imported yet. Click Import chats and choose the file you downloaded from your AI.' : 'No imported context is available on this server yet. Import exports from the desktop app.'}</p></div>}
    {open && <ImportChatsHelp busy={!!busyAction} onClose={() => setOpen(false)} onImport={importNow} />}
    {record && createPortal(<div className="modal-backdrop"><section className="modal archive-record-modal" role="dialog" aria-modal="true" aria-labelledby="archive-record-title"><button className="modal-close icon-button" onClick={() => setRecord(null)} aria-label="Close archive record"><X size={18} /></button><div className="eyebrow">IMPORTED {String(record.kind || 'RECORD').toUpperCase()}</div><h2 id="archive-record-title">{record.title}</h2><div className="archive-record-source"><span>{PROVIDER_LABELS[record.provider] || 'Imported source'}</span>{record.sourceFile && <span title={record.sourceFile}>{record.sourceFile}</span>}{record.updatedAt && <span>{dateLabel(record.updatedAt)}</span>}</div>{record.loading && !localError ? <div className="archive-record-loading"><Spinner />Opening record…</div> : <SelectableText className="archive-record-text">{record.text}</SelectableText>}{localError && <p className="inline-error" role="alert">{localError}</p>}<div className="archive-record-bottom"><span>{record.text?.length || 0} / {record.totalCharacters || record.text?.length || 0} characters</span>{record.nextOffset !== null && record.nextOffset !== undefined && <button className="secondary-button" disabled={!!busyAction} onClick={() => archiveAction('archive-read-more', async () => { const next = await api.invoke('archive.read', { id: record.id, offset: record.nextOffset }); setRecord(previous => ({ ...next, text: previous.text + next.text })); })}>{busyAction === 'archive-read-more' ? <Spinner size={13} /> : <ArrowDown size={13} />}Load more</button>}<button className="primary-button" onClick={() => setRecord(null)}>Done</button></div></section></div>, document.body)}
  </section>;
}

export default function App({ session = {} }) {
  const [interfaceView, chooseInterfaceView] = useInterfaceView();
  const standardView = interfaceView === 'standard';
  const [hudHidden, setHudHidden] = useHud();
  const [workspaceMapOpen, setWorkspaceMapOpen] = useState(false);
  const [notesOpenRequest, setNotesOpenRequest] = useState(false);
  const [data, setData] = useState({ settings: initialSettings, connections: [], conversations: [], memories: [], tools: [], version: '' });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('chat');
  const [settingsSection, setSettingsSection] = useState('general');
  const [settingsSelectionRequest, setSettingsSelectionRequest] = useState(0);
  const settingsScrollRequest = useRef(0);
  const [selectedId, setSelectedId] = useState(null);
  const [draftPrivate, setDraftPrivate] = useState(false);
  const [taskSetup, setTaskSetup] = useState(false), [draftTask, setDraftTask] = useState(null), [taskPromptVisible, setTaskPromptVisible] = useState(false), [taskSetupDraft,setTaskSetupDraft] = useState(null);
  const discardingPrivate = useRef(new Set());
  const temporaryNavigation = useRef(0);
  const [draftProject,setDraftProject]=useState(''),[openEpoch,setOpenEpoch]=useState(0),[branchEdit,setBranchEdit]=useState(null),[tutorial,setTutorial]=useState(null),[tutorialStep,setTutorialStep]=useState(0);
  const activeTutorial=TUTORIALS.find(t=>t.id===tutorial);
  const [chatProviderOverrides, setChatProviderOverrides] = useState({});
  const [chatSelections, setChatSelections] = useState({});
  const modelPreferenceSaves = useRef(Promise.resolve()), pendingModelPreferences = useRef(null);
  // Level chosen for a chat that has not been sent yet; stored on the chat with its first message.
  const [draftPermission, setDraftPermission] = useState(null);
  const [draftStore] = useState(createDraftStore);
  const setDrafts = draftStore.update;
  const draftKey = selectedId || (draftPrivate ? 'new-private' : 'new');
  const setDraft = (value, key = draftKey) => setDrafts(previous => updateDraft(previous, key, value));
  const [attachmentDrafts, setAttachmentDrafts] = useState({});
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const fileInput = useRef(null);
  const attachmentKey = draftKey;
  const draftAttachments = attachmentDrafts[attachmentKey] || [];
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authLink, setAuthLink] = useState(null);
  // Chats reply in parallel: one entry per chat that is replying, and follow-ups waiting for each.
  const [runs, setRuns] = useState({});
  const [queues, setQueues] = useState({});
  // Chats whose reply finished while another chat was open; kept across restarts.
  const [unread, setUnread] = useState(() => { try { return JSON.parse(localStorage.getItem('exomina.unread') || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem('exomina.unread', JSON.stringify(unread.slice(-200))); } catch { /* storage unavailable */ } }, [unread]);
  const runsRef = useRef({});
  runsRef.current = runs;
  const [approvals, setApprovals] = useState([]);
  const [connectorForms,setConnectorForms]=useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; } });
  const toggleSidebar = useCallback(() => setSidebarCollapsed(value => { try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? '0' : '1'); } catch {} return !value; }), []);
  const [modelOpen, setModelOpen] = useState(false);
  const modelArea = useRef(null);
  const closeModelPicker = useCallback(() => setModelOpen(false), []);
  useDismiss(modelArea, modelOpen, closeModelPicker);
  const [titlesPending, setTitlesPending] = useState([]);
  const [busyAction, setBusyAction] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memorySearchQuery, setMemorySearchQuery] = useState('');
  const [memoryFilter, setMemoryFilter] = useState('all');
  const [memorySearching, setMemorySearching] = useState(false);
  const [memoryResults, setMemoryResults] = useState(null);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [addingMemory, setAddingMemory] = useState(false);
  const [wakeResult, setWakeResult] = useState(null);
  const [archiveModalVisible, setArchiveModalVisible] = useState(false);
  const [providerModalVisible, setProviderModalVisible] = useState(false);
  const [chatModalVisible, setChatModalVisible] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesPortalTarget, setNotesPortalTarget] = useState(null);
  const notesRelocationRef = useRef(null);
  const [chatFindOpen, setChatFindOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatFindQuery, setChatFindQuery] = useState('');
  const [chatFindHit, setChatFindHit] = useState(null);
  const chatFindButton = useRef(null);
  const pendingChatHit = useRef(null);
  const [questionPopupId, setQuestionPopupId] = useState(null);
  const [questionDrafts, setQuestionDrafts] = useState({});
  const [questionSending, setQuestionSending] = useState([]);
  const shownQuestionPopups = useRef(new Set());
  const chatFindScrollFrame = useRef(0);
  const chatFindScope = useRef(null);
  chatFindScope.current = { id: selectedId, page, openEpoch, query: chatFindQuery };
  useLayoutEffect(() => () => cancelChatHitScroll(), [selectedId, page, openEpoch, chatFindQuery]);
  const [browserOpenByChat, setBrowserOpenByChat] = useState({});
  const browserAutoReveal = useRef(null);
  if(browserAutoReveal.current===null){try{browserAutoReveal.current=localStorage.getItem('exomina.browser.auto-reveal')!=='false';}catch{browserAutoReveal.current=true;}}
  const browserConversationId = selectedId && !selectedId.startsWith('pending-') ? selectedId : null;
  const browserOpen = !!browserOpenByChat[browserConversationId || 'new'];
  const setBrowserOpen = value => { const currentId = selectedRef.current && !selectedRef.current.startsWith('pending-') ? selectedRef.current : 'new'; setBrowserOpenByChat(previous => ({ ...previous, [currentId]: typeof value === 'function' ? value(!!previous[currentId]) : value })); };
  const revealBrowser = () => {if(browserAutoReveal.current){notesRelocationRef.current?.();setBrowserOpen(true);if(workflow.active)workflow.show('browser');}};
  const chooseBrowserVisibility = visible => {notesRelocationRef.current?.();browserAutoReveal.current=visible;try{localStorage.setItem('exomina.browser.auto-reveal',String(visible));}catch{}if(workflow.active){if(visible)workflow.show('browser');else workflow.hide('browser');}if(visible)setBrowserOpen(true);else setBrowserOpenByChat({});};
  const [transportOnline, setTransportOnline] = useState(true);
  const selectedRef = useRef(null);
  selectedRef.current = selectedId;
  const [browserInfo, setBrowserInfo] = useState({ url: '', title: 'Browser', loading: false, canGoBack: false, canGoForward: false });
  const [browserAddress, setBrowserAddress] = useState('');
  const browserHostRef = useRef(null);
  const browserAddressFocused = useRef(false);
  const fetchingRef = useRef(new Set());
  const stickRef = useRef(true);
  const settingsRef = useRef(null);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const [dismissedPrompt, setDismissedPrompt] = useState('');
  const settings = { ...initialSettings, ...data.settings };
  settingsRef.current = settings;
  const running = !!runs[selectedId];
  const runningIds = Object.keys(runs);
  const anyRunning = runningIds.length > 0;
  const isWeb = !isDesktop;
  const capabilities = { nativeBrowser: isDesktop, localFiles: isDesktop, desktopControl: isDesktop, archiveUpload: false, ...data.runtime?.capabilities };
  const runtime = data.runtime || { mode: isDesktop ? 'desktop' : 'web', executor: { label: isDesktop ? 'This PC' : 'Private server', online: true } };
  const canUseConnection = item => providerReady(item) && (!isWeb || !['subscription', 'local'].includes(providers[item?.id]?.mode) || item?.available === true);
  const catalog = data.providers?.length ? data.providers : DEFAULT_PROVIDERS;
  const modelPreferences = useMemo(() => normalizeModelPreferences(settings.modelPreferences), [settings.modelPreferences]);
  const pickerCatalog = useMemo(() => catalog.filter(item => providerVisible(modelPreferences, item.id, data.connections.find(c => c.id === item.id), data.providerModels?.[item.id])), [catalog, modelPreferences, data.connections, data.providerModels]);
  const providers = useMemo(() => Object.fromEntries(catalog.map(item => [item.id, item])), [catalog]);
  const provider = providers[settings.provider] ? settings.provider : 'codex';

  const conversation = data.conversations.find(item => item.id === selectedId);
  const privateChat = conversation?.private === true || (!selectedId && draftPrivate);
  const workflow=useWorkflowWorkspace({available:isDesktop,suspended:privateChat,onError:setError});
  const browserPanelOpen=!privateChat&&(workflow.active?workflow.hasPanel('browser'):browserOpen);
  const browserSurfaceVisible=!privateChat&&(workflow.active?workflow.visible('browser'):browserOpen);
  const browserWorkflowPosition=workflow.active?Object.entries(workflow.layout.groups).find(([,group])=>group.panels.includes('browser'))?.[0]||'floating':'default';
  useEffect(()=>{
    if(!isDesktop||!api)return;
    const timer=setTimeout(()=>api.invoke('app.inspection.report',{page,conversationId:privateChat?null:selectedId,private:privateChat,interfaceView,settingsSection,panels:{browser:page==='chat'&&browserSurfaceVisible,terminal:page==='chat'&&!standardView&&(workflow.active?workflow.visible('terminal'):terminalOpen),notes:page==='chat'&&!privateChat&&(workflow.active?workflow.visible('notes'):notesOpen)},layout:workflow.layout,savedWorkspaces:workflow.saved}).catch(()=>{}),120);
    return()=>clearTimeout(timer);
  },[page,selectedId,privateChat,interfaceView,settingsSection,browserSurfaceVisible,terminalOpen,notesOpen,workflow.layout,workflow.saved]);
  const savedConversations = useMemo(() => data.conversations.filter(item => item.private !== true), [data.conversations]);
  useEffect(() => {
    // Navigation discards the chat even if it is still replying. Pending first sends
    // are resolved before discarding, so a late response cannot strand a private chat.
    if(page!=='chat'){setDraftPrivate(false);setDrafts(previous=>updateDraft(previous,'new-private',''));}
    if (page==='chat'&&selectedId?.startsWith('pending-')) return;
    for (const chat of data.conversations) if (chat.private === true && !chat.id.startsWith('pending-') && (page !== 'chat' || chat.id !== selectedId) && !discardingPrivate.current.has(chat.id)) {
      discardingPrivate.current.add(chat.id);
      api.invoke('conversations.discard', { id: chat.id }).catch(async () => { await new Promise(resolve=>setTimeout(resolve,250));return api.invoke('conversations.discard',{id:chat.id}); }).then(() => {
        setData(previous => ({ ...previous, conversations: previous.conversations.filter(item => item.id !== chat.id) }));
        setDrafts(previous => updateDraft(previous, chat.id, ''));
        setAttachmentDrafts(previous => { const next = { ...previous }; delete next[chat.id]; return next; });
        setUnread(previous => previous.filter(id => id !== chat.id));
        setSelectedId(current => current === chat.id ? null : current);
      }).catch(err => setError(displayError(err))).finally(() => discardingPrivate.current.delete(chat.id));
    }
  }, [page, selectedId, data.conversations]);
  // Ghost-text prediction: offered only in an empty composer after a finished reply.
  const lastReply = conversation?.messages?.at(-1);
  const nextPrompt = !running && settings.promptSuggestions !== false && lastReply?.role === 'assistant' && lastReply.nextPrompt && dismissedPrompt !== lastReply.id ? lastReply.nextPrompt : '';
  const pendingApproval = approvals.find(item => item.conversationId && item.conversationId === selectedId) || approvals[0];
  const visibleMessages = useMemo(() => questionAnswerDisplayMessages(conversation?.messages || []).filter(message => message.role !== 'system'), [conversation?.messages]);
  const homeProvider = pickerCatalog.some(item => item.id === provider) ? provider : pickerCatalog[0]?.id || provider;
  const activeProvider = chatProviderOverrides[selectedId] || conversation?.provider || homeProvider;
  const privacy = PROVIDER_PRIVACY[activeProvider];
  const connection = data.connections.find(item => item.id === activeProvider);
  const chatSelection = chatSelections[selectedId] || conversation?.selection;
  const storedModel = chatSelection?.provider === activeProvider ? chatSelection.model : activeProvider === provider ? (settings.model || connection?.model || 'auto') : (connection?.model || 'auto');
  const activeModel = !conversation && !modelVisible(modelPreferences, activeProvider, storedModel) ? preferredModel(modelPreferences, activeProvider, data.providerModels?.[activeProvider]) || storedModel : storedModel;
  const availableModels = data.providerModels?.[activeProvider] || [];
  const selectedModel = resolveModel(availableModels, activeModel);
  const storedEffort = chatSelection?.provider === activeProvider ? chatSelection.effort : activeProvider === provider ? settings.effort : '';
  const activeEffort = selectedModel?.efforts?.some(item => item.id === storedEffort) ? storedEffort : '';
  const storedSpeed = chatSelection?.provider === activeProvider ? chatSelection.speed : activeProvider === provider ? settings.speed : '';
  const activeSpeed = selectedModel?.speeds?.some(item => item.id === storedSpeed) ? storedSpeed : '';
  const activeSpeedOption = selectedModel?.speeds?.find(item => item.id === activeSpeed);
  const saveModel = (model, requestedEffort = activeEffort) => { const next = resolveModel(availableModels, model), effort = next?.efforts?.some(item => item.id === requestedEffort) ? requestedEffort : ''; if (selectedId) setChatSelections(previous => ({ ...previous, [selectedId]: { provider: activeProvider, model, effort, speed: '' } })); return saveSettings({ provider: activeProvider, model, effort, speed: '' }); };
  const saveEffort = effort => { if (selectedId) setChatSelections(previous => ({ ...previous, [selectedId]: { provider: activeProvider, model: activeModel, effort, speed: activeSpeed } })); return saveSettings({ provider: activeProvider, model: activeModel, effort, speed: activeSpeed }); };
  const saveSpeed = speed => { if (selectedId) setChatSelections(previous => ({ ...previous, [selectedId]: { provider: activeProvider, model: activeModel, effort: activeEffort, speed } })); return saveSettings({ provider: activeProvider, model: activeModel, effort: activeEffort, speed }); };
  const pickProvider = id => { const model = preferredModel(modelPreferences, id, data.providerModels?.[id]) || 'auto'; if (selectedId) { setChatProviderOverrides(previous => ({ ...previous, [selectedId]: id })); setChatSelections(previous => ({ ...previous, [selectedId]: { provider: id, model, effort: '', speed: '' } })); } return saveSettings({ provider: id, model, effort: '', speed: '' }); };
  const chatPermission = conversation ? conversation.permissionMode || null : draftPermission;
  const effectivePermission = chatPermission || settings.permissionMode || 'ask';
  const currentProject=data.workbench?.projects?.find(p=>p.id===(conversation?.projectId||draftProject));
  const displayWorkspace=currentProject?.folder||settings.workspace;
  const appearance = normalizeAppearance(settings.appearance);
  const appearanceKey = JSON.stringify(appearance);
  const memories = (memoryResults || data.memories).filter(memory => memoryFilter !== 'new' || memory.reviewed === false);
  const newMemoryCount = Math.max(0, Number(data.memoryReview?.unreviewedCount) || 0);
  const voice = useVoice({ api, settings: settings.voice, page, conversationId: selectedId, provider:activeProvider,projectId:conversation?.projectId||draftProject,running,
    reply: visibleMessages.findLast(message => message.role === 'assistant'),
    onDraft: text => setDraft(current => current.trim() ? current + ' ' + text : text),
    onSend: text => sendMessage(null, text),onConversation:id=>{setSelectedId(id);stickRef.current=true;refresh();} });

  const refreshJob = useRef(null);
  if (!refreshJob.current) refreshJob.current = createCoalescedRefresh(async () => {
    if (!api) { setLoading(false); return; }
    try {
      const state = await api.invoke('bootstrap', {compact:isDesktop,conversationId:selectedRef.current});
      if (pendingModelPreferences.current) state.settings = { ...state.settings, modelPreferences: pendingModelPreferences.current };
      if (Array.isArray(state.activeRuns)) { const next = Object.fromEntries(state.activeRuns.map(run => [run.conversationId, { startedAt: run.startedAt }])); runsRef.current = next; setRuns(next); }
      if (state.queues) setQueues(state.queues);
      if (Array.isArray(state.connectorForms)) setConnectorForms(state.connectorForms);
      if (Array.isArray(state.approvals)) setApprovals(state.approvals); if (Array.isArray(state.titlesPending)) setTitlesPending(state.titlesPending);
      if (state.updateNotice?.status === 'installed' || state.providerNotice) setNotice([state.updateNotice?.status === 'installed' && 'Exomina was updated to the new build.', state.providerNotice].filter(Boolean).join(' ')); else if (state.updateNotice) setError(`The update was not installed. ${state.updateNotice.message || ''}`.trim());
      // A chat that is replying keeps its streamed copy; everything else takes the saved state.
      setData(previous => ({...previous,...state,conversations:mergeChatSnapshot(previous.conversations,state.conversations||[],runsRef.current,selectedRef.current)}));
    }
    catch (err) { setError(displayError(err)); }
    finally { setLoading(false); }
  });
  const refresh = useCallback(() => refreshJob.current(), []);

  const dataRef = useRef(data);
  dataRef.current = data;
  const searchLibrary=useCallback(options=>api.invoke('conversations.search',options),[]);
  useEffect(()=>{
    if(!dataRef.current.libraryCompact)return;
    setData(previous=>({...previous,conversations:previous.conversations.map(chat=>chat.id===selectedId||chat.messagesLoaded===false||String(chat.id).startsWith('pending-')?chat:conversationSummary(chat))}));
  },[selectedId,data.libraryCompact]);
  /** Updates one chat in place; a chat this window has not loaded yet is fetched once. */
  function patchChat(id, update) {
    if (!dataRef.current.conversations.some(item => item.id === id)) {
      if(dataRef.current.libraryCompact&&id!==selectedRef.current){refresh();return;}
      if (!fetchingRef.current.has(id)) { fetchingRef.current.add(id); api.invoke('conversations.get', { id }).then(result => { if (result) setData(previous => previous.conversations.some(item => item.id === id) ? previous : { ...previous, conversations: [...previous.conversations, result] }); }).catch(() => {}).finally(() => fetchingRef.current.delete(id)); }
      return;
    }
    setData(previous => ({ ...previous, conversations: previous.conversations.map(item => {if(item.id!==id)return item;const next=update(item);return previous.libraryCompact&&id!==selectedRef.current?conversationSummary(next):next;}) }));
  }
  /** Updates the reply that is streaming in a chat (its last assistant message). */
  function patchReply(id, update) {
    patchChat(id, chat => { const messages = [...(chat.messages || [])]; let index = messages.length - 1; if (messages[index]?.role !== 'assistant') { messages.push({ role: 'assistant', content: '', provider: chat.provider, startedAt: new Date().toISOString(), activity: [] }); index = messages.length - 1; } messages[index] = update({ ...messages[index] }); return { ...chat, messages }; });
  }
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!loading) applyAppearance(JSON.parse(appearanceKey), { animate: true }); }, [appearanceKey, loading]);
  useEffect(() => watchArtworkFrame(), []);
  useEffect(() => { if (isDesktop) api.invoke('window.state').then(window => setData(previous => ({ ...previous, window }))).catch(() => {}); }, []);
  useEffect(() => {
    if (page !== 'memory') return;
    if (!memorySearchQuery && memoryFilter === 'all') { setMemoryResults(null); setMemorySearching(false); return; }
    let canceled = false;
    setMemorySearching(true);
    api.invoke('memory.search', { query: memorySearchQuery, newOnly: memoryFilter === 'new' }).then(result => {
      if (!canceled) setMemoryResults(result);
    }).catch(err => { if (!canceled) setError(displayError(err)); }).finally(() => { if (!canceled) setMemorySearching(false); });
    return () => { canceled = true; };
  }, [page, memoryFilter, memorySearchQuery, data.memories]);
  useEffect(() => {
    if (!api) return;
    const announcedQuestions = new Set();
    const dispatch = event => {
      const id = event.conversationId;
      const away = () => !document.hasFocus();
      if(event.type==='chat.memory.status')setData(previous=>({...previous,chatMemory:event.status}));
      else if(event.type==='chat.temporary.closed'){newChat();}
      else if(event.type==='chat.open'){api.invoke('conversations.get',{id}).then(selectConversation).catch(e=>setError(displayError(e)));}
      else if(event.type==='window.changed')setData(previous=>({...previous,window:event.window}));
      else if(event.type==='attention.sound')notify('attention',settingsRef.current.sounds,{focused:event.focused&&id===selectedRef.current});
      else if(event.type==='chat.followup'){patchChat(id,chat=>{const messages=[...(chat.messages||[])];let index=messages.findIndex(m=>m.id===event.messageId);if(index<0)index=messages.findLastIndex(m=>m.role==='assistant');if(index<0)return chat;const m=messages[index],items=[...(m.followups||[])],position=items.findIndex(item=>item.id===event.followup.id);if(position<0)items.push(event.followup);else items[position]=event.followup;messages[index]={...m,followups:items};return {...chat,messages};});}
      else if(event.type==='chat.question'){patchChat(id,chat=>{const messages=[...(chat.messages||[])],index=messages.findIndex(m=>m.id===event.messageId);if(index<0)return chat;const m=messages[index],questions=[...(m.questions||[])],position=questions.findIndex(item=>item.id===event.question.id);if(position<0)questions.push(event.question);else questions[position]=event.question;messages[index]={...m,questions};return {...chat,messages};});
        // Questions get the same "needs you" sound as approvals, once per question (later events only update its status).
        if(['waiting','open'].includes(event.question?.status)&&!announcedQuestions.has(event.question.id)){announcedQuestions.add(event.question.id);if(!isDesktop)notify('attention',settingsRef.current.sounds,{focused:document.hasFocus()&&id===selectedRef.current});}}
      else if(event.type==='chat.touched'){patchChat(id,chat=>({...chat,updatedAt:event.updatedAt}));}
      else if(event.type==='chat.helper')patchChat(id,chat=>{
        const messages=[...(chat.messages||[])],index=event.messageId?messages.findIndex(message=>message.role==='assistant'&&message.id===event.messageId):messages.findLastIndex(message=>message.role==='assistant');
        if(index<0)return chat;
        const message=messages[index],result=mergeHelperActivity(message.helpers,event.helper);messages[index]={...message,helpers:result.helpers,helpersOmitted:Math.max(message.helpersOmitted||0,event.helpersOmitted||0)+(event.helpersOmitted===undefined?result.omitted:0)};return {...chat,messages};
      });
      else if (event.type === 'chat.started') {
        runsRef.current = { ...runsRef.current, [id]: { startedAt: event.startedAt } }; setRuns(runsRef.current);
        // Queued follow-ups are not in the list yet; their text arrives with the start.
        patchChat(id, chat => { const messages = [...(chat.messages || [])]; const last = messages.at(-1);if(last?.role==='assistant'&&((event.messageId&&last.id===event.messageId)||(!last.content&&messages.at(-2)?.content===event.text))){messages[messages.length-1]={...last,startedAt:event.startedAt,id:event.messageId||last.id};return {...chat,provider:event.provider,updatedAt:event.startedAt||new Date().toISOString(),messages};} if ((event.text || event.attachments?.length) && !(last?.role === 'user' && last.content === event.text)) messages.push({ role: 'user', content: event.text, provider: event.provider, attachments: event.attachments }); messages.push({ id: event.messageId, role: 'assistant', content: '', provider: event.provider, startedAt: event.startedAt, activity: [] }); return { ...chat, provider: event.provider, updatedAt: event.startedAt || new Date().toISOString(), messages }; });
      } else if (event.type === 'chat.handoff') {
        const selection = { provider: event.provider, model: event.model, effort: event.effort };
        setChatProviderOverrides(previous => ({ ...previous, [id]: event.provider })); setChatSelections(previous => ({ ...previous, [id]: selection }));
        patchChat(id, chat => ({ ...chat, provider: event.provider, selection, messages: chat.messages.map((m, index) => index === chat.messages.length - 1 && m.role === 'assistant' ? { ...m, provider: event.provider } : m) }));
      } else if (event.type === 'chat.delta') patchReply(id, message => ({ ...message, content: (message.content || '') + event.text }));
      else if (event.type === 'chat.mode') patchReply(id, message => ({ ...message, lane: event.lane }));
      else if (event.type === 'chat.contextMetrics') patchReply(id, message => message.id===event.messageId?({ ...message, contextMetrics:event.contextMetrics }):message);
      else if (event.type === 'chat.segment') patchReply(id, message => ({ ...message, content: '', activity: [...(message.activity || []), event.step] }));
      else if (event.type === 'chat.activity') patchReply(id, message => {
        const steps = [...(message.activity || [])], index = steps.findIndex(step => step.id === event.step.id), before = index >= 0 ? steps[index] : {};
        const step = { ...before, ...event.step, ...(event.append !== undefined ? { text: (before.text || '') + event.append } : {}) };
        if (index >= 0) steps[index] = step; else steps.push(step);
        return { ...message, activity: steps };
      });
      else if (event.type === 'chat.asset') {
        try { mediaAttachment(event.attachment); } catch (failure) { setError(displayError(failure)); return; }
        setData(previous => ({ ...previous, conversations: mergeChatAsset(previous.conversations, event, null) }));
      } else if (event.type === 'chat.complete' || event.type === 'chat.error') {
        const { [id]: _done, ...rest } = runsRef.current; runsRef.current = rest; setRuns(rest);
        const title = (dataRef.current.conversations.find(item => item.id === id)?.title) || 'A chat';
        if (event.type === 'chat.error' && !/^Stopped\.?$/.test(String(event.error || ''))) { setError(id === selectedRef.current ? displayError(event.error) : `“${title}”: ${displayError(event.error)}`); notify('error', settingsRef.current.sounds, { focused: !away() }); }
        else if (event.type === 'chat.complete') { notify('done', settingsRef.current.sounds, { focused: !away() && id === selectedRef.current }); if (id !== selectedRef.current) { setNotice(`“${title}” finished.`); setUnread(previous => previous.includes(id) ? previous : [...previous, id]); } }
        if(!dataRef.current.libraryCompact||id===selectedRef.current)api.invoke('conversations.get', { id }).then(result => {
          if (result && !runsRef.current[id]) setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === result.id ? previous.libraryCompact&&id!==selectedRef.current?conversationSummary(result):result : item) }));
        }).catch(() => {});
        refresh();
      } else if (event.type === 'chat.queue') {
        setQueues(previous => ({ ...previous, [id]: event.queue || [] }));
        if (event.sent) notify('followup', settingsRef.current.sounds, { focused: !away() });
        if (event.returnedAttachments?.length) setAttachmentDrafts(previous => ({ ...previous, [id]: [...(previous[id] || []), ...event.returnedAttachments].filter((item, index, list) => list.findIndex(other => other.uploadId === item.uploadId) === index) }));
        if (event.returned?.length) {
          setDrafts(previous => restoreDraft(previous, id || 'new', event.returned.join('\n\n')));
          if (id === selectedRef.current) { setNotice(event.returned.length === 1 ? 'Your follow-up was not sent. It is back in the message box.' : `${event.returned.length} follow-ups were not sent. They are back in the message box.`); }
          else setNotice(`${event.returned.length} queued ${event.returned.length === 1 ? 'follow-up was' : 'follow-ups were'} not sent because the reply was stopped.`);
        }
      }
      else if (event.type === 'chat.title.pending') setTitlesPending(previous => previous.includes(event.conversationId) ? previous : [...previous, event.conversationId]);
      else if (event.type === 'chat.title.done') setTitlesPending(previous => previous.filter(id => id !== event.conversationId));
      else if(event.type==='connector.form')setConnectorForms(previous=>previous.some(item=>item.id===event.request.id)?previous:[...previous,event.request]);
      else if(event.type==='connector.resolved')setConnectorForms(previous=>previous.filter(item=>item.id!==event.id));
      else if (event.type === 'approval') { setApprovals(previous => previous.some(item => item.id === event.id) ? previous : [...previous, event]); if(!isDesktop)notify('attention', settingsRef.current.sounds, { focused: document.hasFocus() && event.conversationId === selectedRef.current }); }
      else if (event.type === 'approval.resolved') setApprovals(previous => previous.filter(item => item.id !== event.id));
      else if (event.type === 'connections') { setData(previous => ({ ...previous, connections: event.connections, ...(event.providerModels ? { providerModels: { ...previous.providerModels, ...event.providerModels } } : {}) })); setAuthLink(current => current?.provider && event.connections.some(item => item.id === current.provider && item.connected) ? null : current); }
      else if (event.type === 'auth.url') { const url = officialLoginUrl(event.url, event.provider); if (url) setAuthLink({ url, provider: event.provider, userCode: signInCode(event.userCode) }); else setError('The provider returned an unsupported sign-in address.'); }
      else if (event.type === 'auth.completed') { setAuthLink(current => !event.provider || current?.provider === event.provider ? null : current); refresh(); }
      else if (event.type === 'messaging.status') setData(previous => ({ ...previous, messaging: event.status }));
      else if (event.type === 'usage') setData(previous => ({ ...previous, usage: event.usage }));
      else if (event.type === 'guard.tripped') setNotice(event.message);
      else if (event.type === 'update.error') setError(`Exomina could not restart to update. ${event.message || ''}`.trim());
      else if (event.type === 'auth.error') { setAuthLink(current => !event.provider || current?.provider === event.provider ? null : current); setError(event.message || 'Provider sign-in could not be completed.'); }
      else if (event.type === 'browser.reveal') { const id = selectedRef.current && !selectedRef.current.startsWith('pending-') ? selectedRef.current : null; if (event.conversationId === undefined || event.conversationId === id) revealBrowser(); }
      else if (event.type === 'browser.state') { const next = event.state || event, id = selectedRef.current && !selectedRef.current.startsWith('pending-') ? selectedRef.current : null; if (event.conversationId !== undefined && event.conversationId !== id) return; setBrowserInfo(previous => ({ ...previous, ...next })); if (!browserAddressFocused.current && next.url !== undefined) setBrowserAddress(next.url === 'about:blank' ? '' : next.url); }
      else if (event.type === 'state.changed' || event.type === 'security.changed') refresh();
      else if (event.type === 'sync.status') setData(previous => ({ ...previous, sync: event.sync || event.status }));
      else if (event.type === 'transport.connected') setTransportOnline(true);
      else if (event.type === 'transport.offline') setTransportOnline(false);
      else if (event.type === 'transport.error') setError(event.error);
      else if (event.type === 'transport.reconnected') {
        setTransportOnline(true); refresh();
        const id = selectedRef.current;
        if (id && !id.startsWith('pending-')) api.invoke('conversations.get', { id }).then(result => { if (result) setData(previous => ({ ...previous, conversations: [...previous.conversations.filter(item => item.id !== result.id), result] })); }).catch(err => setError(displayError(err)));
      }
    };
    const stream = createChatEventBuffer(dispatch), unsubscribe = api.onEvent(event => stream.accept(event));
    return () => { unsubscribe(); stream.close(); };
  }, [refresh]);
  useEffect(() => {
    const hit = pendingChatHit.current;
    if (hit && hit.id === conversation?.id) {
      const target = scrollRef.current?.querySelector(`[data-message-index="${hit.messageIndex}"]`);
      if (target) { onChatScroll.user?.('search-hit'); stickRef.current = false; target.scrollIntoView({ block: 'center' }); pendingChatHit.current = null; }
    // Follows the stream only while you are at the bottom, so scrolling up to read stays put.
    } else if (scrollRef.current && !chatFindQuery && stickRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conversation?.messages, running, queues[selectedId]]);
  const onChatScroll = useChatScroll({ scrollRef, stickRef, viewKey: `${selectedId || 'new'}:${page}`, openEpoch, enabled: page === 'chat' && !loading, pendingHit: pendingChatHit, searchQuery: chatFindQuery, report: trace => api?.invoke('diagnostics.chatScroll', { conversationId: selectedRef.current, ...trace }).catch(() => {}) });
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const keydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'n') { event.preventDefault(); newChat(); } if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); navigate('settings'); } if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); } if (event.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    const findShortcut = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && page === 'chat' && conversation) { event.preventDefault(); setChatFindOpen(true); } };
    window.addEventListener('keydown', findShortcut); return () => window.removeEventListener('keydown', findShortcut);
  }, [page, conversation?.id]);
  const floatingApproval = page !== 'chat' && approvals.length > 0;
  const pendingConnectorForm=connectorForms.find(item=>item.conversationId===selectedId)||connectorForms[0];
  const otherModalVisible = workspaceMapOpen || taskPromptVisible || !!pendingConnectorForm || addingMemory || !!wakeResult || !!confirm || floatingApproval || sidebarOpen || archiveModalVisible || providerModalVisible || chatModalVisible || !!branchEdit;
  const questionGroups = visibleMessages.flatMap(message => message.questions || []);
  const pendingQuestionGroups = questionGroups.filter(group => needsQuestionAnswer(group) && group.source?.kind !== 'assistant-text');
  const questionPopupGroup = page === 'chat' && !otherModalVisible && !pendingApproval ? questionGroups.find(group => group.id === questionPopupId) : null;
  const modalVisible = otherModalVisible || !!questionPopupGroup || workflow.menuOpen || !!workflow.panelMenuOpen;
  // Approvals and connection forms restore the HUD; questions retain their popup and compact cards.
  const hudActive = hudHidden && page === 'chat' && !taskSetup && !approvals.length && !pendingConnectorForm;
  const hudPeek = useHudChrome(hudActive && isDesktop, isDesktop ? hudChromeInvoke : null);
  useEffect(() => {
    const keydown = event => {
      if (isHudShortcut(event)) { event.preventDefault(); setHudHidden(value => !value); return; }
      if (hudActive && event.key === 'Escape' && !event.defaultPrevented && !modalVisible && !(event.target?.tagName === 'TEXTAREA' && event.target.value)) setHudHidden(false);
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [hudActive, modalVisible]);
  const browserLayout = useBrowserResize(!workflow.active && browserOpen && capabilities.nativeBrowser && !modalVisible);
  useEffect(() => {
    if (page !== 'chat') { if (questionPopupId) setQuestionPopupId(null); return; }
    if (otherModalVisible || pendingApproval || modelOpen || tutorial) return;
    const current = questionGroups.find(group => group.id === questionPopupId);
    if (current && (needsQuestionAnswer(current) || questionSending.includes(questionSessionKey(selectedId, current.id)))) return;
    const next = pendingQuestionGroups.find(group => !shownQuestionPopups.current.has(selectedId + ':' + group.id));
    if (next) { shownQuestionPopups.current.add(selectedId + ':' + next.id); setQuestionPopupId(next.id); }
    else if (questionPopupId) setQuestionPopupId(null);
  }, [page, selectedId, conversation?.messages, questionPopupId, questionSending, otherModalVisible, pendingApproval, modelOpen, tutorial]);
  // Streaming changes message text, not the question editor session. A fresh
  // context value would make React revisit every saved message's descendants.
  const questionSession = useMemo(() => ({
    drafts: Object.fromEntries(Object.entries(questionDrafts).filter(([key]) => JSON.parse(key)[0] === selectedId).map(([key, value]) => [JSON.parse(key)[1], value])),
    sending: questionSending.filter(key => JSON.parse(key)[0] === selectedId).map(key => JSON.parse(key)[1]),
    change: (id, update, initial) => { const key = questionSessionKey(selectedId, id); setQuestionDrafts(previous => ({ ...previous, [key]: update(previous[key] || initial) })); },
    open: id => { shownQuestionPopups.current.add(selectedId + ':' + id); setQuestionPopupId(id); },
  }), [selectedId, questionDrafts, questionSending]);
  function dismissQuestions() { for (const group of pendingQuestionGroups) shownQuestionPopups.current.add(selectedId + ':' + group.id); setQuestionPopupId(null); }
  async function answerQuestion(id, answers, source) {
    const parent = selectedId, key = questionSessionKey(parent, id);
    setQuestionSending(previous => [...new Set([...previous, key])]);
    try {
      const result = await api.invoke(source ? 'chat.question.answerText' : 'chat.question.answer', { conversationId: parent, id, answers, ...(source ? { source } : {}) });
      if (result?.status !== 'answered') throw Error('Your answer has not been confirmed. Try again.');
      if (!['returned', 'delivered', 'failed'].includes(result.deliveryState)) throw Error('Your answer is saved, but sending has not yet been confirmed. You can check it again.');
      patchChat(parent, chat => ({ ...chat, messages: chat.messages.map(message => ({ ...message, ...(message.questions ? { questions: message.questions.map(group => group.id === id ? { ...group, status: result.status, answers: result.answers, ...(result.deliveryState ? { deliveryState: result.deliveryState, deliveryError: result.deliveryError } : {}) } : group) } : {}) })) }));
      if (result.deliveryState !== 'failed') setQuestionDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
      return result;
    } finally { setQuestionSending(previous => previous.filter(item => item !== key)); }
  }
  async function continueQuestion(id) { await api.invoke('chat.question.continue', { conversationId: selectedId, id }); dismissQuestions(); }
  useEffect(() => {
    if (!capabilities.nativeBrowser) return;
    // Native child views receive their own mouse input. Hide the view during a
    // divider drag so crossing the page cannot steal pointer capture.
    const visible = browserSurfaceVisible && !privateChat && !modalVisible && !hudActive && !browserLayout.resizing && !workflow.resizing;
    let observer;
    let frame = 0;
    let disposed = false;
    const syncBounds = () => {
      const bounds = browserHostRef.current?.getBoundingClientRect();
      if (disposed || !browserSurfaceVisible || !bounds || bounds.width <= 0 || bounds.height <= 0) return Promise.resolve();
      return api.invoke('browser.bounds', { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    };
    const queueBounds = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; syncBounds().catch(err => { if (!disposed) setError(displayError(err)); }); });
    };
    browserAddressFocused.current = false;
    const showBrowser = async () => {
      await api.invoke('workspace.browser.owner',{id:workflow.browserOwner});
      if(disposed)return;
      // Apply the latest pane geometry before attaching the native view.
      if (visible) await syncBounds();
      if (disposed) return;
      const state = await api.invoke('browser.show', { visible, conversationId: browserConversationId });
      if (disposed) return;
      queueBounds();
      setBrowserInfo(state);
      if (!browserAddressFocused.current) setBrowserAddress(state.url === 'about:blank' ? '' : state.url || '');
    };
    showBrowser().catch(err => { if (!disposed) setError(displayError(err)); });
    if (browserHostRef.current) { observer = new ResizeObserver(queueBounds); observer.observe(browserHostRef.current); }
    const browserWindow=browserHostRef.current?.ownerDocument.defaultView||window;
    browserWindow.addEventListener('resize', queueBounds);
    return () => { disposed = true; observer?.disconnect(); cancelAnimationFrame(frame); browserWindow.removeEventListener('resize', queueBounds); };
  }, [browserSurfaceVisible, browserConversationId, modalVisible, hudActive, browserLayout.resizing, workflow.active, workflow.browserOwner, workflow.resizing, browserWorkflowPosition, privateChat, capabilities.nativeBrowser, settings.browserSource]);

  const importChats = () => act('archive-import', async () => { const result = await api.invoke('archive.importNow'); if (!result || result.canceled) return; await refresh(); setNotice(importSummary(result)); });
  async function act(name, fn) { if (!api) { setError('Open the desktop app to use this feature.'); return; } setBusyAction(name); setError(''); try { return await fn(); } catch (err) { setError(displayError(err)); } finally { setBusyAction(''); } }
  async function saveSettings(patch) { return act('settings', async () => { const next = await api.invoke('settings.save', patch); setData(previous => ({ ...previous, settings: next })); }); }
  async function saveModelPreferences(modelPreferences) {
    pendingModelPreferences.current = modelPreferences;
    setData(previous => ({ ...previous, settings: { ...previous.settings, modelPreferences } }));
    const task = modelPreferenceSaves.current.catch(() => {}).then(() => api.invoke('settings.save', { modelPreferences }));
    modelPreferenceSaves.current = task;
    try {
      const next = await task;
      if (pendingModelPreferences.current === modelPreferences) { pendingModelPreferences.current = null; setData(previous => ({ ...previous, settings: { ...previous.settings, modelPreferences: next.modelPreferences } })); }
    } catch (err) {
      if (pendingModelPreferences.current === modelPreferences) { pendingModelPreferences.current = null; setError(displayError(err)); refresh(); }
    }
  }
  async function saveAppearance(patch) {
    // Applied at once for a live preview; the saved value comes back from the host.
    setData(previous => ({ ...previous, settings: { ...previous.settings, appearance: { ...normalizeAppearance(previous.settings.appearance), ...patch } } }));
    if (!api) return;
    try { const next = await api.invoke('settings.save', { appearance: patch }); setData(previous => ({ ...previous, settings: next })); }
    catch (err) { setError(displayError(err)); refresh(); }
  }
  async function saveSounds(sounds) {
    setData(previous => ({ ...previous, settings: { ...previous.settings, sounds } }));
    try { const next = await api.invoke('settings.save', { sounds }); setData(previous => ({ ...previous, settings: { ...next, sounds: previous.settings.sounds } })); }
    catch (err) { setError(displayError(err)); refresh(); }
  }
  async function setChatPermission(mode) {
    if (!conversation) { setDraftPermission(mode); return; }
    await act('chat-permission', async () => {
      const result = await api.invoke('conversations.permission', { id: conversation.id, mode });
      setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === result.id ? { ...item, permissionMode: result.permissionMode } : item) }));
      setNotice(mode ? `This chat now uses ${modeInfo(data.permissionModes, mode).label}. Other chats are unchanged.` : `This chat follows the default again: ${modeInfo(data.permissionModes, settings.permissionMode).label}.`);
    });
  }
  function newChat(projectId='', temporary=false) { setTaskSetup(false);setDraftTask(null);setTaskPromptVisible(false); temporaryNavigation.current++;cancelChatHitScroll(); setDraftPrivate(temporary);setDrafts(previous=>updateDraft(previous,'new-private',''));setDraftProject(temporary?'':typeof projectId==='string'?projectId:'');setDraftPermission(null); setSelectedId(null); setPage('chat'); setError(''); setSidebarOpen(false); setChatFindOpen(false); setChatFindQuery(''); setChatFindHit(null); pendingChatHit.current = null; setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 0); }
  function navigate(next) { if(next!=='chat'){temporaryNavigation.current++;setTaskSetup(false);setTaskPromptVisible(false);}settingsScrollRequest.current++; cancelChatHitScroll(); setPage(next); setSidebarOpen(false); setError(''); }
  function openTaskSetup(sourceKind) { newChat(); if (typeof sourceKind === 'string') setTaskSetupDraft({ sourceKind, projectId: '' }); setTaskSetup(true); }
  async function chooseTaskFolder() {
    const result = await api.invoke('task.folder.choose');
    if (result) setData(previous => ({ ...previous, workbench: { ...previous.workbench, projects: [...(previous.workbench?.projects || []).filter(item=>item.id!==result.id), result] } }));
    return result;
  }
  function reviewTask(setup, text) { setDraftTask(setup);setDraftProject(setup.projectId);setTaskSetup(false);setDraft(text,'new');setTimeout(()=>{composerRef.current?.focus({preventScroll:true});composerRef.current?.closest('.composer')?.scrollIntoView({block:'nearest'});},0); }
  function insertTaskRequest(text) { setDraft(current => current.trim() ? current + '\n\n' + text : text);setTimeout(()=>composerRef.current?.focus({preventScroll:true}),0); }
  async function saveTaskPrompt(form) { await api.invoke('prompts.save',form);await refresh();setNotice('Reusable prompt saved. Type / in chat to find it.'); }
  function cancelChatHitScroll() { cancelAnimationFrame(chatFindScrollFrame.current); chatFindScrollFrame.current = 0; }
  function closeChatFind() { cancelChatHitScroll(); pendingChatHit.current = null; setChatFindOpen(false); setChatFindQuery(''); setChatFindHit(null); chatFindButton.current?.focus({ preventScroll: true }); }
  function showChatHit(hit) {
    const scope = chatFindScope.current;
    if (scope.page !== 'chat' || !scope.id || !scope.query.trim()) return;
    setChatFindHit(hit);
    cancelChatHitScroll();
    const frame = requestAnimationFrame(() => {
      if (chatFindScrollFrame.current !== frame) return;
      chatFindScrollFrame.current = 0;
      const current = chatFindScope.current;
      if (current.id !== scope.id || current.page !== scope.page || current.openEpoch !== scope.openEpoch || current.query !== scope.query) return;
      onChatScroll.user?.('find-hit'); stickRef.current = false;
      const article = scrollRef.current?.querySelector(`[data-message-index="${hit.messageIndex}"]`);
      (article?.querySelector(`[data-search-start="${hit.start}"]`) || article)?.scrollIntoView({ block: 'center' });
    });
    chatFindScrollFrame.current = frame;
  }
  async function selectConversation(item, hit = null) { setTaskSetup(false);setTaskPromptVisible(false); cancelChatHitScroll(); setDraftPrivate(false);setDrafts(previous=>updateDraft(previous,'new-private',''));setOpenEpoch(n=>n+1); setUnread(previous => previous.filter(id => id !== item.id)); pendingChatHit.current = hit ? { ...hit, id: item.id } : null; setChatFindHit(null); setChatFindOpen(!!hit); setChatFindQuery(hit?.query || ''); setSelectedId(item.id); navigate('chat'); try { const result = await api.invoke('conversations.get', { id: item.id }); if (result) setData(previous => ({ ...previous, conversations: previous.conversations.map(entry => entry.id === result.id ? previous.libraryCompact&&result.id!==selectedRef.current?conversationSummary(result):result : entry) })); } catch (err) { setError(displayError(err)); } }
  async function updateConversation(method, payload) {
    try {
      const result = await api.invoke(method, payload);
      if (!result?.id) throw Error('The chat change could not be confirmed.');
      const {pinnedChats = [], ...chatResult} = result;
      const pinChanges = new Map(pinnedChats.map(item => [item.id, item]));
      setData(previous => ({ ...previous, conversations: previous.conversations.map(item => {const next={...item,...pinChanges.get(item.id),...(item.id === result.id ? {...chatResult,messages:runsRef.current[item.id] ? item.messages : (result.messages || item.messages)} : {})};return previous.libraryCompact&&next.id!==selectedRef.current?conversationSummary(next):next;}) }));
      return result;
    } catch (failure) { const message = displayError(failure); setError(message); throw Error(message); }
  }
  async function chooseWorkspace() { await act('workspace', async () => { const result = await api.invoke('workspace.choose'); const path = typeof result === 'string' ? result : result?.path; if (path) setData(previous => ({ ...previous, settings: { ...previous.settings, workspace: path } })); }); }
  async function addAttachments(files) {
    if (!isDesktop || uploadLock.current || privateChat) return;
    const picked = Array.from(files || []), key = attachmentKey, existing = draftAttachments;
    if (!picked.length) return;
    if (existing.length + picked.length > 10 || picked.some(file => !file.size || file.size > 20 * 1024 * 1024) || existing.reduce((sum, item) => sum + item.bytes, 0) + picked.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) { setError('Attach up to 10 files, with at most 20 MiB in total. Empty files cannot be attached.'); return; }
    uploadLock.current = true; setUploading(true); setError('');
    try {
      for (const file of picked) {
        const attachment = await api.invoke('attachment.put', { name: file.name || 'Screenshot.png', mimeType: file.type, dataBase64: await fileBase64(file) });
        setAttachmentDrafts(previous => ({ ...previous, [key]: [...(previous[key] || []), attachment] }));
      }
    } catch (err) { setError(displayError(err)); }
    finally { uploadLock.current = false; setUploading(false); }
  }
  function pasteAttachments(event) {
    const element=event.currentTarget,files=isDesktop?Array.from(event.clipboardData.files||[]):[],text=event.clipboardData.getData('text/plain'),start=element.selectionStart,end=element.selectionEnd;
    const quoted=quotePaste(element.value,start,end,text);
    if(!files.length&&!quoted)return;
    event.preventDefault();
    if(text){const insert=quoted?.insert||text;let inserted=false;try{inserted=document.execCommand('insertText',false,insert);}catch{}if(!inserted){setDraft(element.value.slice(0,start)+insert+element.value.slice(end));requestAnimationFrame(()=>element.setSelectionRange(start+insert.length,start+insert.length));}}
    if(files.length)addAttachments(files);
  }
  async function sendMessage(event, dictated) {
    const navigationAtSend=temporaryNavigation.current;
    event?.preventDefault();
    const fromVoice = typeof dictated === 'string', text = fromVoice ? dictated.trim() : draftStore.get(draftKey).trim();
    if ((!text && !draftAttachments.length) || uploadLock.current || !transportOnline || !canUseConnection(connection) || selectedId?.startsWith('pending-') || (privateChat && !temporarySupported(activeProvider))) return;
    if (!fromVoice && voice.active) await voice.stop();
    const sendProvider = activeProvider;
    const attachments = draftAttachments, key = attachmentKey;
    const options = { text,...(!selectedId&&draftTask&&!privateChat?{taskGuide:{sourceKind:draftTask.sourceKind,goal:draftTask.goal,...(draftTask.purpose==='rewrite'?{purpose:'rewrite'}:{})}}:{}),...(!selectedId&&draftProject&&!privateChat?{projectId:draftProject}:{}),...(!selectedId&&privateChat?{private:true}:{}), attachments: privateChat?[]:attachments.map(item => item.uploadId), provider: sendProvider, model: activeModel === 'auto' ? undefined : activeModel, ...(activeEffort ? { effort: activeEffort } : {}), ...(selectedModel?.speeds?.length ? { speed: activeSpeed || 'standard' } : {}), ...(settings.routing && settings.routing !== 'auto' ? { mode: settings.routing } : {}) };
    // Desktop follow-ups can receive answers while the original task keeps working.
    if (running) {
      setDraft(''); setAttachmentDrafts(previous => ({ ...previous, [key]: [] }));
      try { await api.invoke('chat.send', { ...options, conversationId: selectedId, followupMode: isDesktop && !privateChat ? 'live' : 'queue' }); } catch (err) { setError(displayError(err)); setDrafts(previous => restoreDraft(previous, key, text)); setAttachmentDrafts(previous => ({ ...previous, [key]: [...attachments, ...(previous[key] || []).filter(item => !attachments.some(sent => sent.uploadId === item.uploadId))] })); }
      return;
    }
    const temporaryId = selectedId || `pending-${Date.now()}`;
    const newChatPermission = selectedId ? null : draftPermission;
    setDraft(''); setAttachmentDrafts(previous => ({ ...previous, [key]: [] })); setError(''); setSelectedId(temporaryId); stickRef.current = true;
    setData(previous => { const existing = previous.conversations.find(item => item.id === temporaryId); const next = existing ? { ...existing, updatedAt: new Date().toISOString(), messages: [...(existing.messages || []), { role: 'user', content: text, attachments }] } : { id: temporaryId, title: privateChat?'Temporary chat':text.slice(0, 54), ...(privateChat?{private:true}:{}), ...(options.taskGuide?{taskGuide:options.taskGuide}:{}), ...(options.projectId?{projectId:options.projectId}:{}), provider: sendProvider, ...(newChatPermission ? { permissionMode: newChatPermission } : {}), updatedAt: new Date().toISOString(), messages: [{ role: 'user', content: text, attachments }] }; return { ...previous, conversations: [...previous.conversations.filter(item => item.id !== temporaryId), next] }; });
    try {
      const result = await api.invoke('chat.send', { ...(selectedId ? { conversationId: selectedId } : {}), ...(newChatPermission ? { permissionMode: newChatPermission } : {}), ...options });
      if (options.taskGuide) { if(temporaryNavigation.current===navigationAtSend){setDraftTask(null);setTaskSetupDraft(null);}setData(previous=>({...previous,conversations:previous.conversations.map(chat=>chat.id===temporaryId||chat.id===result.conversationId?{...chat,taskGuide:options.taskGuide}:chat)})); }
      if(options.private===true&&temporaryNavigation.current!==navigationAtSend){await api.invoke('conversations.discard',{id:result.conversationId});setData(previous=>({...previous,conversations:previous.conversations.filter(item=>item.id!==temporaryId&&item.id!==result.conversationId)}));setDrafts(previous=>updateDraft(previous,temporaryId,''));return result;}
      if (newChatPermission) setDraftPermission(null);
      if (temporaryId !== result.conversationId) {
        setDrafts(previous => moveDraft(previous, temporaryId, result.conversationId));
        setAttachmentDrafts(previous => { if (!previous[temporaryId]?.length) return previous; const next = { ...previous, [result.conversationId]: [...(previous[result.conversationId] || []), ...previous[temporaryId]] }; delete next[temporaryId]; return next; });
        setChatProviderOverrides(previous => previous[temporaryId] ? { ...previous, [result.conversationId]: previous[temporaryId] } : previous);
        setSelectedId(current => current === temporaryId ? result.conversationId : current);
        setData(previous => ({ ...previous, conversations: previous.conversations.some(item => item.id === result.conversationId) ? previous.conversations.filter(item => item.id !== temporaryId) : previous.conversations.map(item => item.id === temporaryId ? { ...item, id: result.conversationId } : item) }));
      }
      return result;
    } catch (err) {
      setError(displayError(err)); if (!fromVoice) setDrafts(previous => restoreDraft(moveDraft(previous, temporaryId, key), key, text)); setAttachmentDrafts(previous => ({ ...previous, [key]: [...attachments, ...(previous[key] || []).filter(item => !attachments.some(sent => sent.uploadId === item.uploadId))] }));
      if (temporaryId.startsWith('pending-')) { setData(previous => ({ ...previous, conversations: previous.conversations.filter(item => item.id !== temporaryId) })); setSelectedId(current => current === temporaryId ? null : current); }
      await refresh();
      if (fromVoice) throw err;
    }
  }
  function jumpChat(bottom){onChatScroll.user?.(bottom?'bottom-button':'top-button');cancelChatHitScroll();pendingChatHit.current=null;stickRef.current=bottom;setChatFindQuery('');if(scrollRef.current)scrollRef.current.scrollTop=bottom?scrollRef.current.scrollHeight:0;}
  async function branch(message,index,text){await act('branch',async()=>{const result=await api.invoke('conversations.branch',{id:conversation.id,messageId:message.id,index,...(text!==undefined?{text}:{})});setBranchEdit(null);await refresh();await selectConversation(result.conversation);setDraft(result.text||'',result.conversation.id);if(result.attachments?.length)setAttachmentDrafts(p=>({...p,[result.conversation.id]:result.attachments}));});}
  function insertPrompt(text){navigate('chat');setDraft(text);setTimeout(()=>{composerRef.current?.closest('.composer')?.scrollIntoView({block:'nearest'});composerRef.current?.focus({preventScroll:true});},0);}
  function addExplorePrompt(text){setTaskSetup(false);setTaskPromptVisible(false);navigate('chat');setDraft(current=>current.trim()?current+'\n\n'+text:text);setTimeout(()=>{composerRef.current?.closest('.composer')?.scrollIntoView({block:'nearest'});composerRef.current?.focus({preventScroll:true});},0);}
  async function cancel() { await act('cancel', async () => { await api.invoke('chat.cancel', { conversationId: selectedId }); setNotice('Stopping this reply…'); }); }
  /** Sends the same message to another AI in a new chat that runs alongside this one. */
  async function askAnother(text, providerId) {
    if (privateChat) return;
    try {
      const result = await api.invoke('chat.send', { text, provider: providerId, model: preferredModel(modelPreferences, providerId, data.providerModels?.[providerId]) || 'auto' });
      setNotice(`Asking ${providers[providerId]?.name || 'another AI'} in a new chat. It appears in your chat list.`);
      patchChat(result.conversationId, chat => chat);
    } catch (err) { setError(displayError(err)); }
  }
  async function unqueue(item) { try { await api.invoke('chat.unqueue', { conversationId: selectedId, id: item.id }); setDraft(current => current.trim() ? current : item.text); if (item.attachments?.length) setAttachmentDrafts(previous => ({ ...previous, [attachmentKey]: [...(previous[attachmentKey] || []), ...item.attachments] })); } catch (err) { setError(displayError(err)); } }
  async function signOut(id, name) { await act(`signout-${id}`, async () => { await api.invoke('provider.logout', { provider: id }); const next = await api.invoke('connections.refresh'); setData(previous => ({ ...previous, connections: next })); await refresh(); setNotice(`Signed out of ${name || 'this connection'}.`); }); }
  async function connect(id) { await act(`connect-${id}`, async () => { const result = await api.invoke('provider.connect', { provider: id }); if (result?.url || result?.authUrl) { const url = officialLoginUrl(result.url || result.authUrl, id); if (!url) throw new Error('The provider returned an unsupported sign-in address.'); setAuthLink({ url, provider: id, userCode: signInCode(result.userCode) }); } setNotice(result?.message || 'Continue in the provider’s sign-in window.'); const next = await api.invoke('connections.refresh'); setData(previous => ({ ...previous, connections: next })); }); }
  async function addMemory(event) { event.preventDefault(); if (!memoryDraft.trim() || byteCount(memoryDraft.trim()) > 280) return; await act('memory-add', async () => { const result = await api.invoke('memory.add', { text: memoryDraft.trim() }); setData(previous => ({ ...previous, memories: result })); setMemoryDraft(''); setAddingMemory(false); setMemoryQuery(''); setMemorySearchQuery(''); setMemoryResults(null); setNotice(isWeb ? 'Memory saved in your private workspace.' : 'Memory saved on this device.'); await refresh(); }); }
  function searchMemory(event) { event.preventDefault(); setMemorySearchQuery(memoryQuery.trim()); }
  async function reviewMemories(ids) {
    if (!ids.length) return;
    await act('memory-review', async () => {
      let memoryReview;
      for (let offset = 0; offset < ids.length; offset += 500) memoryReview = await api.invoke('memory.review', { ids: ids.slice(offset, offset + 500) });
      const reviewedIds = new Set(ids);
      const update = items => items.map(item => reviewedIds.has(item.id) ? { ...item, reviewed: true } : item);
      setData(previous => ({ ...previous, memoryReview, memories: update(previous.memories) }));
      setMemoryResults(previous => previous && (memoryFilter === 'new' ? previous.filter(item => !reviewedIds.has(item.id)) : update(previous)));
    });
  }
  async function viewAllMemories() {
    await act('memory-review', async () => {
      await api.invoke('memory.reviewAll');
      await refresh();
      setNotice('All saved memories marked as viewed.');
    });
  }
  async function respondApproval(approval, response) { await act('approval', async () => { await api.invoke('approval.respond', { id: approval.id, ...response }); setApprovals(previous => previous.filter(item => item.id !== approval.id)); }); }
  function openSettings(section) {
    setSettingsSection(section || 'general');
    setSettingsSelectionRequest(value => value + 1);
    navigate('settings');
    const request = ++settingsScrollRequest.current;
    // Deep links select the right category before scrolling its own content pane.
    const scroll = (tries = 0) => { if (request !== settingsScrollRequest.current) return; const target = document.getElementById(`settings-${section || 'general'}`), scroller = target?.closest('.settings-panel-scroll'); if (!scroller || !target.getClientRects().length) { if (tries < 30) setTimeout(() => scroll(tries + 1), 16); return; } const firstPanel = scroller.querySelector('.settings-panel:not([hidden])'); scroller.scrollTo({ top: firstPanel?.contains(target) ? 0 : scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16, behavior: 'auto' }); };
    // Timers also run when a hidden/background window is not producing frames.
    setTimeout(scroll, 0);
  }
  async function confirmChatDelete(item) {
    setConfirm({type:'chat',id:item.id,title:'Delete this conversation?',text:'This removes the conversation and its saved chat history. Choose whether to delete linked shared memories too.',deleteMemories:false,memoryLoading:true});
    try{const memoryStats=await api.invoke('conversations.memoryStats',{id:item.id});setConfirm(current=>current?.type==='chat'&&current.id===item.id?{...current,memoryStats,memoryLoading:false}:current);}
    catch(error){setConfirm(current=>current?.type==='chat'&&current.id===item.id?{...current,memoryLoading:false,memoryError:'Memory links could not be checked. You can still delete just the conversation.'}:current);}
  }
  async function deleteConfirmed() {
    await act('delete', async () => {
      if (confirm.type === 'memory' || confirm.type === 'note') {
        const result = await api.invoke(confirm.type === 'note' ? 'memory.delete' : 'memory.clear', confirm.type === 'note' ? { id: confirm.id } : {});
        setData(previous => ({ ...previous, memories: result }));
        setMemoryResults(previous => confirm.type === 'note' && previous ? previous.filter(item => item.id !== confirm.id) : null);
        setNotice(confirm.type === 'note' ? 'Memory deleted.' : 'Short notes cleared.');
        await refresh();
      } else {
        const result=await api.invoke('conversations.delete', { id: confirm.id,deleteMemories:confirm.deleteMemories===true });
        if(result?.memoryDeletionPending)setError(result.message);else setNotice(confirm.deleteMemories?`Conversation deleted; ${result?.deletedMemories||0} linked memories deleted.`:'Conversation deleted. Shared memories kept.');
        setDraft('', confirm.id);
        setAttachmentDrafts(previous => { const next = { ...previous }; delete next[confirm.id]; return next; });
        setData(previous => ({ ...previous, conversations: previous.conversations.filter(item => item.id !== confirm.id) }));
        if (selectedId === confirm.id) setSelectedId(null);
        setMemoryResults(null);await refresh();
      }
      setConfirm(null);
    });
  }

  const pageTitles = { chat: 'New chat', memory: 'Memory', tools: 'Tools & capabilities', connections: 'Connections', settings: 'Settings', workbench:'Projects & prompts', tutorials:'Tutorials' };
  const openExternal = url => act('external', () => api.invoke('app.openExternal', { url }));
  const openChatLink = url => {
    const link = parseChatLink(url);
    if (!isDesktop && link?.kind === 'web') { window.open(link.url, '_blank', 'noopener,noreferrer'); return; }
    if (link?.kind === 'web' && capabilities.nativeBrowser) { revealBrowser(); return act('chat-link', () => api.invoke('browser.navigate', { url: link.url, conversationId: browserConversationId })); }
    return act('chat-link', () => api.invoke('app.openLink', { url, conversationId: browserConversationId }));
  };
  const fileLinkContextMenu = event => {
    if (!isDesktop) return;
    const url = event.target.closest?.('.markdown a')?.getAttribute('href');
    if (parseChatLink(url)?.kind !== 'file') return;
    event.preventDefault(); event.stopPropagation();
    return act('chat-file-menu', () => api.invoke('app.fileLinkMenu', { url, conversationId: browserConversationId, x: event.clientX, y: event.clientY }));
  };
  // A direct click always shows the pane; automatic reveal only governs AI-driven navigation.
  const messageLink = useLatestCallback(openChatLink);
  const messageAsk = useLatestCallback(askAnother);
  const messageEdit = useLatestCallback((message, index) => setBranchEdit({ message, index, text: String(message.content || '') }));
  const messageBranch = useLatestCallback(branch);
  const messageSpeak = useLatestCallback(text => voice.speak(text));
  const messageFurther = useLatestCallback(insertTaskRequest);
  const messageCancelFollowup = useLatestCallback(id => act('followup-cancel', () => api.invoke('chat.followup.cancel', { conversationId: conversation.id, id })));
  const messageAnswer = useLatestCallback(answerQuestion);
  const messageContinue = useLatestCallback(continueQuestion);
  function navigateBrowserAddress(event) {
    event.preventDefault();
    if (!browserAddress.trim()) return;
    const input = event.currentTarget.querySelector('input');
    return act('browser-navigate', async () => {
      const url = browserAddressUrl(browserAddress);
      input?.blur(); browserAddressFocused.current = false; setBrowserAddress(url);
      await api.invoke('browser.navigate', { url, conversationId: browserConversationId });
    });
  }
  const openUsagePage = provider => act('usage-page', async () => { const url = provider === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : provider === 'muse-code' ? 'https://accountscenter.meta.com/' : 'https://claude.ai/settings/usage'; setBrowserOpen(true); await api.invoke('browser.navigate', { url, conversationId: browserConversationId }); });
  const refreshUsageDetails = () => api.invoke('usage.refresh', { details: true }).then(usage => setData(previous => ({ ...previous, usage })));
  const useResetCredit = (provider, creditId) => api.invoke('usage.resetCredit', { provider, ...(typeof creditId === 'string' ? { creditId } : {}) });

  const windowToolbar = hasWindowHeader(data.window);
  const toolbarTitle = <div className="topbar-title"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><span className={`topbar-heading ${page === 'chat' && conversation && titlesPending.includes(conversation.id) ? 'is-naming' : ''}`} title={page === 'chat' && conversation ? conversation.title : undefined}>{page === 'chat' && privateChat ? 'Temporary chat' : page === 'chat' && conversation ? conversation.title : pageTitles[page]}</span>{page === 'chat' && conversation && <span className="topbar-provider">{providers[activeProvider]?.name}</span>}</div>;
  const toolbarActions = <div className="topbar-actions">{page==='chat'&&<HudToggle hidden={hudHidden} onToggle={()=>{setHudHidden(value=>!value);setTimeout(()=>composerRef.current?.focus({preventScroll:true}),0);}}/>}<InterfaceView compact view={interfaceView} onChange={chooseInterfaceView}/>{isDesktop&&<UpdateButton onOpen={()=>openSettings('updates')}/>}{page==='chat'&&conversation&&pendingQuestionGroups.length>0&&<button type="button" className="secondary-button question-popup-trigger" aria-label="Answer questions" onClick={()=>questionSession.open(pendingQuestionGroups[0].id)}><MessageSquare size={14}/>Your input ({pendingQuestionGroups.length})</button>}{page==='chat'&&conversation&&<div className="chat-jump-buttons"><button aria-label="Scroll to top of chat" onClick={()=>jumpChat(false)}><ArrowUp size={12}/><span>Top</span></button><button aria-label="Scroll to bottom of chat" onClick={()=>jumpChat(true)}><ArrowDown size={12}/><span>Bottom</span></button></div>}{isWeb && <span className="local-indicator"><span className="status-dot" />{runtime.executor?.label || 'Private server'}</span>}{isDesktop && !privateChat && page === 'chat' && effectivePermission === 'full' && <button className="elevated-pill" onClick={() => openSettings('permissions')} title={chatPermission ? 'This chat can act without asking. Change it from the shield in the message box.' : 'Agents can act without asking by default. Click to review.'}><ShieldAlert size={14} />Full access</button>}{isDesktop && !privateChat && page === 'chat' && effectivePermission === 'read-only' && <button className="readonly-pill" onClick={() => openSettings('permissions')} title={chatPermission ? 'This chat can only read. Change it from the shield in the message box.' : 'Agents can only read by default. Click to change.'}><Eye size={14} />Read only</button>}{data.sync?.enabled && <button className={`topbar-sync ${data.sync.state || 'disconnected'}`} onClick={() => navigate('settings')} title={data.sync.error || syncLabel(data.sync)}>{syncLabel(data.sync)}</button>}{capabilities.nativeBrowser && !privateChat && <button className={`browser-toggle ${browserPanelOpen ? 'active' : ''}`} onClick={() => chooseBrowserVisibility(!browserPanelOpen)} aria-pressed={browserPanelOpen} title="Open embedded browser"><Globe2 size={15} /><span>Browser</span></button>}{page === 'chat' && conversation && <button ref={chatFindButton} className="icon-button chat-find-trigger" aria-label="Find in this chat" title="Find in this chat (Ctrl+F)" aria-expanded={chatFindOpen} onClick={() => chatFindOpen ? closeChatFind() : setChatFindOpen(true)}><Search size={17} /></button>}{page === 'chat' && conversation && !privateChat && <DataExport compact conversationId={conversation.id} onModalChange={setProviderModalVisible} onNotice={setNotice} />}</div>;
  const workflowBrowserPanel=<aside id="browser-panel" className="browser-panel" aria-label="Embedded browser"><div className="browser-panel-heading"><span><Globe2 size={15} /><strong>{browserInfo.external ? 'My browser' : 'Browser'}</strong></span><div><span className="browser-shared-tag">This chat</span><button className="icon-button" title="Open in default browser" aria-label="Open page in default browser" disabled={!browserInfo.url || browserInfo.url === 'about:blank'} onClick={() => openExternal(browserInfo.url)}><ExternalLink size={14} /></button><button className="icon-button" aria-label="Close embedded browser" onClick={() => chooseBrowserVisibility(false)}><X size={17} /></button></div></div>{!browserInfo.external && <BrowserTabs info={browserInfo} onNew={() => act('browser-tab', () => api.invoke('browser.tab.new', { conversationId: browserConversationId }))} onSelect={tabId => act('browser-tab', () => api.invoke('browser.tab.select', { tabId, conversationId: browserConversationId }))} onClose={tabId => act('browser-tab', () => api.invoke('browser.tab.close', { tabId, conversationId: browserConversationId }))} />}<form className="browser-toolbar" onSubmit={navigateBrowserAddress}><button type="button" className="icon-button" aria-label="Go back" disabled={!browserInfo.canGoBack} onClick={() => act('browser-back', () => api.invoke('browser.back', { conversationId: browserConversationId }))}><ArrowLeft size={15} /></button><button type="button" className="icon-button" aria-label="Go forward" disabled={!browserInfo.canGoForward} onClick={() => act('browser-forward', () => api.invoke('browser.forward', { conversationId: browserConversationId }))}><ArrowRight size={15} /></button><button type="button" className="icon-button" aria-label={browserInfo.loading ? 'Stop loading page' : 'Reload page'} title={browserInfo.loading ? 'Stop loading page' : 'Reload page'} onClick={() => act('browser-load-control', () => api.invoke(browserInfo.loading ? 'browser.stop' : 'browser.reload', { conversationId: browserConversationId }))}>{browserInfo.loading ? <Square size={13} /> : <RefreshCw size={14} />}</button><div className="browser-address"><Globe2 size={12} /><input aria-label="Browser address" placeholder="Search Google or enter an address" value={browserAddress} onChange={event => setBrowserAddress(event.target.value)} onFocus={event => { browserAddressFocused.current = true; event.target.select(); }} onBlur={() => { browserAddressFocused.current = false; }} /><button type="submit" aria-label="Search or navigate"><ArrowRight size={13} /></button></div></form><div className="browser-host" ref={browserHostRef}>{browserLayout.resizing && !browserInfo.external && <div className="browser-resize-preview">Resizing browser...</div>}{browserInfo.external && <div className="connected-browser-info"><strong>{browserInfo.connected ? 'Working in your browser' : 'Browser disconnected'}</strong><p>{browserInfo.connected ? 'This chat uses its own tab in your connected Chrome or Edge profile. Continue sign-ins there. Website actions and page reads still use Exomina’s permissions.' : 'Open the Exomina extension in your browser to reconnect, or choose the built-in browser in Tools.'}</p><button className="text-button" onClick={() => navigate('tools')}>Browser connection settings</button></div>}{!api && <EmptyState icon={Globe2} title="Open the desktop app to browse">The embedded browser runs in the desktop app. Enable browser tools to let your selected provider use it.</EmptyState>}</div><div className="browser-footer"><span className="status-dot" /><span>{browserInfo.error || (browserInfo.loading ? (browserInfo.pageReady ? 'Page ready; loading extras…' : 'Loading…') : browserInfo.title && browserInfo.title !== 'Browser' ? browserInfo.title : 'Browser for this chat')}</span><button onClick={() => navigate('tools')}>Tool controls <Settings2 size={11} /></button></div></aside>;
  const workflowPanels={
    browser:workflowBrowserPanel,
    notes:<Scratchpad embedded disabled={privateChat} connections={data.connections} providers={data.providers||[]} projects={data.workbench?.projects||[]} workspace={settings.workspace} onOpenChat={async id=>{window.focus();await refresh();await selectConversation({id});}} onInsert={text=>{window.focus();setDraft(current=>current.trim()?current+'\n\n'+text:text);setNotice('Note text added to your next message.');setTimeout(()=>composerRef.current?.focus({preventScroll:true}),0);}}/>,
    terminal:conversation&&!privateChat?<TerminalPanel conversationId={conversation.id} messages={visibleMessages} running={running} onStopAgent={cancel} onClose={()=>workflow.hide('terminal')}/>:<p className="workflow-panel-message">Open a saved chat to use its command console. Commands follow that chat’s permissions.</p>,
    workbench:<Workbench standard={standardView} onView={chooseInterfaceView} value={data.workbench} conversations={savedConversations} catalog={catalog.filter(p=>['subscription','local'].includes(p.mode)&&providerReady(data.connections.find(c=>c.id===p.id)))} messaging={data.messaging} refresh={refresh} onOpen={item=>{window.focus();selectConversation(item);}} onNew={(...args)=>{window.focus();newChat(...args);}} onPrompt={prompt=>{window.focus();insertPrompt(prompt);}}/>,
  };
  const workflowToolbarActions=<>{toolbarActions}<WorkspaceMap open={workspaceMapOpen} onChange={setWorkspaceMapOpen} desktop={isDesktop} privateChat={privateChat} canBrowse={capabilities.nativeBrowser} localFiles={capabilities.localFiles} settings={settings} onPrompt={addExplorePrompt} onNavigate={navigate} onSettings={openSettings} onNotes={()=>{navigate('chat');if(workflow.active)workflow.show('notes');else setNotesOpenRequest(true);}}/><WorkflowControls workspace={workflow}/></>;
  return <InterfaceViewContext.Provider value={interfaceView}><QuestionDraftContext.Provider value={questionSession}><><a className="skip-content" href="#main-content" onClick={event=>{event.preventDefault();document.getElementById('main-content')?.focus();}}>Skip to main content</a><div data-interface-view={interfaceView} data-hud={hudActive ? 'hidden' : undefined} data-hud-peek={hudPeek ? 'true' : undefined} className={`app-frame ${windowToolbar ? 'has-window-toolbar' : ''}`}><WindowHeader state={data.window} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} onHome={newChat}>{toolbarTitle}{workflowToolbarActions}</WindowHeader><div ref={browserLayout.shellRef} style={{ '--browser-width': `${browserLayout.width}px` }} data-browser-overlay={browserLayout.overlay ? 'true' : undefined} className={`app-shell ${isWeb ? 'web-app' : 'desktop-app'} ${!workflow.active && browserOpen && capabilities.nativeBrowser ? 'browser-open' : ''} ${browserLayout.resizing || workflow.resizing ? 'browser-resizing' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'expanded' : ''}`}>
      <button className="brand" onClick={newChat} aria-label="Exomina home"><Logo /><span>Exomina</span></button>
      <div className="new-chat-actions"><button className="new-chat-button" onClick={newChat}><Plus size={17} /><span>New chat</span><kbd>Ctrl N</kbd></button>{isDesktop&&<button type="button" className="temporary-chat-start" title="Start a temporary text-only chat" aria-label="Start temporary chat" aria-pressed={privateChat} onClick={()=>newChat('',true)}><Eye size={16}/></button>}</div>
      {standardView && !privateChat && <button type="button" className="standard-task-start" onClick={openTaskSetup}><Sparkles size={14}/>Start a task</button>}<SidebarNav items={navigation.filter(item=>isDesktop||!['workbench','storage'].includes(item.id))} page={page} onNavigate={navigate} newMemoryCount={newMemoryCount} needsConnection={data.connections.length>0&&!data.connections.some(providerReady)} />
      <ChatSidebar onSearch={data.libraryCompact?searchLibrary:undefined} titlesPending={titlesPending} onRetitle={item => updateConversation('conversations.retitle', { id: item.id })} conversations={savedConversations} selectedId={page === 'chat' ? selectedId : null} activeIds={runningIds} unreadIds={unread} onSelect={selectConversation} onUpdate={updateConversation} onModalChange={setChatModalVisible} onDelete={confirmChatDelete} />
      <DraftPresence store={draftStore} draftKey={draftKey}>{hasDraft => <Companion appearance={appearance} name={settings.personalization?.soul?.name || 'Vesper'} working={runningIds.length > 0} needsInput={approvals.length > 0 || pendingQuestionGroups.length > 0} voice={voice} reply={visibleMessages.filter(m=>m.role==='assistant').at(-1)?.content||''} canTalk={isDesktop&&page==='chat'&&!privateChat&&!running&&!hasDraft&&!draftAttachments.length&&!uploading&&transportOnline&&canUseConnection(connection)&&!selectedId?.startsWith('pending-')} onTalk={isDesktop?()=>voice.active?voice.stop():voice.start('conversation'):undefined} onNeedsInput={()=>{navigate('chat');if(pendingQuestionGroups.length)questionSession.open(pendingQuestionGroups[0].id);else if(approvals[0]?.conversationId)selectConversation({id:approvals[0].conversationId});}} onCustomize={() => openSettings('personalization')} onHide={() => saveAppearance({ companionEnabled: false })} />}</DraftPresence>
      {isDesktop && !standardView && conversation && !privateChat && <button type="button" className="nav-item" aria-pressed={workflow.active?workflow.hasPanel('terminal'):terminalOpen} onClick={() => { setPage('chat'); if(workflow.active){if(workflow.hasPanel('terminal'))workflow.hide('terminal');else workflow.show('terminal');}else setTerminalOpen(value => !value); }}><Terminal size={17} /><span>Terminal</span></button>}
      <div className="sidebar-bottom">{isDesktop && <UsageSidebar resetPending={data.usageResetPending} connections={data.connections} usage={data.usage} onRefresh={refreshUsageDetails} onReset={useResetCredit} onManage={openUsagePage} onDetails={() => openSettings('usage')} />}<button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={17} strokeWidth={1.65} /><span>Settings</span>{data.version && <span className="version">v{data.version}</span>}</button>{isWeb && <div className="sidebar-status" title="Chats and memory are stored on your private server."><span className="status-dot" /><span>{session.displayName || 'Private workspace'}</span></div>}</div>
    </aside>

    <WorkflowWorkspace workspace={workflow} panels={workflowPanels}><main id="main-content" tabIndex={-1} className="main-shell" onContextMenu={fileLinkContextMenu}>
      <MatrixRain appearance={appearance} />
      {!windowToolbar && <header className="topbar">{toolbarTitle}{workflowToolbarActions}</header>}

      {isWeb && !transportOnline && <div className="connection-banner" role="status"><CloudIcon /><span>Connection interrupted. Reconnecting to your private server…</span></div>}
      {error && <div className="feedback error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      {page === 'chat' && conversation?.archived && <div className="archived-chat-banner"><span>This chat is archived.</span><button onClick={() => updateConversation('conversations.archive', { id: conversation.id, archived: false }).catch(() => {})}>Restore chat</button></div>}
      {authLink && <div className="provider-auth-banner" role="status"><KeyRound size={16} /><div><strong>Continue {providers[authLink.provider]?.name || 'provider'} sign-in</strong><p>Open the official sign-in page, then return here.</p>{authLink.userCode && <div className="provider-auth-device"><span>Enter this code on the sign-in page:</span><code aria-label="Sign-in code" tabIndex={0}>{authLink.userCode}</code></div>}<a href={authLink.url} target="_blank" rel="noopener noreferrer">Open provider sign-in <ExternalLink size={13} /></a></div><button className="icon-button" aria-label="Dismiss provider sign-in" onClick={() => setAuthLink(null)}><X size={16} /></button></div>}
      {notice && <div className="toast" role="status"><Check size={17} /><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
      {loading ? <div className="loading-page"><Logo /><Spinner size={20} /><span>Opening your workspace…</span></div> : <>

      {page === 'chat' && <div className={`chat-page ${conversation ? 'has-conversation' : 'is-home'} ${privateChat ? 'is-private' : ''} ${taskSetup ? 'is-task-setup' : ''}`}>
        {privateChat && <div className="temporary-chat-banner" role="status"><Eye size={16}/><div><strong>Temporary chat · text only</strong><p>Exomina saves no chat history or memories. Leaving this chat discards it. Tools, uploads and voice are off.</p><p>Messages still go to {providers[activeProvider]?.name || 'your provider'}. Training and retention follow its own settings.</p>{!temporarySupported(activeProvider)&&<p>Choose ChatGPT, Claude or an API connection. Temporary mode is unavailable for this client.</p>}</div><button type="button" className="text-button" onClick={()=>newChat()}>End temporary chat</button></div>}
        {conversation && chatFindOpen && <ChatFind key={conversation.id} messages={visibleMessages} query={chatFindQuery} onQuery={value => { cancelChatHitScroll(); pendingChatHit.current = null; setChatFindQuery(value); setChatFindHit(null); }} onHit={showChatHit} onClose={closeChatFind} />}
        <div className="chat-scroll" key={`scroll:${selectedId || 'new'}`} ref={scrollRef} onScroll={onChatScroll}>
          {taskSetup && !conversation && !privateChat ? <TaskStart initial={draftTask || taskSetupDraft || {projectId:draftProject}} onSetupChange={setTaskSetupDraft} attachments={draftAttachments} onAddFiles={addAttachments} onRemoveFile={id=>setAttachmentDrafts(previous=>({...previous,[attachmentKey]:draftAttachments.filter(item=>item.uploadId!==id)}))} uploading={uploading} projects={data.workbench?.projects} onChooseFolder={chooseTaskFolder} catalog={pickerCatalog} provider={activeProvider} model={activeModel} usage={data.usage} permissionLabel={modeInfo(data.permissionModes,effectivePermission).label} providerName={providers[activeProvider]?.name || 'AI'} ready={canUseConnection(connection)} canUseConnection={canUseConnection} connections={data.connections} onPickProvider={pickProvider} settings={settings} capabilities={capabilities} onControls={()=>navigate('tools')} onConnections={()=>navigate('connections')} onCancel={()=>{setTaskSetup(false);setTaskSetupDraft(null);}} onReview={reviewTask}/> : !conversation ? !privateChat && !draftTask && (standardView ? <StandardHome onTutorials={()=>navigate('tutorials')} connections={data.connections} conversations={savedConversations} onConnections={()=>navigate('connections')} onControls={()=>navigate('tools')} Logo={Logo} live={savedConversations.filter(chat => runningIds.includes(chat.id))} onStart={openTaskSetup} onOpen={selectConversation} onImport={capabilities.localFiles ? importChats : undefined} onIdea={insertPrompt} importing={busyAction === 'archive-import'}/> : <WelcomeHero connections={data.connections} onConnections={()=>navigate('connections')} onControls={()=>navigate('tools')} onTask={openTaskSetup} onTutorials={()=>navigate('tutorials')} onTip={(id,step)=>{setTutorial(id);setTutorialStep(step);}} Logo={Logo} conversations={savedConversations} runningIds={runningIds} onOpen={selectConversation} />) : <div className="messages" aria-live="polite" aria-relevant="additions text"><ChatMessageList messages={visibleMessages} defaultProvider={conversation.provider} providers={providers} running={running} hit={chatFindHit} hud={hudActive} temporary={privateChat} catalog={pickerCatalog} connections={data.connections} query={chatFindOpen ? chatFindQuery : ''} onLink={messageLink} onAsk={messageAsk} onEdit={messageEdit} onBranch={messageBranch} onSpeak={messageSpeak} onFollowupCancel={messageCancelFollowup} onQuestionAnswer={messageAnswer} onQuestionContinue={messageContinue} onFurther={messageFurther} />{running && visibleMessages.at(-1)?.role === 'user' && <div className="stream-status"><span className="thinking-dots"><i /><i /><i /></span><span>Starting {providers[activeProvider]?.name || 'the AI'}…</span></div>}
            {queues[selectedId]?.length > 0 && <div className="queued-list" aria-label="Follow-ups waiting">{queues[selectedId].map(item => <div className="queued-item" key={item.id}><div><p>{item.text}</p><MessageFiles attachments={item.attachments} />{item.attachments?.some(file => file.kind === 'image') && <small>{item.attachments.filter(file => file.kind === 'image').length} image(s) attached</small>}<small>Queued · sends when the current reply finishes</small></div><button type="button" className="icon-button" aria-label="Remove this follow-up" title="Remove (puts the text back in the message box if it is empty)" onClick={() => unqueue(item)}><X size={14} /></button></div>)}</div>}</div>}
        </div>
        {!taskSetup && <div className="composer-region">
          {!privateChat&&conversation?.approachRefinements?.length>0&&<TaskRefinements records={conversation.approachRefinements}/>}
          {!privateChat && (conversation?.taskGuide || (!conversation && draftTask)) && <TaskActions key={conversation?.id || 'task-draft'} guide={conversation?.taskGuide || draftTask} draft={!conversation} messages={visibleMessages} running={running} onEdit={()=>setTaskSetup(true)} onCheck={()=>insertTaskRequest(CHECK_TASK_REQUEST)} onRepeat={()=>insertTaskRequest(REPEAT_TASK_REQUEST)} onSave={saveTaskPrompt} onModalChange={setTaskPromptVisible}/>}
          {pendingApproval && <ApprovalCard approval={pendingApproval} count={approvals.length} busy={busyAction === 'approval'} onRespond={response => respondApproval(pendingApproval, response)} chatTitle={pendingApproval.conversationId && pendingApproval.conversationId !== selectedId ? data.conversations.find(item => item.id === pendingApproval.conversationId)?.title : null} onOpenChat={() => { const chat = data.conversations.find(item => item.id === pendingApproval.conversationId); if (chat) selectConversation(chat); }} />}
          {!canUseConnection(connection) && api && <div className="connect-hint">{connection?.checking ? <Spinner size={14} /> : <KeyRound size={14} />}<span>{connection?.checking ? connection.detail || 'Checking private account storage…' : connection?.available === false || (isWeb && ['subscription', 'local'].includes(providers[activeProvider]?.mode) && connection?.available !== true) ? connection?.unavailableReason || 'This provider is unavailable on this host.' : `Set up ${providers[activeProvider]?.name || 'this provider'} to send a message.`}</span>{!connection?.checking && <button onClick={() => navigate('connections')}>Connect <ArrowRight size={13} /></button>}</div>}
          {hudActive && running && <HudPulse label={providers[activeProvider]?.name || 'Your AI'} />}
          <UsageBanner provider={activeProvider} usage={data.usage} onSwitch={() => setModelOpen(true)} />
          <ComposerDraft store={draftStore} draftKey={draftKey} composerRef={composerRef}>{(draft, composerSize) => {
            const suggestion = draft ? '' : nextPrompt;
            return <form className={`composer ${running ? 'is-running' : ''}`} onSubmit={sendMessage} onDragOver={event => { if (isDesktop && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }} onDrop={event => { if (isDesktop && event.dataTransfer.files.length) { event.preventDefault(); addAttachments(event.dataTransfer.files); } }}>
            {!privateChat && <PromptSuggestions draft={draft} prompts={data.workbench?.prompts} onPick={insertPrompt}/>}{!privateChat && <AmbitionBar key={attachmentKey} draft={draft} disabled={!api} onChange={text => setDraft(text)}/>}<AttachmentDraft attachments={draftAttachments} onRemove={id => setAttachmentDrafts(previous => ({ ...previous, [attachmentKey]: draftAttachments.filter(item => item.uploadId !== id) }))} />
            {uploading && <div className="attachment-uploading" role="status">Adding attachments...</div>}
            <input ref={fileInput} type="file" multiple hidden onChange={event => { addAttachments(event.target.files); event.target.value = ''; }} />
            <div className={`composer-resize ${composerSize.manual ? 'is-manual' : ''}`} {...composerSize.handleProps} />
            <textarea ref={composerRef} aria-label="Message" aria-description={suggestion ? 'Suggested next message: ' + suggestion + '. Press Tab to use it, Escape to dismiss.' : undefined} className={suggestion ? 'has-suggestion' : undefined} placeholder={suggestion ? suggestion + '   ⇥ Tab' : running ? (isDesktop ? 'Ask a question while work continues…' : 'Add a follow-up for after this reply…') : `Message ${providers[activeProvider]?.name || 'your AI'}…`} value={draft} rows={conversation ? 2 : 3} disabled={!api} spellCheck={settings.spellcheck?.enabled !== false} onPaste={pasteAttachments} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (suggestion && !event.shiftKey && (event.key === 'Tab' || event.key === 'ArrowRight')) { event.preventDefault(); setDraft(suggestion); return; } if (suggestion && event.key === 'Escape') { event.preventDefault(); setDismissedPrompt(lastReply.id); return; } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage(); } }} />
            <div className="composer-toolbar">
              {isDesktop&&!workflow.active&&<Scratchpad disabled={privateChat} openRequest={notesOpenRequest} onOpenHandled={()=>setNotesOpenRequest(false)} onOpenChange={setNotesOpen} portalTarget={browserPanelOpen?notesPortalTarget:null} relocationRef={notesRelocationRef} connections={data.connections} providers={data.providers||[]} projects={data.workbench?.projects||[]} workspace={settings.workspace} onOpenChat={async id=>{await refresh();await selectConversation({id});}} onInsert={text=>{setDraft(current=>current.trim()?current+'\n\n'+text:text);setTimeout(()=>composerRef.current?.focus({preventScroll:true}),0);}}/>}{isDesktop&&workflow.active&&<button type="button" className="composer-chip" aria-label="Open workspace notes" onClick={()=>workflow.show('notes')}><StickyNote size={14}/><span>Notes</span></button>}
              {isDesktop && !privateChat && <VoiceControls api={api} voice={voice} settings={settings.voice} onVoiceChange={realtimeVoice=>saveSettings({voicePatch:{realtimeVoice}})} onSampleSoundChange={previewTone=>saveSettings({voicePatch:{previewTone}})} canDictate={!uploading && !selectedId?.startsWith('pending-')} canRealtime={activeProvider==='codex'&&!running&&!draft.trim()&&!draftAttachments.length&&!uploading&&transportOnline&&canUseConnection(connection)&&!selectedId?.startsWith('pending-')} canTalk={!running && !draft.trim() && !draftAttachments.length && !uploading && transportOnline && canUseConnection(connection) && !selectedId?.startsWith('pending-')} openSettings={openSettings} />}
              {isDesktop&&!privateChat&&!!data.workbench?.projects?.length&&<label className="composer-chip project-selector"><Folder size={13}/><select aria-label="Chat project" value={conversation?.projectId||draftProject} disabled={running} onChange={e=>conversation?act('project',async()=>{await api.invoke('projects.assign',{id:conversation.id,projectId:e.target.value});await refresh();}):setDraftProject(e.target.value)}><option value="">No project</option>{data.workbench.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}{isDesktop && !privateChat && <button type="button" className="composer-chip attach-button" aria-label="Attach files" title="Attach files (up to 10, 20 MiB total), or paste a screenshot" disabled={uploading || !settings.workspace} onClick={() => fileInput.current?.click()}><Paperclip size={15} /><span className="standard-chip-label">Files</span></button>}
              {capabilities.localFiles && !privateChat && <button type="button" className={`composer-chip workspace-chip ${settings.workspace ? 'has-workspace' : ''}`} aria-label="Workspace" title={displayWorkspace ? `Project folder: ${displayWorkspace}` : 'Choose a project folder'} disabled={anyRunning || busyAction === 'workspace'} onClick={currentProject?()=>act('workspace',async()=>{await api.invoke('projects.folder',{id:currentProject.id});await refresh();}):chooseWorkspace}><Folder size={14} /><span>{folderLabel(displayWorkspace)}</span></button>}
              {!privateChat && <button type="button" className={`composer-chip memory-chip ${settings.memoryEnabled ? 'on' : ''}`} aria-label="Shared memory" title={settings.memoryEnabled ? 'Shared memory is on: relevant notes are sent with your message. Click to turn off.' : 'Shared memory is off. Click to turn on.'} onClick={() => saveSettings({ memoryEnabled: !settings.memoryEnabled })} aria-pressed={!!settings.memoryEnabled}><Brain size={14} /><span>Memory</span></button>}
              {!privateChat && <span className="advanced-only"><ChatStyle chat={conversation && !String(conversation.id).startsWith('pending-') ? conversation : null} defaultTone={settings.personalization?.tone} onManage={() => openSettings('personalization')} onChange={personalization => act('chat-style', async () => { const result = await api.invoke('conversations.personalize', { id: conversation.id, personalization }); setData(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === result.id ? { ...item, personalization: result.personalization } : item) })); })} /></span>}
              {isDesktop && !privateChat && <PermissionPicker modes={data.permissionModes} own={chatPermission} defaultMode={settings.permissionMode} running={running} disabled={busyAction === 'chat-permission' || !!selectedId?.startsWith('pending-')} onChange={setChatPermission} onManage={() => openSettings('permissions')} />}

              {providers[activeProvider]?.mode !== 'subscription' && <span className={`provider-mode-indicator ${providers[activeProvider]?.mode || ''}`}>{providers[activeProvider]?.mode === 'api' ? 'API' : 'Local'}</span>}
              <div className="model-selector" ref={modelArea}><button type="button" className="composer-chip model-chip" aria-label={standardView ? "Choose AI" : "Choose AI, model and effort"} onClick={() => setModelOpen(!modelOpen)} aria-expanded={modelOpen} aria-haspopup="dialog" title={`${providers[activeProvider]?.name} · ${modelText(availableModels, activeModel)}${activeEffort ? ` · ${effortText(selectedModel?.efforts, activeEffort)}` : ''}`}><ProviderMark provider={activeProvider} info={providers[activeProvider]} small />{standardView ? <><span>{providers[activeProvider]?.name || 'AI'}{!['auto', 'default'].includes(activeModel) ? ` · ${modelText(availableModels, activeModel)}` : ''}</span>{activeEffort && effortTierLabel(selectedModel?.efforts, activeEffort) && <span className="chip-sub">{effortTierLabel(selectedModel?.efforts, activeEffort)}</span>}</> : <><span>{activeModel === 'auto' ? `${providers[activeProvider]?.name} · Default` : modelText(availableModels, activeModel)}</span>{activeEffort && <span className="chip-sub">{effortText(selectedModel?.efforts, activeEffort)}</span>}</>}{activeSpeedOption && <span className={`chip-speed ${activeSpeedOption.paid ? 'paid' : ''}`} title={activeSpeedOption.description || activeSpeedOption.label}><Zap size={11} />{activeSpeedOption.label}</span>}<ChevronDown size={12} className="chip-caret" /></button>{modelOpen && <ModelPicker standard={standardView} onAdvanced={()=>chooseInterfaceView("advanced")} native={providers[activeProvider]?.mode === 'subscription'} models={availableModels} model={activeModel} effort={activeEffort} onModel={saveModel} onEffort={saveEffort} speed={activeSpeed} onSpeed={saveSpeed} paidSpeedConfirmed={!!settings.claudeFastConfirmed} onConfirmPaidSpeed={() => saveSettings({ claudeFastConfirmed: true })} routing={settings.routing || 'auto'} onRouting={!privateChat && ['codex', 'claude'].includes(activeProvider) ? routing => saveSettings({ routing }) : undefined} onClose={closeModelPicker} catalog={privateChat ? pickerCatalog.filter(item => temporarySupported(item.id)) : conversation && !pickerCatalog.some(item => item.id === activeProvider) ? [...pickerCatalog, providers[activeProvider]].filter(Boolean) : pickerCatalog} preferences={modelPreferences} onOptions={() => { closeModelPicker(); openSettings('models'); }} connections={data.connections} provider={activeProvider} onProvider={pickProvider} onManage={() => { navigate('connections'); closeModelPicker(); }} />}</div>
              {running && <button className="send-button stop" type="button" title="Stop this reply" aria-label="Stop this reply" onClick={cancel} disabled={busyAction === 'cancel'}><Square size={12} fill="currentColor" /></button>}{(!running || draft.trim() || draftAttachments.length > 0) && <button className={`send-button ${running ? 'queue' : ''}`} type="submit" title={running ? (isDesktop ? 'Send follow-up now (Enter)' : 'Queue follow-up (Enter)') : 'Send (Enter)'} aria-label={running ? (isDesktop ? 'Send follow-up' : 'Queue follow-up') : 'Send message'} disabled={(!draft.trim() && !draftAttachments.length) || uploading || !transportOnline || !canUseConnection(connection) || (privateChat && !temporarySupported(activeProvider)) || (!conversation && !pickerCatalog.length) || !!selectedId?.startsWith('pending-')}>{running ? <MessageSquare size={16} strokeWidth={2.2} /> : <ArrowUp size={18} strokeWidth={2.2} />}</button>}
            </div>
          </form>; }}</ComposerDraft>
          {isDesktop && !privateChat && <VoiceStatus voice={voice} />}
          {!conversation && !privateChat && !draftTask && <Welcome standard={standardView} catalog={pickerCatalog} connections={data.connections} selected={activeProvider} models={Object.fromEntries(catalog.map(item => [item.id, item.id === activeProvider && activeModel && activeModel !== 'auto' ? modelText(data.providerModels?.[item.id] || [], activeModel) : '']).filter(([, label]) => label))} onPick={pickProvider} onManageModels={() => openSettings('models')} onSuggest={text => { setDraft(text); setTimeout(() => { composerRef.current?.focus({ preventScroll: true }); composerRef.current?.setSelectionRange(text.length, text.length); }, 0); }} onNavigate={navigate} conversations={savedConversations} runningIds={runningIds} onOpen={selectConversation} />}
          {<div className="composer-caption"><span className="privacy-caption">{privateChat ? `Temporary on this device. Messages go to ${providers[activeProvider]?.name || 'your provider'}; its training and retention settings apply.` : `Messages${settings.memoryEnabled ? ' and recalled memories' : ''} are sent to ${providers[activeProvider]?.name || 'your provider'}. ${privacy?.summary || 'Its training and retention policy applies.'}`}</span><span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span></div>}
        </div>}
      </div>}

      {page === 'memory' && <div className="content-page memory-page">
        <button className="text-button" onClick={() => openSettings('memory')}><ArrowLeft size={14} />Back to Settings</button>
        <div className="page-heading"><div><div className="eyebrow">SHARED MEMORY</div><h1>Keep the useful context</h1><p>Memory works in the background. You can inspect or change saved notes here whenever you need to.</p></div><button className="primary-button" onClick={() => setAddingMemory(true)}><Plus size={16} />Add a memory</button></div>
        <div className="memory-overview"><div className="memory-overview-art"><Brain size={31} strokeWidth={1.2} /></div><div><h3>{!settings.memoryEnabled ? 'Memory is off for chats' : settings.memoryCapture === 'ask' ? 'Review new memories before they are saved' : 'Useful details, saved as you chat'}</h3><p>{!settings.memoryEnabled ? 'Your existing notes are kept. Turn memory on in Settings to use them in new requests.' : settings.memoryCapture === 'ask' ? 'Your AI asks before adding a note. You can also add, review, and delete notes here.' : 'Your AI can keep useful, lasting details without asking each time. Repeated notes are skipped. Review or delete saved notes below.'} {settings.memoryEnabled && 'Relevant notes are shared with the AI you are using.'}</p></div><span className="tag mint">{data.memories.length} short {data.memories.length === 1 ? 'note' : 'notes'}</span></div>
        <MemoryCaptureControl value={settings.memoryCapture} onChange={value => saveSettings({ memoryCapture: value })} disabled={busyAction === 'settings'} />
        {isDesktop&&<ChatMemorySettings settings={settings} status={data.chatMemory} models={data.providerModels} connections={data.connections} onChange={saveSettings} disabled={busyAction==='settings'} />}
        <div className="section-title local-notes-heading"><h2>Short notes</h2></div>
        <div className="memory-review-toolbar">
          <div className="memory-filters" role="group" aria-label="Filter memories"><button aria-pressed={memoryFilter === 'all'} onClick={() => setMemoryFilter('all')}>All notes</button><button aria-pressed={memoryFilter === 'new'} onClick={() => setMemoryFilter('new')}>New{newMemoryCount > 0 && <span>{newMemoryCount}</span>}</button></div>
          <button className="text-button memory-review-all" disabled={!!busyAction || newMemoryCount === 0} title="Marks every saved memory as viewed, including other pages and notes outside this search" onClick={viewAllMemories}>{busyAction === 'memory-review' ? <Spinner size={14} /> : <Check size={14} />}Mark all as viewed</button>
        </div>
        <div className="section-toolbar"><form className="search-field" onSubmit={searchMemory}><Search size={16} /><input value={memoryQuery} onChange={event => { setMemoryQuery(event.target.value); if (!event.target.value) { setMemorySearchQuery(''); setMemoryResults(null); } }} placeholder="Search short notes…" aria-label="Search memories" /><button type="submit" className="search-submit" disabled={memorySearching}>{memorySearching ? <Spinner size={14} /> : <ArrowRight size={15} />}</button></form>{capabilities.localFiles && <button className="text-button" onClick={() => act('memory-export', async () => { const result = await api.invoke('memory.export'); if (result?.path) setNotice(`Exported to ${result.path}`); })}><Download size={15} />Export</button>}<button className="text-button advanced-only" onClick={() => act('memory-wake', async () => { const result = await api.invoke('memory.wake'); if (result?.error) throw Error(result.detail || 'Memory context could not be read.'); setWakeResult(result); })}>{busyAction === 'memory-wake' ? <Spinner size={15} /> : <Layers3 size={15} />}View context</button></div>
        {memories.length ? <MemoryNotes key={`${memoryFilter}:${memorySearchQuery}`} memories={memories} busyAction={busyAction} searching={memorySearching} isWeb={isWeb} dateLabel={dateLabel} byteCount={byteCount} onReview={reviewMemories} onDelete={memory => setConfirm({ type: 'note', id: memory.id, title: 'Delete this memory?', text: 'This removes the saved note. Messages already sent to a provider are unchanged.', preview: memory.text })} /> : memorySearching ? <div className="memory-searching" role="status"><Spinner size={16} />Loading notes…</div> : <EmptyState icon={memorySearchQuery ? Search : memoryFilter === 'new' ? Check : Brain} title={memorySearchQuery ? 'No notes found' : memoryFilter === 'new' ? 'No new memories' : 'No short notes yet'} action={!memorySearchQuery && memoryFilter === 'all' && <button className="secondary-button" onClick={() => setAddingMemory(true)}><Plus size={15} />Create your first memory</button>}>{memorySearchQuery ? 'Try another phrase or clear the search to see more notes.' : memoryFilter === 'new' ? 'You’ve reviewed the new notes in this workspace. Future notes will appear here.' : settings.memoryCapture === 'ask' ? 'Your AI can suggest useful notes for you to review. You can also add one yourself.' : 'Useful details can be saved during your chats. You can also add a project goal or preference yourself.'}</EmptyState>}
        {isDesktop&&<MemoryEvidence onOpenChat={id=>{const chat=data.conversations.find(c=>c.id===id);if(chat)selectConversation(chat);else setNotice('This source chat is no longer in the library. The original saved note is still available.');}}/>}
        {!standardView && <div className="page-footnote"><LockKeyhole size={13} /><span>Each note can contain up to 280 UTF-8 bytes.</span></div>}
        <ArchivePanel canImport={capabilities.localFiles} isWeb={isWeb} summary={data.archive || data.archiveSummary || {}} act={act} refresh={refresh} busyAction={busyAction} onModalChange={setArchiveModalVisible} onNotice={setNotice} />
      </div>}

      {page==='workbench'&&isDesktop&&<Workbench standard={standardView} onView={chooseInterfaceView} value={data.workbench} conversations={savedConversations} catalog={catalog.filter(p=>['subscription','local'].includes(p.mode)&&providerReady(data.connections.find(c=>c.id===p.id)))} messaging={data.messaging} refresh={refresh} onOpen={selectConversation} onNew={newChat} onPrompt={insertPrompt}/>}
      {page==='storage'&&isDesktop&&<DiskSpace onReview={async value=>{await refresh();await selectConversation({id:value.conversationId});setDraft(value.prompt,value.conversationId);setTimeout(()=>composerRef.current?.focus({preventScroll:true}),0);}}/>}
      {page==='tutorials'&&<Tutorials completed={settings.tutorialProgress} onStart={id=>{setTutorial(id);setTutorialStep(0);}}/>}
      {page === 'connections' && <ProviderConnections onBack={() => openSettings('connections')} extra={isDesktop?[{id:'github',label:'GitHub',content:<GithubConnection openExternal={openExternal} onNotice={setNotice}/>}]:null} signOut={isDesktop?signOut:undefined} isWeb={isWeb} catalog={catalog} connections={data.connections} busyAction={busyAction} act={act} refresh={async () => { await api.invoke('connections.refresh'); await refresh(); }} connect={connect} onModalChange={setProviderModalVisible} onNotice={setNotice} openExternal={openExternal} openWebsite={url => { if (!capabilities.nativeBrowser) return openExternal(url); setBrowserOpen(true); return act('provider-website', () => api.invoke('browser.navigate', { url, conversationId: browserConversationId })); }} />}

      {page === 'tools' && (isWeb ? <HostedTools tools={data.tools} executor={runtime.executor} /> : <div className="content-page"><div className="page-heading"><div><div className="eyebrow">TOOLS</div><h1>Choose what your AI can do</h1><p>Manage access to your files, browser, and desktop.</p></div><button className="tag tag-button" onClick={() => openSettings('permissions')} title="Change what agents may do without asking"><ShieldCheck size={13} />Default permissions: {modeInfo(data.permissionModes, settings.permissionMode).label}</button></div><div className="capability-grid"><article className="capability-card"><div className="capability-top"><div className="capability-icon mint">{standardView ? <FolderOpen size={21} /> : <Terminal size={21} />}</div>{!standardView && <span className="tag">Provider tools</span>}</div><h3>{standardView ? 'Your files' : 'Code & terminal'}</h3><p>{standardView ? 'Your AI can read and work on files in the folder you choose, within the permission level you set.' : 'Connected providers can work with files and run approved terminal commands. Codex and Claude Code can also use their native tools.'}</p><button className="text-button" onClick={chooseWorkspace}><FolderOpen size={15} />{settings.workspace ? folderLabel(settings.workspace) : 'Choose a project'}<ArrowRight size={14} /></button></article><article className="capability-card"><div className="capability-top"><div className="capability-icon warm"><Globe2 size={21} /></div><Toggle label="Enable browser tools" checked={settings.browserEnabled} onChange={value => saveSettings({ browserEnabled: value })} disabled={busyAction === 'settings'} /></div><h3>{standardView ? 'Use websites' : 'Browser tools'}</h3><p>{standardView ? 'Let your AI open and read websites in Exomina’s browser. Clicking and typing on a page follow your permission level.' : 'Your connected providers can use the embedded browser. Enable this to allow browser actions after approval.'}</p><span className={`inline-status ${settings.browserEnabled ? 'enabled' : ''}`}><span />{settings.browserEnabled ? 'Enabled for new requests' : 'Disabled by default'}</span></article><article className="capability-card"><div className="capability-top"><div className="capability-icon lilac"><Monitor size={21} /></div><Toggle label="Enable desktop tools" checked={settings.desktopEnabled} onChange={value => saveSettings({ desktopEnabled: value })} disabled={busyAction === 'settings'} /></div><h3>{standardView ? 'Control this PC' : 'Computer use'}</h3><p>{standardView ? 'Let your AI look at your screen and use the mouse and keyboard. You approve each step first.' : 'Allow screenshots and desktop input. You review each requested operation before it runs.'}</p><span className={`inline-status ${settings.desktopEnabled ? 'enabled' : ''}`}><span />{settings.desktopEnabled ? 'Enabled · action approval required' : 'Disabled by default'}</span></article></div>{standardView && <AdvancedViewHint onChange={chooseInterfaceView}>Add-ons and detailed tool settings are in Advanced view.</AdvancedViewHint>}<Recommendations onAsk={insertPrompt} connections={data.connections} providers={data.providers || []} onOpenChat={async id => { await refresh(); await selectConversation({id}); }} /><div className="advanced-only"><Extensions settings={settings} status={data.mcpStatus} busyAction={busyAction} act={act} refresh={refresh} hasActiveRun={runningIds.length > 0} /><AppAnalysis conversationId={conversation?.id} conversationTitle={conversation?.title} onOpenChat={async chat=>{if(chat){await refresh();await selectConversation(chat);}else if(conversation)await selectConversation(conversation);}} /></div><BrowserConnection source={settings.browserSource || 'embedded'} act={act} refresh={refresh} busyAction={busyAction} />{(!standardView || settings.desktopEnabled) && <DriverPanel settings={settings} status={data.mcpStatus} busyAction={busyAction} act={act} refresh={refresh} openExternal={openExternal} />}<details className="tool-details advanced-only"><summary className="section-title"><h2>Available in this app</h2><span>{data.tools.length} {data.tools.length === 1 ? 'capability' : 'capabilities'}</span></summary><p className="connection-small">Connected providers can use these shared workspace, browser, memory and desktop tools. Model support and native tools still differ by provider.</p><div className="tool-list">{data.tools.length ? data.tools.map((tool, index) => <div className="tool-row" key={`${tool.name}-${index}`}><span className="tool-row-icon">{String(tool.category).toLowerCase().includes('memory') ? <Brain size={17} /> : String(tool.category).toLowerCase().includes('desktop') ? <Monitor size={17} /> : String(tool.category).toLowerCase().includes('browser') ? <Globe2 size={17} /> : <Blocks size={17} />}</span><div><strong>{tool.name}</strong><p>{tool.description}</p></div><span className="tool-category">{tool.category}</span><span className={`tool-state ${tool.enabled ? 'enabled' : ''}`}><span />{tool.enabled ? 'Available' : 'Off'}</span></div>) : <EmptyState icon={Blocks} title="Tool list unavailable">Open the desktop app to see the tools available on this computer.</EmptyState>}</div></details></div>)}

      {page === 'settings' && <SettingsLayout view={interfaceView} onView={chooseInterfaceView} section={settingsSection} selectionRequest={settingsSelectionRequest} desktop={isDesktop} onSelect={openSettings} onNavigate={navigate}>
        <SettingsPanel section="general"><section className="settings-section" id="settings-general"><div className="section-title"><h2>General</h2></div>{isDesktop&&<div className="settings-row"><div><strong>Quick access</strong><p>Ctrl + Shift + Space opens a small question window while Exomina is running.</p>{data.quickAccess?.error&&<p className="inline-error">{data.quickAccess.error}</p>}<button className="text-button" onClick={()=>api.invoke('quick.open').catch(error=>setNotice(error.message))}>Try quick access<ArrowRight size={14}/></button></div><Toggle label="Enable quick access" checked={settings.quickAccess!==false} onChange={value=>saveSettings({quickAccess:value})}/></div>}
          {capabilities.localFiles && <div className="settings-row"><div><strong>Project folder</strong><p className="path-text">{settings.workspace || 'Choose the folder your agents can work in.'}</p></div><button className="secondary-button" onClick={chooseWorkspace}><FolderOpen size={15} />Choose folder</button></div>}
          <div className="settings-row"><div><strong>Name new chats automatically</strong><p>After the first reply, a connected subscription suggests a short title from the conversation. Rename any chat from its menu.</p></div><Toggle label="Name new chats automatically" checked={settings.autoTitle !== false} onChange={value => saveSettings({ autoTitle: value })} disabled={busyAction === 'settings'} /></div>
          <div className="settings-row"><div><strong>Suggest my next message</strong><p>The replying AI predicts a likely follow-up as part of its answer, at no extra request. It appears greyed out in an empty message box: <kbd>Tab</kbd> inserts it without sending, <kbd>Esc</kbd> dismisses it.</p></div><Toggle label="Suggest my next message" checked={settings.promptSuggestions !== false} onChange={value => saveSettings({ promptSuggestions: value })} disabled={busyAction === 'settings'} /></div>
          {isDesktop && <div className="settings-row"><div><strong>Keep Exomina in the tray when I close the window</strong><p>Chats can continue with the window closed. Use Quit from the tray to stop Exomina.</p></div><Toggle label="Keep Exomina in the tray when I close the window" checked={settings.closeToTray !== false} onChange={value => saveSettings({ closeToTray: value })} /></div>}
        </section></SettingsPanel>
        <SettingsPanel section="defaults"><section className="settings-section" id="settings-defaults"><div className="section-title"><h2>Default AI</h2></div>
          <div className="settings-row"><div><strong>Default provider</strong><p>Used when you start a new chat.</p></div><select aria-label="Default provider" value={provider} onChange={event => saveSettings({ provider: event.target.value, model: 'auto', effort: '' })}>{catalog.map(item => <option key={item.id} value={item.id}>{item.name} · {providerModeLabel(item.mode)}</option>)}</select></div>
          <div className="settings-row"><div><strong>Default model</strong><p>Use auto to let the provider choose. You can also change it from the message box.</p></div><input className="settings-input" aria-label="Default model" key={settings.model} defaultValue={settings.model || 'auto'} onBlur={event => { if ((event.target.value.trim() || 'auto') !== settings.model) saveSettings({ model: event.target.value.trim() || 'auto' }); }} /></div>
        </section></SettingsPanel>
        <SettingsPanel section="models"><ModelSettings value={settings.modelPreferences} catalog={catalog} connections={data.connections} models={data.providerModels} Toggle={Toggle} onChange={saveModelPreferences} onConnections={() => navigate('connections')} /></SettingsPanel>
        <SettingsPanel section="local-ai">{isDesktop && <LocalAISettings settings={settings} saveSettings={saveSettings} Toggle={Toggle} tasks={data.workbench?.schedules || []} onOpen={async id => { await refresh(); await selectConversation({id}); }} onTasks={() => navigate('workbench')} />}</SettingsPanel>
        <SettingsPanel section="marketing">{isDesktop && <MarketingSettings settings={settings} saveSettings={saveSettings} Toggle={Toggle} providers={(data.connections||[]).filter(c=>["claude","codex"].includes(c.id)&&c.connected)} />}</SettingsPanel>
        <SettingsPanel section="spending">{isDesktop&&<AgentSpending/>}</SettingsPanel>
        <SettingsPanel section="personalization"><PersonalizationSettings appearance={appearance} onAppearanceChange={saveAppearance} personalization={settings.personalization} onChange={(next, options) => options?.local ? setData(previous => ({ ...previous, settings: { ...previous.settings, personalization: next } })) : saveSettings({ personalization: next })} /></SettingsPanel>
        <SettingsPanel section="appearance"><AppearanceSettings appearance={appearance} onChange={saveAppearance} Toggle={Toggle} windowState={isDesktop ? data.window : null} /></SettingsPanel>
        <SettingsPanel section="usage">{isDesktop && <UsageSettings usage={data.usage} connections={data.connections} onRefresh={refreshUsageDetails} onManage={openUsagePage} onReset={useResetCredit} resetPending={data.usageResetPending} />}{isDesktop && <SafetyLimits initial={data.guard} />}</SettingsPanel>
        <SettingsPanel section="sounds">{isDesktop && <SoundSettings sounds={settings.sounds} Toggle={Toggle} onChange={saveSounds} notifications={settings.attentionNotifications !== false} onNotificationsChange={attentionNotifications => saveSettings({ attentionNotifications })} />}</SettingsPanel>
        <SettingsPanel section="voice">{isDesktop && <VoiceSettings api={api} settings={settings.voice} onChange={voicePatch => saveSettings({ voicePatch })} voice={voice} />}</SettingsPanel>
        <SettingsPanel section="permissions">{isDesktop && <PermissionSettings modes={data.permissionModes} mode={settings.permissionMode || 'ask'} rules={settings.permissionRules || []} busy={busyAction === 'settings' || busyAction === 'permissions-reset'} ownCount={data.conversations.filter(item => item.permissionMode).length} onResetChats={() => act('permissions-reset', async () => { const result = await api.invoke('permissions.resetChats'); await refresh(); setNotice(`${result.count} ${result.count === 1 ? 'chat follows' : 'chats follow'} the default again.`); })} onMode={mode => saveSettings({ permissionMode: mode })} onRules={async rules => { const next = await api.invoke('settings.save', { permissionRules: rules }); setData(previous => ({ ...previous, settings: next })); }} />}</SettingsPanel>
        <SettingsPanel section="messaging">{isDesktop && <MessagingSettings status={data.messaging} providers={catalog.filter(item => providerReady(data.connections.find(connection => connection.id === item.id)))} onStatus={messaging => setData(previous => ({ ...previous, messaging }))} openBrowser={url=>act('messaging-website',async()=>{if(privateChat)throw Error('Open a regular chat before opening a messaging website.');if(!settings.browserEnabled)throw Error('Browser tools are off. Enable them in Tools before opening a messaging website.');navigate('chat');chooseBrowserVisibility(true);await api.invoke('browser.navigate',{url,conversationId:browserConversationId});})} />}</SettingsPanel>
        <SettingsPanel section="spelling">{isDesktop && <SpellcheckSettings Toggle={Toggle} busy={busyAction === 'settings'} spellcheck={{ ...data.spellcheck, ...settings.spellcheck }} onChange={patch => act('settings', async () => { const next = await api.invoke('settings.save', { spellcheck: patch }); const state = await api.invoke('bootstrap'); setData(previous => ({ ...previous, settings: next, spellcheck: state.spellcheck })); })} />}</SettingsPanel>
        <SettingsPanel section="updates">{isDesktop && <UpdateSettings Toggle={Toggle} active={!!runningIds.length||voice.active} onAutoUpdate={value => saveSettings({ autoUpdate: value })} onReleaseSource={value=>saveSettings({updateFeedUrl:value})} onReview={async value=>{await refresh();await selectConversation({id:value.conversationId});setDraft(value.prompt,value.conversationId);}} />}</SettingsPanel>
        <SettingsPanel section="memory"><section className="settings-section" id="settings-memory"><div className="section-title"><h2>Memory & privacy</h2></div>
          <div className="settings-row"><div><strong>Saved memories</strong><p>Useful context is kept automatically. Open your notes when you want to inspect, correct or remove something.</p></div><button className="secondary-button" onClick={() => navigate('memory')}><Brain size={15} />View saved memories</button></div>
          {isDesktop && <LocalStorageSettings security={data.security} active={running || !!data.activeRuns?.length || voice.active} />}
          {isDesktop && data.security?.mode === 'efs' && <RecoveryAudit audit={data.security?.recoveryAudit} active={running || !!data.activeRuns?.length} onChange={recoveryAudit => setData(previous => ({ ...previous, security: { ...previous.security, recoveryAudit } }))} />}
          <div className="settings-row"><div><strong>Include relevant memories</strong><p>Share relevant saved notes with the AI you are using.</p></div><Toggle label="Include relevant memories" checked={settings.memoryEnabled} onChange={value => saveSettings({ memoryEnabled: value })} /></div>
          <MemoryCaptureControl value={settings.memoryCapture} onChange={value => saveSettings({ memoryCapture: value })} disabled={busyAction === 'settings'} />
          {isDesktop&&<ChatMemorySettings settings={settings} status={data.chatMemory} models={data.providerModels} connections={data.connections} onChange={saveSettings} disabled={busyAction==='settings'} />}
          {capabilities.localFiles && <div className="settings-row"><div><strong>Local app data</strong><p>Open the folder containing your conversations and saved memory.</p></div><button className="secondary-button" onClick={() => act('open-data', () => api.invoke('app.openData'))}><FolderOpen size={15} />Open folder</button></div>}
          <div className="settings-row"><div><strong>Clear short notes</strong><p>Remove short notes saved in this app. Imported archives and conversations are kept.</p></div><button className="danger-text-button" disabled={!data.memories.length} onClick={() => setConfirm({ type: 'memory', title: 'Clear all short notes?', text: 'This permanently removes your short notes. Imported archives and conversations are kept. Export your notes first if you want a copy.' })}><Trash2 size={15} />Clear memory</button></div>
        </section></SettingsPanel>
        <SettingsPanel section="skills">{isDesktop && <SkillLibrary conversationId={selectedId} refinements={conversation?.approachRefinements||[]} invoke={(method,payload)=>api.invoke(method,payload)} onNotice={setNotice}/>}</SettingsPanel>
        <SettingsPanel section="workers">{isDesktop && <WorkerSettings invoke={(method,payload)=>api.invoke(method,payload)}/>}</SettingsPanel>
        <SettingsPanel section="phone">{isDesktop && <div id="settings-phone" className="settings-anchor"><RemoteSettings /></div>}</SettingsPanel>
        <SettingsPanel section="integrations"><div id="settings-integrations" className="settings-anchor">{capabilities.localFiles && <AdvancedMcp settings={settings} status={data.mcpStatus} act={act} refresh={refresh} busyAction={busyAction} />}{isDesktop && <CloudSettings initialStatus={data.sync} onStatus={sync => setData(previous => ({ ...previous, sync }))} />}{isWeb && <PairedDevices />}</div></SettingsPanel>
        <SettingsPanel section="connections"><section className="settings-section" id="settings-connections"><div className="section-title"><h2>AI connections</h2></div><div className="settings-row"><div><strong>Your connected AI tools</strong><p>Connect an AI during setup, then return here to add another or manage an existing connection.</p></div><button className="secondary-button" onClick={() => navigate('connections')}><Unplug size={15} />Manage connections</button></div></section></SettingsPanel>
        <SettingsPanel section="workspace">{isWeb && <section className="settings-section" id="settings-workspace"><div className="section-title"><h2>Private workspace</h2></div><div className="settings-row"><div><strong>{session.displayName || 'Signed in'}</strong><p>{data.sync ? syncLabel(data.sync) : 'Connected to your private server.'}</p>{data.sync?.lastSyncedAt && <p>Last synced {new Date(data.sync.lastSyncedAt).toLocaleString()}</p>}</div><button className="secondary-button" onClick={() => act('sign-out', signOut)}>Sign out</button></div></section>}</SettingsPanel>
        <SettingsPanel section="data"><section className="settings-section" id="settings-data"><div className="section-title"><h2>Data</h2></div>{isDesktop&&<LibraryBackup onNotice={setNotice}/>}<div className="settings-row"><div><strong>Your chats and context</strong><p>Save a readable or structured copy.</p></div><DataExport onModalChange={setProviderModalVisible} onNotice={setNotice} /></div></section></SettingsPanel>
        <SettingsPanel section="about"><section className="settings-section" id="settings-about"><div className="section-title"><h2>About</h2></div><div className="about-footer"><Logo small /><div><strong>Exomina {data.version}</strong><span>Your AI tools in one place. Standalone; runs only the provider runtimes it ships with.</span></div><button type="button" className="appearance-badge" onClick={() => openSettings('appearance')}>{appearance.theme === 'system' ? <><Monitor size={14} />Matches Windows</> : THEMES.find(item => item.id === appearance.theme)?.scheme === 'light' ? <><Sun size={14} />{THEMES.find(item => item.id === appearance.theme).name}</> : <><Moon size={14} />{THEMES.find(item => item.id === appearance.theme)?.name}</>}</button></div></section></SettingsPanel>
      </SettingsLayout>}
      </>}
    {isDesktop && !workflow.active && !standardView && !privateChat && page==='chat' && conversation && terminalOpen && <TerminalPanel conversationId={conversation.id} messages={visibleMessages} running={running} onStopAgent={cancel} onClose={() => setTerminalOpen(false)} />}
    {activeTutorial&&<TutorialGuide tutorial={activeTutorial} step={tutorialStep} onStep={setTutorialStep} onClose={()=>setTutorial(null)} onComplete={()=>{saveSettings({tutorialProgress:{...settings.tutorialProgress,[tutorial]:true}});setTutorial(null);setNotice('Tutorial completed. You can replay it any time.');}} onNavigate={step=>step.section?openSettings(step.section):navigate(step.page)} onExample={insertPrompt}/>}
    </main></WorkflowWorkspace>
    {branchEdit&&createPortal(<div className="modal-backdrop"><section className="modal branch-editor" role="dialog" aria-modal="true" aria-label="Edit and branch conversation"><h2>Edit &amp; branch</h2><p>A new chat will contain the conversation up to this message. Review the edited message before sending.</p><textarea aria-label="Edited branch message" rows={7} value={branchEdit.text} onChange={e=>setBranchEdit(p=>({...p,text:e.target.value}))}/><div className="modal-actions"><button className="secondary-button" onClick={()=>setBranchEdit(null)}>Cancel</button><button className="primary-button" disabled={!branchEdit.text.trim()||busyAction==='branch'} onClick={()=>branch(branchEdit.message,branchEdit.index,branchEdit.text)}>Create branch</button></div></section></div>,document.body)}
    {!workflow.active && !privateChat && browserOpen && capabilities.nativeBrowser && <><div className="browser-resizer" {...browserLayout.separatorProps}/><div className={`default-side-panels${notesOpen?' has-notes':''}`}>{workflowBrowserPanel}<div className="default-notes-slot" ref={setNotesPortalTarget}/></div></>}

    {addingMemory && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setAddingMemory(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="memory-dialog-title"><button className="modal-close icon-button" onClick={() => setAddingMemory(false)} aria-label="Close"><X size={18} /></button><div className="modal-icon"><Brain size={23} /></div><h2 id="memory-dialog-title">Add a memory</h2><p>Add a short note that your selected provider can use when memory is on.</p><form onSubmit={addMemory}><label className="input-label" htmlFor="memory-note">What should be saved?</label><textarea id="memory-note" autoFocus className="memory-textarea" placeholder="For this project, explain technical choices in plain language." rows={4} value={memoryDraft} onChange={event => setMemoryDraft(event.target.value)} /><div className={`byte-counter ${byteCount(memoryDraft.trim()) > 280 ? 'over-limit' : ''}`}><span>UTF-8 bytes · some characters use more than one</span><span>{byteCount(memoryDraft.trim())} / 280</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAddingMemory(false)}>Cancel</button><button className="primary-button" disabled={!memoryDraft.trim() || byteCount(memoryDraft.trim()) > 280 || busyAction === 'memory-add'}>{busyAction === 'memory-add' ? <Spinner size={15} /> : <Check size={15} />}Save memory</button></div></form></section></div>}
    {wakeResult && <MemoryContextDialog result={wakeResult} api={api} onClose={() => setWakeResult(null)} />}
    {floatingApproval && pendingApproval && <div className="modal-backdrop approval-backdrop"><div className="approval-modal"><ApprovalCard approval={pendingApproval} count={approvals.length} busy={busyAction === 'approval'} onRespond={response => respondApproval(pendingApproval, response)} chatTitle={pendingApproval.conversationId ? data.conversations.find(item => item.id === pendingApproval.conversationId)?.title : null} onOpenChat={() => { const chat = data.conversations.find(item => item.id === pendingApproval.conversationId); if (chat) selectConversation(chat); }} /></div></div>}
    {confirm && <div className="modal-backdrop"><section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><div className="modal-icon danger"><Trash2 size={22} /></div><h2 id="confirm-title">{confirm.title}</h2><p>{confirm.text}</p>{confirm.preview && <blockquote className="memory-delete-preview">{confirm.preview}</blockquote>}{confirm.type==='chat'&&<><label className="chat-delete-memories"><input type="checkbox" aria-label="Also delete memories associated with this chat" checked={confirm.deleteMemories===true} disabled={confirm.memoryLoading||!!confirm.memoryError||busyAction==='delete'} onChange={event=>setConfirm(current=>({...current,deleteMemories:event.target.checked}))}/><span><strong>Also delete memories associated with this chat</strong><small>{confirm.memoryLoading?'Checking saved memory links…':confirm.memoryError||`${confirm.memoryStats?.deletable||0} ${(confirm.memoryStats?.deletable||0)===1?'memory':'memories'} saved only by this chat can be deleted. ${(confirm.memoryStats?.shared||0)+(confirm.memoryStats?.independent||0)} shared or independently saved memories are kept.`}</small></span></label><p className="chat-delete-memory-limit">Older memories without a recorded chat link are kept. Copies in other chats and content already sent to providers remain.</p></>}<div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>Cancel</button><button className="danger-button" disabled={busyAction === 'delete'} onClick={deleteConfirmed}>{busyAction === 'delete' && <Spinner size={15} />}{confirm.type === 'memory' ? 'Clear short notes' : confirm.type === 'note' ? 'Delete memory' : 'Delete conversation'}</button></div></section></div>}
    {pendingConnectorForm && <ConnectorForm key={pendingConnectorForm.id} request={pendingConnectorForm} chatTitle={data.conversations.find(item=>item.id===pendingConnectorForm.conversationId)?.title} onRespond={payload=>api.invoke('connector.respond',payload)} />}
    {questionPopupGroup && <QuestionPopup key={selectedId + ':' + questionPopupGroup.id} group={questionPopupGroup} chatTitle={conversation?.title || 'This chat'} pendingCount={pendingQuestionGroups.length} busy={questionSending.includes(questionSessionKey(selectedId, questionPopupGroup.id))} onAnswer={answerQuestion} onContinue={continueQuestion} onClose={dismissQuestions} />}
  </div></div></></QuestionDraftContext.Provider></InterfaceViewContext.Provider>;
}
