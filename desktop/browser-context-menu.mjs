// Native browser actions target the page that was clicked, including its edit
// selection. Electron menu roles would otherwise act on the app's main renderer.
function webUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function browserContextMenuTemplate(wc, params, { clipboard, navigate, openExternal, openTab }) {
  const template = [], flags = params.editFlags || {};
  const action = method => () => { wc.focus(); wc[method](); };
  const group = items => { if (!items.length) return; if (template.length) template.push({ type: 'separator' }); template.push(...items); };
  const history = wc.navigationHistory;
  group([
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: wc.isLoading() ? 'Stop loading' : 'Reload', click: wc.isLoading() ? () => wc.stop() : () => wc.reload() },
  ]);
  if (params.isEditable) {
    const spelling = (params.dictionarySuggestions || []).slice(0, 5).map(word => ({ label: word, click: () => { wc.focus(); wc.replaceMisspelling(word); } }));
    if (params.misspelledWord) group([...spelling,
      { label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
    ]);
    group([
      { label: 'Undo', enabled: !!flags.canUndo, click: action('undo') },
      { label: 'Redo', enabled: !!flags.canRedo, click: action('redo') },
    ]);
    group([
      { label: 'Cut', enabled: !!flags.canCut, click: action('cut') },
      { label: 'Copy', enabled: !!flags.canCopy, click: action('copy') },
      { label: 'Paste', enabled: !!flags.canPaste, click: action('paste') },
      { label: 'Select all', enabled: flags.canSelectAll !== false, click: action('selectAll') },
    ]);
  } else if (params.selectionText) {
    group([{ label: 'Copy', click: action('copy') }, { label: 'Select all', click: action('selectAll') }]);
  }
  if (params.linkURL) {
    const url = webUrl(params.linkURL);
    group([
      ...(url ? [
        { label: 'Open link', click: () => navigate(url) },
        ...(openTab ? [{ label: 'Open link in new tab', click: () => openTab(url) }] : []),
        { label: 'Open link in default browser', click: () => openExternal(url) },
      ] : []),
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image') {
    const url = webUrl(params.srcURL);
    group([
      ...(params.hasImageContents && Number.isFinite(params.x) && Number.isFinite(params.y) ? [
        { label: 'Copy image', click: () => { wc.focus(); wc.copyImageAt(params.x, params.y); } },
      ] : []),
      ...(params.srcURL ? [{ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) }] : []),
      ...(url ? [{ label: 'Open image', click: () => navigate(url) }] : []),
    ]);
  }
  const pageUrl = webUrl(wc.getURL());
  if (pageUrl) group([{ label: 'Open page in default browser', click: () => openExternal(pageUrl) }]);
  return template;
}

export function attachBrowserContextMenu(wc, { Menu, window, getWindow = () => window, isVisible = () => true, onError = () => {}, ...options }) {
  let menu;
  const close = () => { menu?.closePopup(getWindow()); menu = null; };
  const listener = (_event, params) => {
    if (wc.isDestroyed() || !isVisible()) return;
    close();
    const template = browserContextMenuTemplate(wc, params, options);
    for (const item of template) if (item.click) {
      const click = item.click;
      item.click = () => {
        if (wc.isDestroyed() || !isVisible()) return;
        Promise.resolve().then(click).catch(onError);
      };
    }
    menu = Menu.buildFromTemplate(template);
    menu.popup({ window: getWindow() });
  };
  wc.on('context-menu', listener);
  return () => { close(); wc.removeListener('context-menu', listener); };
}
