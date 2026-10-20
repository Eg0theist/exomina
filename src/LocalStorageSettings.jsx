import React, { useState } from 'react';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { api } from './transport.js';

export default function LocalStorageSettings({ security = {}, active = false }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const encrypted = security.mode === 'efs' && security.folderEncrypted === true;
  async function enableEncryption() {
    setPending(true); setError('');
    try {
      const result = await api.invoke('security.useEncrypted', { confirm: true });
      if (result?.restarting !== true) throw Error('Exomina did not confirm the restart. Try again.');
    } catch (failure) { setError((failure.message || String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, '')); setPending(false); }
  }
  return <div className="settings-row"><div><strong>Storage on this device</strong>{encrypted ? <p>Your private app files use Windows EFS encryption. Keep your password-protected recovery backup safe.</p> : <><p>Chats and provider profiles stay in your local user profile. Keys added in Connections use protected operating-system storage. Chats and some provider sign-in files rely on user permissions and your device’s disk encryption.</p>{security.secretStorageStatus === 'unchecked' && <p>Credential storage is checked when you add or unlock a key. macOS may ask for Keychain access.</p>}{security.encryptionAvailable === true && !confirm && <button className="text-button" disabled={active || pending} onClick={() => setConfirm(true)}><ShieldCheck size={14} />Enable full-folder encryption</button>}</>}{confirm && <div className="revoke-confirm"><p>Exomina will restart into Windows EFS setup. Save a recovery backup before encrypting your private app files.</p><button className="secondary-button" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button><button className="secondary-button" disabled={active || pending} onClick={enableEncryption}>{pending && <LoaderCircle size={14} className="spin" />}{pending ? 'Restarting…' : 'Continue to encryption setup'}</button></div>}{active && confirm && <p>Finish the current conversation or voice session before restarting.</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div></div>;
}
