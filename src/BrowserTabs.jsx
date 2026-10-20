import React from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import './browser-tabs.css';

const MAX_TABS = 8;
function tabLabel(tab) {
  if (tab.title && tab.title !== 'Browser') return tab.title;
  try { return new URL(tab.url).hostname || 'New tab'; } catch { return 'New tab'; }
}

/** Tabs of the current chat's built-in browser. A chat that never opened a page shows one empty tab. */
export default function BrowserTabs({ info, onNew, onSelect, onClose }) {
  const tabs = info.tabs?.length ? info.tabs : [{ id: '', url: info.url || '', title: info.title || '', loading: !!info.loading }];
  const activeId = info.tabs?.length ? info.activeTabId : '';
  const real = id => id && !id.startsWith('saved-');
  return <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
    {tabs.map(tab => {
      const label = tabLabel(tab), active = tab.id === activeId;
      return <div key={tab.id || 'empty'} className={`browser-tab${active ? ' active' : ''}`}>
        <button type="button" role="tab" aria-selected={active} title={tab.url || label} onClick={() => { if (!active && real(tab.id)) onSelect(tab.id); }}>
          {tab.loading && <LoaderCircle size={11} className="spin" aria-hidden="true" />}<span>{label}</span>
        </button>
        {real(tab.id) && <button type="button" className="browser-tab-close" aria-label={`Close tab ${label}`} title="Close tab" onClick={() => onClose(tab.id)}><X size={11} /></button>}
      </div>;
    })}
    <button type="button" className="browser-tab-add" aria-label="New tab" title={tabs.length >= MAX_TABS ? `Up to ${MAX_TABS} tabs per chat` : 'New tab'} disabled={tabs.length >= MAX_TABS} onClick={onNew}><Plus size={14} /></button>
  </div>;
}
