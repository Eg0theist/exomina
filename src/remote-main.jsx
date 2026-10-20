import React from 'react';
import { createRoot } from 'react-dom/client';
import RemoteApp from './RemoteApp.jsx';
import { applyCachedAppearance } from './appearance.js';
import './theme.css';
import './styles.css';
import './remote.css';

// Consume the QR fragment before any network operation or rendering. Never store its secret.
const link = location.hash ? location.href : '';
if (link) history.replaceState(null, '', location.pathname);
document.documentElement.dataset.phone = 'true';
applyCachedAppearance();
createRoot(document.getElementById('root')).render(<RemoteApp pairingLink={link}/>);
