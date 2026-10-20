import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceGate from './WorkspaceGate.jsx';
import QuickAsk from './QuickAsk.jsx';
import { applyCachedAppearance } from './appearance.js';
// Theme tokens first: every sheet below resolves its colours through them.
import './theme.css';
import './styles.css';
import './mobile.css';
// Design layer last, so it overrides every component sheet imported above.
import './refresh.css';
import './chat-layout.css';
import './live-followups.css';
import './extravagant-themes.css';
import './extensions.css';
import './theme-materials.css';

if (window.visualViewport) {
  const updateViewport = () => document.documentElement.style.setProperty('--viewport-height', `${Math.round(window.visualViewport.height)}px`);
  updateViewport();
  window.visualViewport.addEventListener('resize', updateViewport);
}

applyCachedAppearance();
// Satellite windows are content shells. The owning App moves its existing panel
// portal here; a second App would duplicate drafts, subscriptions and approvals.
if(window.location.hash.startsWith('#workspace-panel=')){
  document.documentElement.classList.add('workflow-floating-document');
  document.getElementById('root').setAttribute('aria-label','Detached workspace panel');
}else createRoot(document.getElementById('root')).render(<React.StrictMode>{window.location.hash==='#quick'?<QuickAsk/>:<WorkspaceGate/>}</React.StrictMode>);
