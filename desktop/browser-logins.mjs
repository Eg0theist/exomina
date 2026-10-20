export function browserWebUrl(value, { blank = false } = {}) {
  if (blank && (value === '' || value === 'about:blank')) return 'about:blank';
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP and HTTPS pages are allowed.');
  return url.href;
}

/** Preserve the real opener and shared browser session for OAuth and normal login popups. */
export function attachLoginPopups(wc, { window, browserSession, onError = () => {}, onPopup = () => {} }) {
  const children = new Set(), cleanups = new Map();
  let visible = false;
  function attach(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      try { browserWebUrl(url, { blank: true }); } catch { return { action: 'deny' }; }
      if (!visible || children.size >= 4) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: window, width: 600, height: 760, show: false, autoHideMenuBar: true,
        webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
      } };
    });
    const guard = (event, url) => { try { browserWebUrl(url, { blank: true }); } catch { event.preventDefault(); } };
    contents.on('will-navigate', guard); contents.on('will-redirect', guard);
    const created = child => {
      const childContents = child.webContents;
      children.add(child); child.setMenu(null); attach(childContents); onPopup(childContents);
      child.once('ready-to-show', () => { if (visible && !child.isDestroyed()) child.show(); });
      childContents.on('did-fail-load', (_event, code, description, _url, main) => { if (main && code !== -3) onError(Error(description)); });
      child.once('closed', () => { children.delete(child); cleanups.get(childContents)?.(); cleanups.delete(childContents); });
    };
    contents.on('did-create-window', created);
    cleanups.set(contents, () => { contents.removeListener('will-navigate', guard); contents.removeListener('will-redirect', guard); contents.removeListener('did-create-window', created); });
  }
  attach(wc);
  return {
    setWindow(next) { window = next; for (const child of children) if (!child.isDestroyed()) child.setParentWindow?.(next); },
    owns: contents => contents === wc || [...children].some(child => !child.isDestroyed() && child.webContents === contents),
    show(value) { visible = !!value; for (const child of children) if (!child.isDestroyed()) { if (visible) child.show(); else child.hide(); } },
    close() { for (const child of [...children]) if (!child.isDestroyed()) child.destroy(); for (const cleanup of cleanups.values()) cleanup(); cleanups.clear(); },
  };
}
