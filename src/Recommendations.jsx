import React, {useCallback, useEffect, useRef, useState} from 'react';
import { Bookmark, Check, ExternalLink, LoaderCircle, MessageSquarePlus, Search, Sparkles, Square, X } from 'lucide-react';
import { api } from './transport.js';
import './discoveries.css';
import Research from './Research.jsx';

// Curated with each release: reviewed projects that are not built in. Nothing here
// is downloaded or run; "Set it up" only drafts a chat request the user can edit.
export const CATALOGUE_REVIEWED = '2026-10-19';
export const RECOMMENDATIONS = [
  { id: 'rsi-anything', name: 'RSI-Anything', url: 'https://github.com/Gen-Verse/RSI-Anything', license: 'Apache-2.0', needs: 'Python 3.10+, task-specific environments',
    what: 'Research framework for recursive self-improvement: a world model predicts the outcome of an action before it is tested, and only verified improvements are kept.',
    status: 'Idea adopted', note: 'Exomina’s working method now asks the AI to predict a check’s result first and only run checks whose outcome is uncertain. The code itself is research software, not needed for chat work.' },
  { id: 'pentagi', name: 'PentAGI', url: 'https://github.com/vxcontrol/pentagi', license: 'MIT', needs: 'Docker, provider API keys',
    what: 'Self-hosted multi-agent system for authorised penetration testing, with a reflector agent, repeated-call detection and hard tool-call limits.',
    status: 'Idea adopted', note: 'Its loop limits inspired the “change approach after two failures” rule. Install only for security testing you are authorised to do.' },
  { id: 'treg', name: 'treg', url: 'https://github.com/superdesigndev/treg', license: 'Apache-2.0 plus commercial service restrictions', needs: 'treg account; hosted calls can use a prepaid balance',
    what: 'One token and base URL for thousands of third-party API endpoints (SEO, enrichment, search); keys stay server-side with an audit log.',
    status: 'Later', note: 'An optional way to access SEO and research APIs. The hosted catalogue publishes per-call prices; your own connected keys use their upstream billing. Its licence requires written permission to embed the code in a commercially distributed product or provide a service to third parties.' },
  { id: 'orcarouter', name: 'OrcaRouter tools skill', url: 'https://github.com/Continuum-AI-Corp/orcarouter-tools-skills', license: 'MIT', needs: 'OrcaRouter account',
    what: 'A SKILL.md that connects agents to 1,400+ APIs: search, SEO, social platforms, company data, finance.',
    status: 'Later', note: 'Overlaps with treg. Pick one if you start automating competitive or SEO research.' },
  { id: 'appllama', name: 'Appllama skills', url: 'https://github.com/Appllama/appllama-skills', license: 'MIT', needs: 'Node, Appllama MCP, Expo',
    what: 'Design skills for native-feeling Expo / React Native screens, verified by recording whole flows in a simulator.',
    status: 'Only for mobile apps', note: 'Relevant if you build a mobile app. Its frame-by-frame flow check is a good pattern for UI verification.' },
];

const setupPrompt = item => `Set up ${item.name} (${item.url}) for me. First read its README and licence, tell me what it needs (accounts, costs, Docker, Python…) and what it would be able to do on this computer, then wait for my approval before installing or registering anything.`;
export const discoveryPrompt = `Find a few things worth knowing based on my saved interests, projects and preferences. Look beyond software: useful tools, articles, research, creative inspiration and opportunities are all welcome. Use the shared browser to verify sources and dates, explain why each is relevant to me, and include material costs or setup effort. Do not install anything.`;

const emptySettings = {frequency:'off',provider:'',topics:'',webResearch:false,focus:'mixed'};
const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /,'');
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : '';

export default function Recommendations({onAsk, onOpenChat, connections = [], providers = []}) {
  const [view,setView] = useState(null), [form,setForm] = useState(emptySettings), [busy,setBusy] = useState(false), [error,setError] = useState(''), [filter,setFilter] = useState('new');
  const [preferencesOpen,setPreferencesOpen] = useState(true);
  const loaded = useRef(false);
  const load = useCallback(async()=>{
    try { const next = await api.invoke('discoveries.view'); setView(next); if(!loaded.current){loaded.current=true;setForm({...emptySettings,...next.settings});setPreferencesOpen(!next.settings?.webResearch);} }
    catch(error){setError(errorText(error));}
  },[]);
  useEffect(()=>{load();return api.onEvent(event=>{if(event.type==='discoveries.changed')load();});},[load]);
  const choices = connections.filter(connection=>connection.connected && ['codex','claude'].includes(connection.id) && providers.some(provider=>provider.id===connection.id && provider.mode==='subscription'));
  const selectedProvider = form.provider || choices[0]?.id || '';
  const providerName = id => providers.find(provider=>provider.id===id)?.name || id;
  const items = view?.items || [], shown = items.filter(item=>item.status===filter), running = view?.last?.status==='running';
  async function action(work) {
    setBusy(true);setError('');
    try { const next = await work(); if(next)setView(next); }
    catch(error){setError(errorText(error));}
    finally{setBusy(false);}
  }
  const save = async()=>{const next=await api.invoke('discoveries.configure',{...form,provider:selectedProvider});setForm(next.settings);setView(next);setPreferencesOpen(false);return next;};
  return <><Research connections={connections} providers={providers} onOpenChat={onOpenChat}/><section className="recommendations discoveries" aria-label="Worth knowing">
    <div className="discovery-heading"><div><div className="eyebrow">YOUR DISCOVERIES</div><h2>Worth knowing</h2><p>Things that connect to your interests, your projects, and what you might want to try next.</p></div><Sparkles size={24} strokeWidth={1.3} /></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!view && !error && <p role="status"><LoaderCircle size={14} className="spin" />Loading discoveries…</p>}
    <details className="discovery-preferences" open={preferencesOpen} onToggle={event=>setPreferencesOpen(event.currentTarget.open)}>
      <summary><span>Personalise your discoveries</span><small>{view?.settings?.webResearch ? `${providerName(view.settings.provider)} · ${view.settings.frequency==='off'?'search when you ask':view.settings.frequency}` : 'Research is off'}</small></summary>
      <label className="discovery-consent"><input type="checkbox" checked={form.webResearch} disabled={busy} onChange={event=>{const webResearch=event.target.checked;setForm({...form,webResearch});if(!webResearch)action(()=>api.invoke('discoveries.configure',{...(view?.settings || form),webResearch:false}));}} /><span><strong>Allow public web research</strong><small>Your selected AI can research public topics in the shared browser. Interests are derived from saved memory on this device; raw notes and private chats are kept out of the research. Searches count towards your subscription usage. Your permission rules still apply.</small></span></label>
      {!!view?.interests?.length && <div className="discovery-interests" aria-label="Interests from saved memory">{view.interests.map(topic=><span key={topic}>{topic}</span>)}</div>}
      <div className="discovery-fields">
        <label>Research with<select aria-label="Discovery AI" value={selectedProvider} disabled={busy || running} onChange={event=>setForm({...form,provider:event.target.value})}><option value="">Choose a connected AI</option>{form.provider && !choices.some(item=>item.id===form.provider) && <option value={form.provider}>{providerName(form.provider)} · disconnected</option>}{choices.map(item=><option key={item.id} value={item.id}>{providerName(item.id)}</option>)}</select></label>
        <label>Look for new things<select aria-label="Discovery frequency" value={form.frequency} disabled={busy || running} onChange={event=>setForm({...form,frequency:event.target.value})}><option value="off">Only when I ask</option><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
        <label>Find<select aria-label="Discovery focus" value={form.focus} disabled={busy || running} onChange={event=>setForm({...form,focus:event.target.value})}><option value="mixed">A mix of my interests</option><option value="tools">Tools &amp; repositories to implement</option></select></label>
      </div>
      <label className="discovery-topics">Anything to focus on? <span>Optional · these topics may appear in public searches</span><textarea aria-label="Discovery interests" maxLength={2000} rows={2} placeholder="An interest, something you want to learn, a public topic to explore…" value={form.topics} disabled={busy || running} onChange={event=>setForm({...form,topics:event.target.value})} /></label>
      <p className="connection-small">{view?.memoryEnabled ? 'Uses the broad interests above as well as any focus you enter. Add a focus if your interests are more specific.' : 'Shared memory is off. Add interests above to guide your discoveries.'} Automatic searches start off disabled, run while Exomina is open or in the tray, and never catch up after a missed time.</p>
      <div className="discovery-actions"><button className="secondary-button" disabled={busy || running} onClick={()=>action(save)}><Check size={14} />Save preferences</button></div>
      {view && !view.browserEnabled && <p className="discovery-notice">Enable browser tools above to search. No discovery requests are sent while they are off.</p>}
      {!choices.length && <p className="discovery-notice">Connect ChatGPT or Claude in Settings to search for personal discoveries.</p>}
      {view?.nextRun && view.settings?.frequency!=='off' && <p className="connection-small">Next automatic search: {date(view.nextRun)}. Each search stops after five minutes or 18 browser reads.</p>}
    </details>
    <div className="discovery-actions"><button className="primary-button" disabled={busy || running || !view?.browserEnabled || !form.webResearch || !choices.some(item=>item.id===selectedProvider) || (view?.runsToday || 0)>=(view?.dailyLimit || 3)} onClick={()=>action(async()=>{await save();return api.invoke('discoveries.run');})}>{busy ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}Find for me</button>{running && <button className="secondary-button" disabled={busy} onClick={()=>action(()=>api.invoke('discoveries.stop'))}><Square size={12} />Stop search</button>}<span className="discovery-budget">{view?.runsToday || 0}/{view?.dailyLimit || 3} searches today · up to 5 finds per search</span></div>
    {view?.last && <div className="discovery-run-status" role="status"><span>{running ? 'Looking for things that fit your interests…' : view.last.status==='complete' ? `${view.last.added || 0} new ${(view.last.added || 0)===1?'discovery':'discoveries'} from the last search${view.last.finishedAt ? ' · '+date(view.last.finishedAt) : ''}` : view.last.error || (view.last.status==='stopped' ? 'Search stopped.' : 'The last search did not finish.')}</span>{view.last.conversationId && onOpenChat && <button className="text-button" onClick={()=>onOpenChat(view.last.conversationId)}>Open research chat</button>}</div>}
    <div className="discovery-tabs" role="group" aria-label="Filter discoveries">{[['new','For you'],['saved','Saved'],['dismissed','Dismissed']].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}<span>{items.filter(item=>item.status===key).length}</span></button>)}</div>
    <div className="discovery-feed">{shown.length ? shown.map(item=><article className="discovery-card" key={item.id}>
      <div className="discovery-card-source"><span>{new URL(item.url).hostname.replace(/^www\./,'')}</span><time dateTime={item.foundAt}>Found {date(item.foundAt)}</time></div>
      <h3>{item.title}</h3><p>{item.summary}</p><p className="discovery-reason"><Sparkles size={13} /><span>{item.reason}</span></p>
      <div className="discovery-card-actions"><button className="text-button" onClick={()=>action(()=>api.invoke('app.openExternal',{url:item.url}).then(()=>null))}><ExternalLink size={13} />Read source</button>{onAsk && <button className="text-button" onClick={()=>onAsk(`Explore this discovery with me: ${item.title} (${item.url}). It was suggested because: ${item.reason}. Verify the source and help me decide whether it is useful for my current projects.`)}><MessageSquarePlus size={13} />Explore</button>}<button className="text-button" disabled={busy} aria-label={`${item.status==='saved'?'Unsave':'Save'} ${item.title}`} onClick={()=>action(()=>api.invoke('discoveries.feedback',{id:item.id,status:item.status==='saved'?'new':'saved'}))}><Bookmark size={13} fill={item.status==='saved'?'currentColor':'none'} />{item.status==='saved'?'Saved':'Save'}</button><button className="text-button" disabled={busy} aria-label={`${item.status==='dismissed'?'Restore':'Dismiss'} ${item.title}`} onClick={()=>action(()=>api.invoke('discoveries.feedback',{id:item.id,status:item.status==='dismissed'?'new':'dismissed'}))}><X size={13} />{item.status==='dismissed'?'Restore':'Dismiss'}</button>{item.conversationId && onOpenChat && <button className="text-button" onClick={()=>onOpenChat(item.conversationId)}>Research</button>}</div>
    </article>) : <div className="discovery-empty"><Sparkles size={24} strokeWidth={1.3} /><h3>{filter==='saved'?'Keep the good finds here':filter==='dismissed'?'Nothing dismissed':'Your interests are the starting point'}</h3><p>{filter==='saved'?'Save something from For you to return to it later.':filter==='dismissed'?'Dismissed finds stay out of future suggestions. You can restore them here.':'Ask Exomina to look for a few strong matches, or choose a weekly search. New finds will appear here with a source and a reason they fit you.'}</p></div>}</div>
    <details className="discovery-team"><summary><span>From the Exomina team</span><small>{RECOMMENDATIONS.length} ideas to explore</small></summary><p className="connection-small">A small selection from the people building Exomina. These are team picks, separate from your personal discoveries. Last reviewed {CATALOGUE_REVIEWED}.</p>{RECOMMENDATIONS.map(item=><article key={item.id}><div><strong>{item.name}</strong><span className="tag">{item.status}</span><p>{item.what}</p><details><summary>Requirements &amp; our take</summary><p>{item.note} · {item.license} · Needs: {item.needs}</p></details></div><button className="icon-button" aria-label={`Open ${item.name} on GitHub`} onClick={()=>action(()=>api.invoke('app.openExternal',{url:item.url}).then(()=>null))}><ExternalLink size={14} /></button>{onAsk && <button className="text-button" onClick={()=>onAsk(setupPrompt(item))}>Discuss setup</button>}</article>)}</details>
  </section></>;
}
