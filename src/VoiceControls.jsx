import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, Square, Volume2, ChevronDown } from 'lucide-react';
import { VoiceSession } from './voice-session.js';
import { RealtimeVoiceSession } from './realtime-voice-session.js';
import { VoicePreviewSession } from './voice-preview-session.js';
import { normalizeVoice } from '../desktop/voice-settings.mjs';
import { DISTRIBUTION_PROFILE } from '../desktop/distribution.mjs';
import useDismiss from './useDismiss.js';
import './voice.css';

const RECORDED_PREVIEWS_INCLUDED = DISTRIBUTION_PROFILE === 'personal';
// The shared beta cannot bundle OpenAI's and Anthropic's recordings; users may copy them from their own apps.
const SAMPLES_IMPORTABLE = !RECORDED_PREVIEWS_INCLUDED;
const NO_SAMPLES = { imported: false, chatgpt: [], claude: [], clear: false, importedAt: '', sources: [] };
const BUILT_IN_CLAUDE_SAMPLES = ['buttery', 'airy', 'mellow', 'glassy', 'rounded'];

function sampleSummary(samples) {
  const parts = [];
  if (samples.chatgpt.length) parts.push(`${samples.chatgpt.length} ChatGPT`);
  if (samples.claude.length) parts.push(`${samples.claude.length} Claude`);
  return parts.join(' and ');
}

export function useVoice(config) {
  const [state, update] = useState({ phase: 'idle', mode: '', transcript: '' });
  const [previewState, updatePreview] = useState({ phase: 'idle', mode: '' });
  const [samples, setSamples] = useState({ ...NO_SAMPLES, busy: false, message: '', error: '', needsFolder: false });
  const urls = useRef(new Map());
  const current = useRef(config); current.current = config;
  const dropUrls = () => { for (const url of urls.current.values()) URL.revokeObjectURL(url); urls.current.clear(); };
  // Imported recordings are decoded on demand so Exomina does not hold them in memory until a preview is played.
  const loadSample = async (voice, tone) => {
    const key = tone + ':' + voice;
    if (urls.current.has(key)) return urls.current.get(key);
    const sample = await current.current.api.invoke('voice.samples.read', { id: voice, tone });
    if (!sample?.data) return '';
    const raw = atob(sample.data), bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: sample.type }));
    urls.current.set(key, url);
    return url;
  };
  useEffect(() => {
    if (!SAMPLES_IMPORTABLE || !config.api) return undefined;
    let active = true;
    config.api.invoke('voice.samples.status').then(value => { if (active) setSamples(previous => ({ ...previous, ...value })); }).catch(() => {});
    return () => { active = false; };
  }, [config.api]);
  useEffect(() => dropUrls, []);
  const session = useRef(null);
  if (!session.current) session.current = new VoiceSession({ invoke: (method, payload) => current.current.api.invoke(method, payload), current: () => current.current, update, draft: text => current.current.onDraft(text), send: text => current.current.onSend(text) });
  const realtime = useRef(null);
  if (!realtime.current) realtime.current = new RealtimeVoiceSession({ invoke:(method,payload)=>current.current.api.invoke(method,payload),current:()=>current.current,update,onConversation:id=>current.current.onConversation(id) });
  const preview = useRef(null);
  if(!preview.current)preview.current=new VoicePreviewSession({invoke:(method,payload)=>current.current.api.invoke(method,payload),current:()=>current.current,update:updatePreview,load:SAMPLES_IMPORTABLE?loadSample:null});
  const stopPreview=useCallback(()=>preview.current.stop(),[]);
  const addSamples = async choose => {
    await stopPreview();
    setSamples(previous => ({ ...previous, busy: true, message: '', error: '', needsFolder: false }));
    try {
      const result = await current.current.api.invoke('voice.samples.import', { choose: choose === true });
      if (result.changed) dropUrls();
      const { changed, found, rejected, cancelled, message, ...status } = result;
      setSamples(previous => ({ ...previous, ...status, busy: false,
        message: cancelled ? '' : changed ? `Added ${sampleSummary({ chatgpt: Array(found.chatgpt), claude: Array(found.claude) })} voice previews.` : message,
        needsFolder: !changed && !cancelled }));
    } catch (failure) { setSamples(previous => ({ ...previous, busy: false, error: failure.message })); }
  };
  const removeSamples = async () => {
    await stopPreview();
    try { const status = await current.current.api.invoke('voice.samples.remove'); dropUrls(); setSamples(previous => ({ ...previous, ...status, message: 'Voice previews removed.', error: '', needsFolder: false })); }
    catch (failure) { setSamples(previous => ({ ...previous, error: failure.message })); }
  };
  const playPreview=useCallback(async id=>{if(session.current.mode||realtime.current.mode){updatePreview({phase:'error',mode:'',voiceId:id,error:'Stop voice before previewing another voice.'});return;}await preview.current.start({previewVoice:id});},[]);
  const stop=async()=>{await stopPreview();if(realtime.current.mode)await realtime.current.stop();if(session.current.mode)await session.current.stop();};
  useEffect(() => config.api?.onEvent(event => {session.current.receive(event);realtime.current.receive(event);preview.current.receive(event);}), [config.api]);
  useEffect(() => { session.current.scopeChanged(config.conversationId || '', config.page);realtime.current.scopeChanged(config.conversationId||'',config.page,config.provider);preview.current.scopeChanged(config.conversationId||'',config.page,config.provider); }, [config.conversationId, config.page,config.provider]);
  useEffect(() => { session.current.reply(config.reply, config.running); }, [config.reply, config.running]);
  useEffect(() => {
    const hide = () => { if (document.hidden) {if(session.current.mode)session.current.stop({clear:true});if(realtime.current.mode)realtime.current.stop();if(preview.current.mode)preview.current.stop();} };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); if (session.current.mode) session.current.stop();if(realtime.current.mode)realtime.current.stop();if(preview.current.mode)preview.current.stop(); };
  }, []);
  return { ...state, active: !!state.mode, preview:{...previewState,active:!!previewState.mode,play:playPreview,stop:stopPreview}, samples:{...samples,add:addSamples,remove:removeSamples}, start: async mode => {await stop();if(mode==='realtime')await realtime.current.start();else await session.current.start(mode);}, stop, speak:async text=>{await stop();await session.current.speak(text);}, submit: () => session.current.submit(),mute:()=>realtime.current.toggleMute(),interrupt:()=>realtime.current.interrupt() };
}

function RealtimeVoicePicker({api,value,onChange,sampleSound='clear',onSampleSoundChange,preview,samples=NO_SAMPLES,onAddPreviews,disabled=false}) {
  const previewsAvailable=RECORDED_PREVIEWS_INCLUDED||samples.chatgpt.length>0;
  const showTone=RECORDED_PREVIEWS_INCLUDED||samples.clear;
  const [voices,setVoices]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [selected,setSelected]=useState(value||'');
  useEffect(()=>setSelected(value||''),[value]);
  const active=preview.active&&!String(preview.voiceId||'').startsWith('claude:');
  const previewError=!String(preview.voiceId||'').startsWith('claude:')?preview.error:'';
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;preview.stop();};},[preview.stop]);
  const load=async()=>{setLoading(true);setError('');try{const result=await api.invoke('voice.realtime.voices');if(mounted.current)setVoices(result);}catch(failure){if(mounted.current)setError(failure.message);}finally{if(mounted.current)setLoading(false);}};
  const availableSelection=voices&&!voices.voices.includes(selected)?'':selected;
  return <div className="realtime-voice-picker">
    <div className="realtime-voice-choices">{voices?<select aria-label="ChatGPT realtime voice" value={availableSelection} disabled={disabled} onChange={event=>{setSelected(event.target.value);if(active)preview.stop();onChange(event.target.value);}}><option value="">ChatGPT default{voices.defaultVoice?` (${voices.defaultVoice.charAt(0).toUpperCase()+voices.defaultVoice.slice(1)})`:''}</option>{voices.voices.map(id=><option key={id} value={id}>{id.charAt(0).toUpperCase()+id.slice(1)}</option>)}</select>:<button type="button" className="secondary-button" disabled={loading||disabled} onClick={load}>{loading?'Loading voices…':'Load ChatGPT voices'}</button>}
    {previewsAvailable&&<button type="button" className="secondary-button realtime-preview-button" disabled={!active&&(disabled||!voices)} onClick={()=>active?preview.stop():preview.play(availableSelection||voices.defaultVoice||'')}>{active?<Square size={14}/>:<Volume2 size={14}/>}<span>{active?'Stop realtime preview':'Preview realtime voice'}</span></button>}</div>
    {previewsAvailable&&showTone&&<label className="realtime-preview-tone">Sample sound <select aria-label="ChatGPT sample sound" value={sampleSound==='original'?'original':'clear'} disabled={disabled} onChange={async event=>{const tone=event.target.value;if(active)await preview.stop();onSampleSoundChange?.(tone);}}><option value="clear">Clear</option><option value="original">Original</option></select></label>}
    <p className="realtime-preview-note" role="status">{active?(preview.hint||(preview.phase==='playing'?'Playing voice preview. Microphone off.':'Starting voice preview…')):selected&&voices&&!availableSelection?'Your previous voice is unavailable. ChatGPT’s default will be used; choose another voice to update your preference.':!previewsAvailable?<>Voice previews are not built in. {onAddPreviews?<button type="button" className="text-button" onClick={onAddPreviews}>Add them in Settings → Voice</button>:'Use “Add voice previews” below to hear each voice before choosing.'}</>:sampleSound==='original'||!showTone?'Hear the original recording. Microphone stays off.':'Clear samples reduce muddiness and brighten speech detail. Voice, pitch and speed stay the same; live speech is unchanged.'}</p>
    {(error||previewError)&&<p className="inline-error" role="alert">{error||previewError}</p>}
  </div>;
}

function ClaudeVoicePicker({preview,names,disabled=false,showLabel=false}) {
  const [chosen,setSelected]=useState('buttery');
  const selected=names.includes(chosen)?chosen:names[0];
  const active=preview.active&&String(preview.voiceId||'').startsWith('claude:');
  const previewError=String(preview.voiceId||'').startsWith('claude:')?preview.error:'';
  useEffect(()=>()=>preview.stop(),[preview.stop]);
  return <div className="realtime-voice-picker">
    {showLabel&&<p className="voice-menu-note"><strong>Claude voice samples</strong></p>}
    <div className="realtime-voice-choices"><select aria-label="Claude voice sample" value={selected} disabled={disabled} onChange={event=>{if(active)preview.stop();setSelected(event.target.value);}}>{names.map(id=><option key={id} value={id}>{id.charAt(0).toUpperCase()+id.slice(1)}</option>)}</select>
    <button type="button" className="secondary-button realtime-preview-button" disabled={!active&&disabled} onClick={()=>active?preview.stop():preview.play('claude:'+selected)}>{active?<Square size={14}/>:<Volume2 size={14}/>}<span>{active?'Stop Claude preview':'Preview Claude voice'}</span></button></div>
    <p className="realtime-preview-note" role="status">{active?(preview.hint||(preview.phase==='playing'?'Playing voice preview. Microphone off.':'Starting voice preview…')):'Claude desktop samples. Spoken replies here use Windows voices.'}</p>
    {previewError&&<p className="inline-error" role="alert">{previewError}</p>}
  </div>;
}

const claudeNames = samples => RECORDED_PREVIEWS_INCLUDED ? BUILT_IN_CLAUDE_SAMPLES : samples.claude;

function VoiceSamplesRow({ samples, disabled }) {
  const when = samples.importedAt ? new Date(samples.importedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const from = samples.sources.map(item => item.app + (item.version ? ' ' + item.version : '')).filter(Boolean).join(' and ');
  return <div className="settings-row realtime-voice-row"><div><strong>Voice previews</strong>
    <p>{samples.imported
      ? `${sampleSummary(samples)} voice previews are on this computer${from ? ', copied from ' + from : ''}${when ? ' on ' + when : ''}. They are never uploaded.`
      : 'Hear each voice before you choose it. Exomina copies the recordings from the ChatGPT (Codex) and Claude desktop apps already installed on this computer.'}</p>
    <details className="voice-samples-why"><summary>Why aren’t they built in?</summary>
      <p>The recordings belong to OpenAI and Anthropic, and this beta has no permission to hand them out. Copying them from your own installed apps keeps them on your computer for your own use. Exomina only reads the apps’ sound files, never their settings or sign-ins, and it does nothing else with them.</p></details></div>
    <div className="realtime-voice-picker">
      <div className="realtime-voice-choices">
        <button type="button" className="secondary-button" disabled={disabled||samples.busy} onClick={() => samples.add(false)}>{samples.busy ? 'Looking for the apps…' : samples.imported ? 'Update from my apps' : 'Add voice previews'}</button>
        {samples.imported && <button type="button" className="text-button" disabled={disabled||samples.busy} onClick={samples.remove}>Remove</button>}
      </div>
      {samples.needsFolder && <p className="realtime-preview-note" role="status">{samples.message} If the app is installed somewhere unusual, <button type="button" className="text-button" disabled={samples.busy} onClick={() => samples.add(true)}>choose its folder</button>.</p>}
      {!samples.needsFolder && samples.message && <p className="realtime-preview-note" role="status">{samples.message}</p>}
      {samples.error && <p className="inline-error" role="alert">{samples.error}</p>}
    </div></div>;
}

export default function VoiceControls({ api, voice, settings, onVoiceChange, onSampleSoundChange, canTalk, canDictate,canRealtime, openSettings }) {
  const [open, setOpen] = useState(false), area = useRef(null);
  const [menuSpace,setMenuSpace]=useState({height:400,below:false});
  const placeMenu=()=>{if(!area.current)return;const bounds=area.current.getBoundingClientRect(),header=document.querySelector('.topbar')?.getBoundingClientRect().bottom||20,above=Math.max(40,bounds.top-header-20),below=Math.max(40,innerHeight-bounds.bottom-24),down=above<220&&below>above;setMenuSpace({height:down?below:above,below:down});};
  useEffect(()=>{if(!open)return;placeMenu();window.addEventListener('resize',placeMenu);return()=>window.removeEventListener('resize',placeMenu);},[open]);
  useDismiss(area, open, () => setOpen(false));
  if (voice.active) return <div className="voice-toolbar"><button type="button" className="composer-chip voice-live" aria-label="Stop voice" onClick={voice.stop}><Square size={12} fill="currentColor" /><span>{voice.phase === 'speaking' ? 'Speaking' : voice.phase === 'waiting' ? 'Waiting for reply' : voice.phase === 'starting' ? 'Connecting voice' : 'Listening'}</span></button>{voice.mode === 'realtime'&&<><button type="button" className="composer-chip" aria-label={voice.muted?'Unmute microphone':'Mute microphone'} onClick={voice.mute}>{voice.muted?<MicOff size={13}/>:<Mic size={13}/>}</button>{voice.phase==='speaking'&&<button type="button" className="composer-chip" onClick={voice.interrupt}>Interrupt</button>}</>}{voice.mode === 'conversation' && voice.phase === 'listening' && voice.transcript && <button type="button" className="composer-chip" onClick={voice.submit}>Send now</button>}</div>;
  return <div className="voice-controls" ref={area}><button type="button" className="composer-chip" aria-label="Voice options" aria-expanded={open} onClick={() => {if(!open)placeMenu();setOpen(!open);}}><Mic size={14} /><span>Voice</span><ChevronDown size={11} /></button>{open && <div className="popover voice-menu" role="dialog" aria-label="Voice options" style={{maxHeight:menuSpace.height,...(menuSpace.below?{bottom:'auto',top:'calc(100% + 12px)'}:{})}}>
    <h3>Use your voice</h3>
    <button type="button" disabled={!canRealtime} onClick={()=>{setOpen(false);voice.start('realtime');}}><Headphones size={17}/><span><strong>Realtime ChatGPT</strong><small>Stream audio to OpenAI through your ChatGPT subscription. Talk and interrupt naturally. Transcripts stay in this chat.</small></span></button>
    {!canRealtime&&<p className="voice-menu-note">Select a connected ChatGPT model, clear your draft and wait for the current reply to use realtime voice.</p>}
    <RealtimeVoicePicker api={api} value={settings?.realtimeVoice} onChange={onVoiceChange} sampleSound={settings?.previewTone} onSampleSoundChange={onSampleSoundChange} preview={voice.preview} samples={voice.samples}/>
    <p>Windows voice options process audio on this PC and send text to your selected AI.</p>
    <button type="button" disabled={!canDictate} onClick={() => { setOpen(false); voice.start('dictation'); }}><Mic size={17} /><span><strong>Dictate a message</strong><small>Add speech to the message box, then review and send.</small></span></button>
    <button type="button" disabled={!canTalk} onClick={() => { setOpen(false); voice.start('conversation'); }}><Volume2 size={17} /><span><strong>Spoken replies</strong><small>For any model: send text after a pause, read its finished reply, then listen again.</small></span></button>
    {!canTalk && <p className="voice-menu-note">Send or clear your draft and wait for the current reply before starting a voice conversation.</p>}
    <button type="button" onClick={() => { setOpen(false); openSettings('voice'); }}><Volume2 size={16} /><span>Language, voice and pause length</span></button>
  </div>}</div>;
}

export function VoiceStatus({ voice }) {
  if (!voice.active && !voice.error) return null;
  return <div className={`voice-status ${voice.error ? 'has-error' : ''}`} role={voice.error ? 'alert' : 'status'} aria-live="polite"><span>{voice.error || voice.hint || (voice.phase === 'listening' ? `Microphone on${voice.language ? ' · ' + voice.language : ''}` : voice.phase === 'starting' ? 'Starting Windows speech…' : voice.phase === 'waiting' ? 'Microphone paused while your AI replies.' : 'Reading the reply aloud.')}</span>{['conversation','realtime'].includes(voice.mode) && voice.transcript && <p>{voice.transcript}</p>}</div>;
}

/** A local tone through the same Windows output Exomina uses, independent of ChatGPT. */
function SpeakerTest() {
  const [playing,setPlaying]=useState(false);
  const test=async()=>{
    if(playing)return;setPlaying(true);
    try{const context=new AudioContext();await context.resume();const gain=context.createGain();gain.gain.value=0.15;gain.connect(context.destination);
      [523.25,659.25,783.99].forEach((frequency,index)=>{const oscillator=context.createOscillator();oscillator.frequency.value=frequency;oscillator.connect(gain);oscillator.start(context.currentTime+index*0.35);oscillator.stop(context.currentTime+index*0.35+0.3);});
      await new Promise(resolve=>setTimeout(resolve,1200));await context.close();}
    finally{setPlaying(false);}
  };
  return <div className="settings-row"><div><strong>Test speakers</strong><p>Plays three short tones through Windows’ default output device, with no ChatGPT involved. Exomina follows the output device chosen in Windows.</p></div><button type="button" className="secondary-button" disabled={playing} onClick={test}><Volume2 size={14}/><span>{playing?'Playing…':'Play test tone'}</span></button></div>;
}

export function VoiceSettings({ api, settings, onChange, voice }) {
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  useEffect(() => { let active = true; api.invoke('voice.status').then(value => { if (active) setStatus(value); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [api]);
  const value = normalizeVoice(settings), save = patch => onChange(patch);
  return <section className="settings-section" id="settings-voice"><div className="section-title"><h2>Voice</h2><span>Realtime conversation and Windows speech</span></div><p className="voice-description">Realtime ChatGPT streams microphone audio to OpenAI through your ChatGPT subscription. Its voice model supports spoken interruptions; availability and limits are controlled by ChatGPT. Completed transcripts are saved in the current chat; Exomina does not save audio. Microphone access starts only when you choose a voice mode. For tasks that use tools or change files, dictate a message and send it.</p>
    <div className="settings-row realtime-voice-row"><div><strong>ChatGPT realtime voice</strong><p>The subscription voice model is separate from the text model you selected.</p></div><RealtimeVoicePicker api={api} value={value.realtimeVoice} onChange={realtimeVoice=>save({realtimeVoice})} sampleSound={value.previewTone} onSampleSoundChange={previewTone=>save({previewTone})} preview={voice.preview} samples={voice.samples} disabled={voice.active}/></div>
    {SAMPLES_IMPORTABLE&&<VoiceSamplesRow samples={voice.samples} disabled={voice.active||voice.preview.active}/>}
    <SpeakerTest/>
    <p className="voice-description">Windows dictation and spoken replies use installed languages and voices. Audio stays on this PC. Spoken replies send recognized text after a pause and read the completed answer from your selected AI.</p>
    {!status && !error && <p>Checking installed speech languages…</p>}{error && <p className="inline-error" role="alert">{error}</p>}{status && !status.available && <p className="inline-error">No speech recognizer is installed. Add Speech for your language in Windows Settings → Time & language → Language & region, then restart Exomina.</p>}
    <div className="settings-row"><div><strong>Speech language</strong><p>Choose the language you will speak.</p></div><select aria-label="Speech language" value={value.language} onChange={event => save({ language: event.target.value })}><option value="">Windows default</option>{status?.recognizers?.map(item => <option key={item.id} value={item.language}>{item.name} ({item.language})</option>)}</select></div>
    <div className="settings-row"><div><strong>Speaking voice</strong></div><select aria-label="Speaking voice" value={value.voice} onChange={event => save({ voice: event.target.value })}><option value="">Windows default</option>{status?.voices?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.language}</option>)}</select></div>
    <div className="settings-row"><div><strong>Speaking speed</strong></div><label className="voice-rate"><input type="range" min="-5" max="5" step="1" value={value.rate} aria-label="Speaking speed" onChange={event => save({ rate: Number(event.target.value) })} /><span>{value.rate === 0 ? 'Normal' : value.rate > 0 ? 'Faster' : 'Slower'}</span></label></div>
    <div className="settings-row"><div><strong>Pause before sending</strong><p>Windows spoken replies wait this long after a recognized phrase.</p></div><select aria-label="Pause before sending" value={value.silenceMs} onChange={event => save({ silenceMs: Number(event.target.value) })}><option value={900}>Short · 0.9 seconds</option><option value={1400}>Medium · 1.4 seconds</option><option value={2200}>Long · 2.2 seconds</option></select></div>
    <button type="button" className="secondary-button" disabled={!status?.voices?.length} onClick={() => voice.active ? voice.stop() : voice.speak('This is your Exomina voice. You can change the voice and speaking speed here.')}>{voice.active ? <Square size={14} /> : <Volume2 size={14} />}{voice.active ? 'Stop preview' : 'Preview voice'}</button>
  </section>;
}
