import React, { useEffect, useState } from 'react';
import { Check, Download, FolderOpen, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import BrandMark from './BrandMark.jsx';
import { api } from './transport.js';

const readableError = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
const validStatus = value => value && ['protected', 'supported', 'needsRecovery'].every(key => typeof value[key] === 'boolean') && (value.ready === undefined || typeof value.ready === 'boolean') && (value.mode === undefined || ['standard', 'efs'].includes(value.mode));

export default function VaultSetup({ children }) {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState('status');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saved, setSaved] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState('new');
  const [restarting, setRestarting] = useState(false);

  async function check() {
    setPending('status'); setError(''); setFeedback('');
    try {
      const next = await api.invoke('security.status');
      if (!validStatus(next)) throw new Error('The app could not verify private-data protection. Update or repair Exomina before opening your workspace.');
      setStatus(next);
    } catch (err) { setStatus(null); setError(readableError(err)); }
    finally { setPending(''); }
  }
  useEffect(() => { check(); }, []);

  async function exportRecovery(event) {
    event.preventDefault();
    const existing = recoveryMode === 'existing';
    if (pending) return;
    setError(''); setFeedback('');
    if (existing && !password.length) { setError('Enter the password for your saved PFX file, then choose the file to verify it.'); return; }
    if (!existing && password.length < 16) { setError('Use at least 16 characters for the new recovery password, then enter it again in Confirm password.'); return; }
    if (!existing && !confirmation) { setError('Enter the same password in Confirm password before saving the recovery key.'); return; }
    if (!existing && password !== confirmation) { setError('The two passwords do not match. Enter the same password in both fields.'); return; }
    setPending(existing ? 'verify' : 'export');
    try {
      // This secret crosses the isolated desktop IPC boundary only. It is never
      // stored in browser storage, included in chat context, or sent to tools.
      const result = await api.invoke(existing ? 'security.verifyRecovery' : 'security.exportRecovery', { password });
      if (result?.saved === true) setSaved(true);
      else if (result?.saved === false) setFeedback(existing ? 'File selection was canceled. Enter the password again and choose your saved PFX file to continue.' : 'Saving was canceled. Enter the password again and choose where to save the recovery file.');
      else throw new Error('The app did not confirm whether the recovery file was saved or verified. Try again.');
    } catch (err) { setError(readableError(err)); }
    finally { setPassword(''); setConfirmation(''); setPending(''); }
  }
  async function protect() {
    if (!status?.supported || (!saved && status.needsRecovery) || pending) return;
    setPending('protect'); setError('');
    try {
      const result = await api.invoke('security.protect', {});
      if (result?.restarting === true) { setRestarting(true); return; }
      // A completed call alone never opens private data. Recheck the authority.
      await check();
    } catch (err) { setError(readableError(err)); }
    finally { setPending(''); }
  }

  async function useStandard() {
    if (pending || status?.canUseStandard !== true) return;
    setPending('mode'); setError('');
    try {
      const result = await api.invoke('security.useStandard', {});
      if (result?.restarting === true) setRestarting(true);
      else await check();
    } catch (err) { setError(readableError(err)); }
    finally { setPending(''); }
  }

  const ready = typeof status?.ready === 'boolean' ? status.ready : status?.protected === true;
  if (status?.supported === true && ready && status.needsRecovery === false && !restarting) return children;
  const recoveryReady = saved || status?.needsRecovery === false;
  return <main className="auth-page vault-page"><div className="auth-brand"><span className="brand-mark"><BrandMark /></span><span>Exomina</span></div><section className="auth-card vault-card"><div className="auth-lock"><ShieldCheck size={26} strokeWidth={1.5} /></div><div className="eyebrow">PRIVATE DATA</div><h1>{restarting ? 'Restarting Exomina' : status?.supported ? 'Protect your workspace' : 'Check data protection'}</h1>{restarting ? <div className="vault-restarting" role="status"><LoaderCircle size={21} className="spin" /><p>Exomina is restarting. Your workspace will open after the app verifies its storage.</p></div> : <><p>Chats, memory, and account data stay closed until the app confirms that local protection is ready.</p>{status?.message && <p className="vault-status-message">{status.message}</p>}{status?.dataPath && <div className="vault-data-path"><span>Private data folder</span><code>{status.dataPath}</code></div>}{feedback && <p className="vault-status-message" role="status">{feedback}</p>}{error && <p className="inline-error" role="alert">{error}</p>}{pending === 'status' ? <div className="auth-loading" role="status"><LoaderCircle size={18} className="spin" />Checking protection…</div> : !status || !status.supported ? <button className="secondary-button" onClick={check} disabled={!!pending}><RefreshCw size={15} />Check again</button> : <><div className="vault-step"><span className={`vault-step-number ${recoveryReady ? 'complete' : ''}`}>{recoveryReady ? <Check size={15} /> : '1'}</span><div><h2>{recoveryMode === 'existing' ? 'Verify your recovery key' : 'Save your recovery key'}</h2><p>Keep the password-encrypted PFX file and its password safe: you may need them to recover your data after reinstalling Windows.</p></div></div>{recoveryReady ? <p className="vault-backup-saved" role="status"><Check size={16} />{recoveryMode === 'existing' ? 'Recovery backup verified.' : 'Recovery backup saved.'}</p> : <><div className="vault-recovery-mode" aria-label="Recovery key options"><button type="button" aria-pressed={recoveryMode === 'new'} disabled={!!pending} onClick={() => { setRecoveryMode('new'); setPassword(''); setConfirmation(''); setError(''); setFeedback(''); }}>Create a new recovery key</button><button type="button" aria-pressed={recoveryMode === 'existing'} disabled={!!pending} onClick={() => { setRecoveryMode('existing'); setPassword(''); setConfirmation(''); setError(''); setFeedback(''); }}>Use an existing recovery key</button></div><form className="vault-password-form" onSubmit={exportRecovery} noValidate><label className="input-label" htmlFor="recovery-password">Recovery file password</label><input id="recovery-password" type="password" autoComplete={recoveryMode === 'existing' ? 'off' : 'new-password'} spellCheck={false} minLength={recoveryMode === 'existing' ? 1 : 16} value={password} onChange={event => { setPassword(event.target.value); setError(''); setFeedback(''); }} disabled={!!pending} required /><p>{recoveryMode === 'existing' ? 'Enter the password for your saved PFX file, then choose that file. Verification happens locally; your password never leaves this PC.' : 'Use at least 16 characters. Exomina does not save this password.'}</p>{recoveryMode === 'new' && <><label className="input-label" htmlFor="recovery-password-confirm">Confirm password</label><input id="recovery-password-confirm" type="password" autoComplete="new-password" spellCheck={false} value={confirmation} onChange={event => { setConfirmation(event.target.value); setError(''); setFeedback(''); }} disabled={!!pending} required />{confirmation && confirmation !== password && <p className="vault-password-mismatch">The passwords do not match.</p>}</>}<button className="secondary-button" disabled={!!pending}>{pending === 'export' || pending === 'verify' ? <LoaderCircle size={15} className="spin" /> : recoveryMode === 'existing' ? <FolderOpen size={15} /> : <Download size={15} />}{pending === 'verify' ? 'Verifying recovery key…' : pending === 'export' ? 'Saving recovery key…' : recoveryMode === 'existing' ? 'Choose and verify recovery key' : 'Save recovery key'}</button></form></>}<div className="vault-step"><span className="vault-step-number">2</span><div><h2>Enable protection</h2><p>Exomina will protect its private data folder and restart. The recovery backup must be saved or verified before you continue.</p></div></div><button className="primary-button vault-protect-button" disabled={!recoveryReady || !!pending} onClick={protect}>{pending === 'protect' ? <LoaderCircle size={16} className="spin" /> : <LockKeyhole size={16} />}Protect and restart</button></>}</>}<>{status?.canUseStandard === true && !restarting && <button className="secondary-button" disabled={!!pending} onClick={useStandard}>Use standard storage instead</button>}</><div className="auth-note"><LockKeyhole size={12} /><span>This setup does not send your recovery password to an AI provider.</span></div></section></main>;
}
