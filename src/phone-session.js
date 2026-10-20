const key = deviceId => 'exomina-phone-drafts-v1:' + deviceId;
export const phoneDraftKey = id => id || '$new';

export function loadPhoneSession(storage, deviceId) {
  try {
    const value = JSON.parse(storage.getItem(key(deviceId)) || '{}');
    const drafts = Object.fromEntries(Object.entries(value.drafts || {}).filter(([id, text]) => id.length <= 100 && typeof text === 'string' && text.length <= 100000).slice(-20));
    return { selectedId: typeof value.selectedId === 'string' ? value.selectedId : null, drafts };
  } catch { return { selectedId: null, drafts: {} }; }
}

export function savePhoneSession(storage, deviceId, selectedId, drafts) {
  try {
    const entries = Object.entries(drafts).filter(([, text]) => typeof text === 'string' && text.length > 0);
    // Keep the selected draft even when the session has reached its history bound.
    const selected = phoneDraftKey(selectedId);
    entries.sort(([a], [b]) => Number(a === selected) - Number(b === selected));
    storage.setItem(key(deviceId), JSON.stringify({ selectedId, drafts: Object.fromEntries(entries.slice(-20)) }));
    return true;
  } catch { return false; }
}

export function clearPhoneSession(storage, deviceId) {
  try { storage.removeItem(key(deviceId)); } catch { /* Forget still removes the device keys. */ }
}
