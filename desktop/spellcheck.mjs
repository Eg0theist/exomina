/** Spellchecking is configured per app session: enabled state plus any number of
 * simultaneous dictionaries. An empty language list follows the Windows display
 * languages that have a dictionary.
 */
export function spellcheckSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  if ('enabled' in source && typeof source.enabled !== 'boolean') throw new Error('Choose whether spellcheck is on.');
  const languages = source.languages === undefined ? [] : source.languages;
  if (!Array.isArray(languages) || languages.length > 12 || languages.some(code => typeof code !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(code))) throw new Error('Choose up to 12 spellcheck languages.');
  return { enabled: source.enabled !== false, languages: [...new Set(languages)] };
}

/** Maps preferred system languages (de-DE, en-GB…) onto available dictionaries. */
export function defaultLanguages(available, preferred = []) {
  const chosen = [];
  for (const code of preferred) {
    const exact = available.find(item => item.toLowerCase() === String(code).toLowerCase());
    const base = String(code).split('-')[0].toLowerCase();
    const match = exact || available.find(item => item.toLowerCase() === base) || available.find(item => item.toLowerCase().startsWith(base + '-'));
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen.length ? chosen.slice(0, 4) : available.filter(item => /^en(?:-US)?$/i.test(item)).slice(0, 1);
}

export function applySpellcheck(session, value, preferred = []) {
  const settings = spellcheckSettings(value);
  session.setSpellCheckerEnabled(settings.enabled);
  const available = session.availableSpellCheckerLanguages || [];
  const languages = (settings.languages.length ? settings.languages : defaultLanguages(available, preferred)).filter(code => available.includes(code));
  // setSpellCheckerLanguages is a no-op on macOS; Windows/Linux use these dictionaries.
  if (settings.enabled && languages.length) { try { session.setSpellCheckerLanguages(languages); } catch { /* keep the previous dictionaries */ } }
  return { ...settings, active: settings.enabled ? languages : [], available };
}

/** Native context menu with spelling suggestions and standard edit actions. */
export function attachContextMenu(webContents, { Menu, clipboard, getSpellcheck, setSpellcheckEnabled }) {
  webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
      if (!params.dictionarySuggestions.length) template.push({ label: 'No suggestions', enabled: false });
      template.push({ label: 'Add to dictionary', click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    }
    if (params.isEditable) {
      template.push({ role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll' }, { type: 'separator' },
        { label: 'Check spelling', type: 'checkbox', checked: getSpellcheck().enabled !== false, click: item => setSpellcheckEnabled(item.checked) });
    } else if (params.selectionText?.trim()) template.push({ role: 'copy' }, { role: 'selectAll' });
    if (params.linkURL && /^https?:/i.test(params.linkURL)) template.push(...(template.length ? [{ type: 'separator' }] : []), { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}
