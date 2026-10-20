import React, { useMemo, useState } from 'react';
import { Check, Plus, Search, X } from 'lucide-react';

let names;
try { names = new Intl.DisplayNames(undefined, { type: 'language' }); } catch { names = null; }
export const languageName = code => { try { return names?.of(code) || code; } catch { return code; } };

export default function SpellcheckSettings({ spellcheck = {}, onChange, busy = false, Toggle }) {
  const enabled = spellcheck.enabled !== false;
  const chosen = spellcheck.languages || [];
  const active = spellcheck.active || [];
  const available = spellcheck.available || [];
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const choices = useMemo(() => available.filter(code => !chosen.includes(code)).map(code => ({ code, name: languageName(code) }))
    .filter(item => !query.trim() || `${item.name} ${item.code}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)), [available, chosen, query]);
  const shown = chosen.length ? chosen : active;
  const save = languages => onChange({ languages });
  return <section className="settings-section" id="settings-spelling">
    <div className="section-title"><h2>Spelling</h2></div>
    <div className="settings-row"><div><strong>Check spelling while typing</strong><p>Underlines misspelled words in the message box. Right-click a word for suggestions.</p></div><Toggle label="Check spelling while typing" checked={enabled} disabled={busy} onChange={value => onChange({ enabled: value })} /></div>
    <div className={`settings-row spell-languages ${enabled ? '' : 'is-disabled'}`}>
      <div><strong>Languages</strong><p>{chosen.length ? 'Words are accepted when they are correct in any selected language.' : 'Following your Windows languages. Add languages to choose them yourself.'}</p>
        <div className="language-chips">{shown.map(code => <span className={`language-chip ${chosen.length ? '' : 'automatic'}`} key={code}>{languageName(code)}<small>{code}</small>{chosen.length > 0 && <button type="button" aria-label={`Remove ${languageName(code)}`} disabled={busy || !enabled} onClick={() => save(chosen.filter(item => item !== code))}><X size={12} /></button>}</span>)}
          {!shown.length && <span className="language-chip automatic">No dictionary available</span>}
          <button type="button" className="language-add" disabled={busy || !enabled || !available.length || chosen.length >= 12} onClick={() => setAdding(!adding)} aria-expanded={adding}><Plus size={13} />Add language</button>
          {chosen.length > 0 && <button type="button" className="text-button" disabled={busy || !enabled} onClick={() => save([])}>Use Windows languages</button>}
        </div>
        {adding && <div className="language-picker"><div className="search-field compact"><Search size={14} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a language…" aria-label="Find a language" onKeyDown={event => { if (event.key === 'Escape') setAdding(false); }} /></div>
          <div className="language-options">{choices.map(item => <button type="button" key={item.code} onClick={() => { save([...(chosen.length ? chosen : active), item.code]); setQuery(''); }}><span>{item.name}</span><small>{item.code}</small><Check size={13} className="language-option-check" /></button>)}{!choices.length && <p>No more languages match.</p>}</div></div>}
      </div>
    </div>
  </section>;
}
