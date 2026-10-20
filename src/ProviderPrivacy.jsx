import React from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { PROVIDER_PRIVACY } from '../desktop/privacy.mjs';
import './privacy.css';

export default function ProviderPrivacy({ provider, openExternal }) {
  const privacy = PROVIDER_PRIVACY[provider];
  if (!privacy) return null;
  return <details className="provider-privacy"><summary><ShieldCheck size={13} />Privacy &amp; training</summary>
    <p>{privacy.summary}</p><p className="connection-small">{privacy.detail}</p>
    <button type="button" className="text-button" onClick={() => openExternal(privacy.url)}>{privacy.label}<ExternalLink size={11} /></button>
    <button type="button" className="text-button" onClick={() => openExternal(privacy.policyUrl)}>Read provider policy<ExternalLink size={11} /></button>
    <p className="connection-small">{privacy.temporary ? 'Temporary chats are available as text-only chats. They do not change provider-side training or retention.' : 'Temporary chat is unavailable for this connection.'}</p>
  </details>;
}
