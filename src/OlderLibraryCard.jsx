import React, { useState } from 'react';
import { api } from './transport.js';

/** Offered until answered: an older library exists and this install did not open it. */
export default function OlderLibraryCard({ library }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!library) return null;
  async function choose(method) {
    setPending(true); setError('');
    try { await api.invoke(method); }
    catch (failure) { setError((failure.message || String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, '')); setPending(false); }
  }
  return <div className="older-library-card" role="status"><div>
    <strong>Exomina found an older library on this computer</strong>
    <p>{library.folder} may hold chats and sign-ins from another Exomina installation. This one started with its own empty library. Nothing was changed.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div><div className="settings-row-actions">
    <button type="button" className="secondary-button" disabled={pending} onClick={() => choose('library.useOlder')}>Open older library</button>
    <button type="button" className="secondary-button" disabled={pending} onClick={() => choose('library.keepCurrent')}>Keep this library</button>
  </div></div>;
}
