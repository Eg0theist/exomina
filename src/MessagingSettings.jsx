import React, { useState } from 'react';
import { Copy, ExternalLink, Globe2, LoaderCircle, MessageCircle, RefreshCw, Send, Trash2, Unplug } from 'lucide-react';
import { api } from './transport.js';
const ACCESS_LEVELS=[['read-only','Read only'],['ask','Ask before acting'],['auto-edit','Auto-accept edits'],['full','Full access']];

const clean = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const CHANNELS = {
  telegram: { name: 'Telegram', icon: Send, website:'https://web.telegram.org/', steps: ['In Telegram, open @BotFather and send /newbot. Pick any name.', 'Copy the token it gives you and paste it here.', 'Open your new bot and send it the pairing code below.'], placeholder: '123456789:AA…', help: 'https://core.telegram.org/bots/tutorial#obtain-your-bot-token' },
  discord: { name: 'Discord', icon: MessageCircle, website:'https://discord.com/app', steps: ['At discord.com/developers, create an application, open Bot and press Reset Token. Turn off Public Bot to keep it private.', 'Paste the token here, then use “Add bot to a server” so you share a server with it.', 'Send the bot a direct message with the pairing code below.'], placeholder: 'MTIz…', help: 'https://discord.com/developers/applications' },
};
const STATE = { connected: 'Connected', connecting: 'Connecting…', retrying: 'Reconnecting…', error: 'Problem', stopped: 'Stopped', off: 'Not set up' };

function Channel({ id, status = {}, providers, onStatus, openBrowser }) {
  const info = CHANNELS[id], Icon = info.icon;
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [replaceToken,setReplaceToken]=useState(false);
  const on = status.enabled;
  async function run(name, method, payload) { setBusy(name); setError(''); try { const result = await api.invoke(method, { channel: id, ...payload }); if (method !== 'messaging.connect') onStatus(result); else {onStatus(await api.invoke('messaging.status'));setReplaceToken(false);} } catch (failure) { setError(clean(failure)); } finally { setToken('');setBusy(''); } }
  return <div className={`messaging-card state-${status.state || 'off'}`}>
    <div className="messaging-head"><span className="messaging-icon"><Icon size={17} /></span><div><strong>{info.name}</strong><small>{STATE[status.state] || STATE.off}{status.name ? ` · ${status.name}` : ''}</small></div>
      {on && <button type="button" className="text-button" onClick={() => run('off', 'messaging.disconnect')} disabled={!!busy}><Unplug size={13} />Disconnect</button>}</div>
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    <button type="button" className="secondary-button small" onClick={()=>openBrowser(info.website)}><Globe2 size={14}/>Open {info.name} web</button>
    <p className="messaging-note">Sign in to the website yourself. To talk to Exomina from {info.name}, connect your private bot below.</p>
    {(!on||replaceToken) && <><ol className="messaging-steps">{info.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <div className="messaging-connect"><input type="password" autoComplete="off" spellCheck={false} value={token} placeholder={info.placeholder} aria-label={`${info.name} bot token`} onChange={event => setToken(event.target.value)} />
        <button type="button" className="primary-button small" disabled={!token.trim() || !!busy} onClick={() => run('connect', 'messaging.connect', { token })}>{busy === 'connect' ? <LoaderCircle size={14} className="spin" /> : null}{on?'Update token':'Connect bot'}</button></div>
      <p className="messaging-note">Enter bot tokens only here. They are encrypted on this PC and are never included in AI chat context.</p>
      <button type="button" className="text-button" onClick={() => openBrowser(info.help)}>How to get a token <ExternalLink size={12} /></button></>}
    {on && <>
      <div className="messaging-pair">{status.code ? <><span>Pairing code</span><code>/pair {status.code}</code><button type="button" className="icon-button" title="Copy" aria-label="Copy pairing message" onClick={() => navigator.clipboard?.writeText(`/pair ${status.code}`).catch(()=>{})}><Copy size={13} /></button><small>Send this to the bot within 15 minutes. Five wrong attempts expire the code.</small></>
        : <><span>{status.paired?.length ? 'Pair another account' : 'Pair your account'}</span><button type="button" className="secondary-button small" disabled={!!busy||!['connected','connecting','retrying'].includes(status.state)} onClick={() => run('code', 'messaging.code')}><RefreshCw size={13} />Show pairing code</button></>}</div>
      <div className="messaging-actions">{['error','stopped'].includes(status.state)&&<button type="button" className="secondary-button small" disabled={!!busy} onClick={()=>run('restart','messaging.restart')}><RefreshCw size={13}/>Reconnect</button>}<button type="button" className="text-button" disabled={!!busy} onClick={()=>{setReplaceToken(value=>!value);setToken('');}}>{replaceToken?'Cancel token change':'Replace bot token'}</button></div>
      {status.paired?.length > 0 && <ul className="messaging-paired">{status.paired.map(user => <li key={user.id}><div>{user.name}<small>paired {new Date(user.pairedAt).toLocaleDateString()}</small>{id==='discord'&&<label>Task access for {user.name}<select aria-label={`Discord access for ${user.name}`} value={user.taskMode||'ask'} disabled={!!busy} onChange={event=>run('permissions','messaging.permissions',{userId:user.id,mode:event.target.value})}>{ACCESS_LEVELS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}</div><button type="button" className="icon-button" aria-label={`Remove ${user.name}`} disabled={!!busy} onClick={() => run('unpair', 'messaging.unpair', { userId: user.id })}><Trash2 size={13} /></button></li>)}</ul>}
      <label className="messaging-provider">Who answers<select value={status.provider || ''} disabled={!!busy} onChange={event => run('provider', 'messaging.provider', { provider: event.target.value })}><option value="">Your default AI</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {id==='discord'&&<><label className="messaging-provider">Local task execution<input type="checkbox" aria-label="Allow Discord local tasks" checked={status.taskExecution!==false} disabled={!!busy} onChange={event=>run('tasks','messaging.tasks',{enabled:event.target.checked})}/></label><p className="messaging-note">Choose access separately for each paired account above or send /permissions full in your bot DM. Full access allows routine actions without individual approvals. Deny rules and required confirmations still apply. Changing access stops current work and queued messages. /help explains all commands and tips, even during a task. Turning execution off stops Discord tasks.</p></>}
      {id === 'discord' && status.inviteUrl && <button type="button" className="text-button" onClick={() => openBrowser(status.inviteUrl)}>Add bot to a server <ExternalLink size={12} /></button>}
      <p className="messaging-note">{status.chats ? `${status.chats} ${status.chats === 1 ? 'chat' : 'chats'} so far, listed with your other chats.` : 'Each conversation appears in your chat list here.'} In the app: /new, /ai claude, /usage, /help.</p>
      <p className="messaging-note">Disconnect removes the saved token and paired accounts.</p>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}

export default function MessagingSettings({ status = {}, providers = [], onStatus, openBrowser }) {
  return <section className="settings-section" id="settings-messaging">
    <div className="section-title"><h2>Messaging</h2><span>Exomina in Telegram and Discord</span></div>
    <p className="persona-intro">Chat with your AIs from your phone through your own private bot. It shares memory and personalisation with Exomina here, and only answers accounts you pair. Discord can run local tasks with permissions and approvals in your DM. Telegram supports chat and memory. Your PC must stay awake, online and running Exomina (the tray is enough).</p>
    <p className="messaging-note">Bot messages and replies pass through Telegram or Discord, including any saved context you ask Exomina to use.</p>
    <div className="messaging-grid">{['telegram', 'discord'].map(id => <Channel key={id} id={id} status={status[id]} providers={providers} onStatus={onStatus} openBrowser={openBrowser} />)}</div>
  </section>;
}
