import React, { useState } from 'react';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { api } from './transport.js';

export default function RecoveryAudit({ audit = {}, active = false, onChange }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const checking = pending || audit.status === 'checking';
  const checked = audit.checkedAt && new Date(audit.checkedAt);
  const lastCheck = checked && !Number.isNaN(checked.getTime()) ? checked.toLocaleString() : null;
  async function check() {
    setPending(true); setError('');
    try {
      const result = await api.invoke('security.auditRecovery');
      if (result?.status !== 'verified') throw Error('The full recovery check did not confirm a result. Try again.');
      onChange(result);
    } catch (failure) { setError((failure.message || String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setPending(false); }
  }
  return <div className="settings-row recovery-audit-row"><div><strong>Recovery backup</strong><p>Check encryption and recovery access across your private app files. This full check runs on request, not at startup.</p><p className="recovery-audit-status" role="status">{checking ? 'Checking all private app files…' : audit.status === 'error' || error ? 'Last full check: failed.' : lastCheck ? `Last full check: ${lastCheck}` : 'Last full check: not checked in this version.'}</p>{(error || audit.status === 'error') && <p className="inline-error" role="alert">{error || audit.message || 'The full check could not be completed.'} Resolve the reported issue, then run the check again.</p>}{active && <p>Finish the current reply before starting a full check.</p>}</div><button className="secondary-button" onClick={check} disabled={checking || active}>{checking ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}{checking ? 'Checking recovery…' : 'Check recovery'}</button></div>;
}
