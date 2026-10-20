import { PanelLeft } from 'lucide-react';
import BrandMark from './BrandMark.jsx';
import './window-header.css';

export const hasWindowHeader = state => !!state?.borderless && !state.fullscreen;

/** The draggable window bar doubles as the app toolbar; interactive children opt out of dragging. */
export default function WindowHeader({ state, sidebarCollapsed = false, onToggleSidebar, onHome, children }) {
  if (!hasWindowHeader(state)) return null;
  return <header className={`window-header ${state.focused === false ? 'is-unfocused' : ''} ${state.platform === 'darwin' ? 'mac-controls' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} aria-label="Exomina window">
    <div className="window-header-lead">
      {onToggleSidebar && <button type="button" className="window-header-button sidebar-toggle" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-pressed={!sidebarCollapsed} title={`${sidebarCollapsed ? 'Show' : 'Hide'} sidebar (Ctrl+B)`} onClick={onToggleSidebar}><PanelLeft size={16} strokeWidth={1.7} /></button>}
      <button type="button" className="window-header-home" aria-label="Exomina home" title="New chat" onClick={onHome}><BrandMark /><span className="window-header-brand">Exomina</span></button>
    </div>
    {children}
  </header>;
}
