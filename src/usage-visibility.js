/** Usage is shown for connected accounts only. Cached numbers stay until connections have been checked, then vanish for any account that is signed out. */
export function shownUsageProviders(connections = [], usage = {}, names = {}) {
  const state = new Map(connections.map(item => [item.id, item]));
  const visible = id => { const item = state.get(id); return !item || item.connected || item.checking === true; };
  return [...new Set([...connections.filter(item => item.connected).map(item => item.id), ...Object.keys(usage)])].filter(id => names[id] && visible(id));
}
