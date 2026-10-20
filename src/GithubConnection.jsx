import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Github, KeyRound, LoaderCircle, LogOut, ShieldCheck, X } from 'lucide-react';
import { api } from './transport.js';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const errorText = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

/** Lets the AI read repositories, issues and pull requests, and propose changes you approve. The token stays encrypted on this computer. */
export default function GithubConnection({ openExternal, onNotice }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [access, setAccess] = useState('all');
  const [clientId, setClientId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => { try { setStatus(await api.invoke('github.status')); } catch (problem) { setError(errorText(problem)); } }, []);
  useEffect(() => { load(); }, [load]);
  const waiting = status?.signIn?.state === 'waiting';
  useEffect(() => { if (!waiting) return undefined; const timer = setInterval(load, 3000); return () => clearInterval(timer); }, [waiting, load]);
  const wasConnected = React.useRef(null);
  useEffect(() => { if (status == null) return; if (wasConnected.current === false && status.connected && status.tokenKind === 'oauth') onNotice?.('GitHub connected as ' + status.login + '.'); wasConnected.current = status.connected === true; }, [status, onNotice]);

  async function signIn() {
    setPending('signin'); setError('');
    try { const next = await api.invoke('github.signin.start', { access }); setStatus(next); openExternal(next.signIn.verificationUri); }
    catch (problem) { setError(errorText(problem)); }
    finally { setPending(''); }
  }
  async function cancelSignIn() { try { setStatus(await api.invoke('github.signin.cancel')); } catch (problem) { setError(errorText(problem)); } }
  async function saveClient(event) {
    event.preventDefault(); setPending('client'); setError('');
    try { setStatus(await api.invoke('github.client', { clientId: clientId.trim() })); setClientId(''); }
    catch (problem) { setError(errorText(problem)); }
    finally { setPending(''); }
  }
  async function copyCode() { try { await navigator.clipboard.writeText(status.signIn.userCode); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ } }

  async function connect(event) {
    event.preventDefault(); setPending('connect'); setError('');
    try { const next = await api.invoke('github.connect', { token: token.trim() }); setStatus(next); setToken(''); onNotice?.(`GitHub connected as ${next.login}.`); }
    catch (problem) { setError(errorText(problem)); }
    finally { setPending(''); }
  }
  async function disconnect() {
    setPending('disconnect'); setError(''); setConfirm(false);
    try { setStatus(await api.invoke('github.disconnect')); onNotice?.('GitHub disconnected. The saved token was removed from this computer.'); }
    catch (problem) { setError(errorText(problem)); }
    finally { setPending(''); }
  }

  const connected = status?.connected === true;
  return <section className="provider-group github-connection" data-provider="github">
    <div className="provider-group-heading"><h2>Developer tools</h2><p>Optional. Connect your own accounts so the AI can work with them.</p></div>
    <div className="connection-grid">
      <article className={`connection-card catalog-connection-card ${connected ? 'connected' : ''}`}>
        <div className="connection-card-top"><span className="provider-mark catalog-mark" style={{ '--provider-accent': '#c9d1d9' }} aria-hidden="true"><Github size={20} strokeWidth={1.6} /></span><span className={`tag ${connected ? 'mint' : ''}`}>{status == null ? 'Checking…' : connected ? <><span className="status-dot" />Connected</> : 'Not connected'}</span></div>
        <h2>GitHub</h2><p className="connection-subtitle">{connected ? `Signed in as ${status.login}${status.name ? ` (${status.name})` : ''}` : 'Sign in with your GitHub account'}</p>
        <p className="connection-description">Search repositories and review changes from chat. Commit text files, manage issues, merge pull requests, or delete files and repositories after approving each complete preview.</p>
        {connected ? <>
          <div className="connection-detail"><ShieldCheck size={14} /><span>{status.tokenKind === 'oauth' ? 'GitHub sign-in' : status.tokenKind === 'fine-grained' ? 'Fine-grained token' : status.tokenKind === 'classic' ? 'Classic token' : 'Token'} saved encrypted on this computer.{status.rate ? ` ${status.rate.remaining} GitHub requests left this hour.` : ''}</span></div>
          {status.advice && <p className="connection-small">{status.advice}</p>}
          {status.warning && <p className="inline-error" role="status">{status.warning}</p>}
          {status.error && <p className="inline-error" role="alert">{status.error}</p>}
          {confirm
            ? <div className="connection-signout-confirm" role="group" aria-label="Disconnect GitHub"><span>Remove the saved token?</span><button className="danger-text-button" disabled={!!pending} onClick={disconnect}>{pending === 'disconnect' ? <LoaderCircle size={13} className="spin" /> : <LogOut size={13} />}Disconnect</button><button className="text-button" onClick={() => setConfirm(false)}>Cancel</button></div>
            : <button className="text-button connection-signout" disabled={!!pending} onClick={() => setConfirm(true)}><LogOut size={13} />Disconnect</button>}
        </> : <>
          {status?.signIn && status.signIn.state !== 'waiting' && <p className="inline-error" role="alert">{status.signIn.message}</p>}
          {waiting ? <div className="github-device-code" role="status">
            <p className="connection-small">On github.com, enter this code and approve Exomina:</p>
            <div className="github-code-row"><code aria-label="GitHub sign-in code">{status.signIn.userCode}</code><button type="button" className="icon-button" aria-label="Copy code" onClick={copyCode}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
            <p className="connection-small"><LoaderCircle size={11} className="spin" /> Waiting for you to approve it… the page opened in your browser.</p>
            <div className="github-device-actions"><button type="button" className="secondary-button" onClick={() => openExternal(status.signIn.verificationUri)}>Open github.com <ExternalLink size={12} /></button><button type="button" className="text-button" onClick={cancelSignIn}><X size={12} />Cancel</button></div>
          </div> : status?.signInAvailable ? <>
            <label className="input-label" htmlFor="github-access">What may the AI reach?</label>
            <select id="github-access" className="provider-model-select" value={access} onChange={event => setAccess(event.target.value)}><option value="all">Every repository I can access, including private</option><option value="public">Public repositories only</option><option value="all-delete">All repositories, including repository deletion permission</option></select>
            <button type="button" className="primary-button full-width" disabled={!!pending} onClick={signIn}>{pending === 'signin' ? <LoaderCircle size={15} className="spin" /> : <Github size={15} />}Sign in with GitHub</button>
          </> : <form onSubmit={saveClient}>
            <p className="connection-small">Register Exomina’s OAuth app once with Device Flow enabled. Use a homepage you control and a loopback callback such as http://127.0.0.1/oauth/callback. Paste the public client ID here.</p>
            <label className="input-label" htmlFor="github-client-id">Client ID</label>
            <input id="github-client-id" autoComplete="off" spellCheck={false} value={clientId} onChange={event => setClientId(event.target.value)} placeholder="Ov23li…" />
            <button className="secondary-button full-width" disabled={!!pending || clientId.trim().length < 8}>{pending === 'client' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save client ID</button>
            <button type="button" className="provider-setup-link text-button" onClick={() => openExternal(status?.appUrl || 'https://github.com/settings/applications/new')}>Register the app on GitHub <ExternalLink size={11} /></button>
          </form>}
          {!waiting && <button type="button" className="text-button" onClick={() => setShowToken(value => !value)}>{showToken ? 'Hide token option' : 'Use a personal access token instead'}</button>}
          {showToken && !waiting && <form onSubmit={connect}>
            <label className="input-label" htmlFor="github-token">Personal access token</label>
            <input id="github-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="github_pat_…" />
            <p className="connection-small">Limit a fine-grained token to the repositories you choose. Add write access to contents for commits, issues for comments, and pull requests for merges. Repository deletion needs repository administration permission. Every change still asks for approval.</p>
            <button className="secondary-button full-width" disabled={!!pending || token.trim().length < 20}>{pending === 'connect' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Check and connect</button>
            <button type="button" className="provider-setup-link text-button" onClick={() => openExternal(TOKEN_URL)}>Create a token on GitHub <ExternalLink size={11} /></button>
          </form>}
          {(error || status?.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
        </>}
        <p className="connection-small"><KeyRound size={11} /> The token is sent only to api.github.com and is never shown to the AI.</p>
      </article>
    </div>
  </section>;
}
