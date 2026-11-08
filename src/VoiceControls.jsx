import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, Square, Volume2, ChevronDown } from 'lucide-react';
import { VoiceSession } from './voice-session.js';
import { RealtimeVoiceSession } from './realtime-voice-session.js';
import { VoicePreviewSession } from './voice-preview-session.js';
import { normalizeVoice } from '../desktop/voice-settings.mjs';
import { dictationTerms } from '../desktop/dictation.mjs';
import { DISTRIBUTION_PROFILE } from '../desktop/distribution.mjs';
import {chooseDeviceSpeech} from './companion-voice.js';
import DeviceVoiceChoice from './DeviceVoiceChoice.jsx';
import useDismiss from './useDismiss.js';
import './voice.css';

const RECORDED_PREVIEWS_INCLUDED = DISTRIBUTION_PROFILE === 'personal';

export function useVoice(config) {
  const [state, update] = useState({ phase: 'idle', mode: '', transcript: '' });
  const [previewState, updatePreview] = useState({ phase: 'idle', mode: '' });
  const current = useRef(config); current.current = config;
  const preferenceChoice=useRef(0);
  const session = useRef(null);
  if (!session.current) session.current = new VoiceSession({ invoke: (method, payload) => current.current.api.invoke(method, payload), current: () => current.current, update, draft: text => current.current.onDraft(text), recoverDraft: (receipt, original) => { if(!current.current.onRecoverDraft)throw Error('Original recognition is available below.');return current.current.onRecoverDraft(receipt, original); }, send: text => current.current.onSend(text) });
  const realtime = useRef(null);
  if (!realtime.current) realtime.current = new RealtimeVoiceSession({ invoke:(method,payload)=>current.current.api.invoke(method,payload),current:()=>current.current,update,onConversation:id=>current.current.onConversation(id) });
  const preview = useRef(null);
  if(!preview.current)preview.current=new VoicePreviewSession({invoke:(method,payload)=>current.current.api.invoke(method,payload),current:()=>current.current,update:updatePreview});
  const stopPreview=useCallback(()=>preview.current.stop(),[]);
  const playPreview=useCallback(async id=>{if(session.current.mode||realtime.current.mode){updatePreview({phase:'error',mode:'',voiceId:id,error:'Stop voice before previewing another voice.'});return;}await preview.current.start({previewVoice:id});},[]);
  const stop=async()=>{preferenceChoice.current++;await stopPreview();if(realtime.current.mode)await realtime.current.stop();if(session.current.mode)await session.current.stop();};
  const useDeviceSpeech=async allowed=>{await stop();const generation=preferenceChoice.current;try{await chooseDeviceSpeech({invoke:(method,payload)=>current.current.api.invoke(method,payload),current:()=>current.current,allowed:()=>generation===preferenceChoice.current&&!document.hidden&&(!allowed||allowed()),start:mode=>session.current.start(mode)});}catch(error){if(generation===preferenceChoice.current)update({mode:'',phase:'error',error:error.message});}};
  useEffect(() => config.api?.onEvent(event => {session.current.receive(event);realtime.current.receive(event);preview.current.receive(event);}), [config.api]);
  useEffect(() => { session.current.scopeChanged(config.conversationId || '', config.page, config.projectId || '');realtime.current.scopeChanged(config.conversationId||'',config.page,config.provider);preview.current.scopeChanged(config.conversationId||'',config.page,config.provider); }, [config.conversationId, config.page,config.provider,config.projectId]);
  useEffect(() => { session.current.reply(config.reply, config.running); }, [config.reply, config.running]);
  useEffect(() => {
    const hide = () => { if (document.hidden) {if(session.current.mode)session.current.stop({clear:true});if(realtime.current.mode)realtime.current.stop();if(preview.current.mode)preview.current.stop();} };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); if (session.current.mode) session.current.stop();if(realtime.current.mode)realtime.current.stop();if(preview.current.mode)preview.current.stop(); };
  }, []);
  return { ...state, active: !!state.mode, finishDictation:()=>session.current.finishDictation(),recoverOriginal:()=>session.current.recoverOriginal(), dismissDictation:()=>session.current.dismissDictation(), chooseDeviceSpeech:useDeviceSpeech,preview:{...previewState,active:!!previewState.mode,play:playPreview,stop:stopPreview}, start: async mode => {await stop();if(mode==='realtime')await realtime.current.start();else await session.current.start(mode);}, stop, speak:async text=>{await stop();await session.current.speak(text);}, submit: () => session.current.submit(),mute:()=>realtime.current.toggleMute(),interrupt:()=>realtime.current.interrupt() };
}

function RealtimeVoicePicker({api,value,onChange,sampleSound='clear',onSampleSoundChange,preview,disabled=false}) {
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
    <div className="realtime-voice-choices">{voices?<select aria-label="ChatGPT realtime voice" value={availableSelection} disabled={disabled} onChange={event=>{setSelected(event.target.value);if(active)preview.stop();onChange(event.target.value);}}><option value="">ChatGPT default{voices.defaultVoice?` (${voices.defaultVoice.charAt(0).toUpperCase()+voices.defaultVoice.slice(1)})`:''}</option>{voices.voices.map(id=><option key={id} value={id}>{id.charAt(0).toUpperCase()+id.slice(1)}</option>)}</select>:<button type="button" className="secondary-button" aria-label="Load ChatGPT voices" disabled={loading||disabled} onClick={load}>{loading?'Loading…':'Load voices'}</button>}
    {RECORDED_PREVIEWS_INCLUDED&&<button type="button" className="secondary-button realtime-preview-button" aria-label={active?'Stop realtime preview':'Preview realtime voice'} disabled={!active&&(disabled||!voices)} onClick={()=>active?preview.stop():preview.play(availableSelection||voices.defaultVoice||'')}>{active?<Square size={14}/>:<Volume2 size={14}/>}<span>{active?'Stop preview':'Preview'}</span></button>}</div>
    {RECORDED_PREVIEWS_INCLUDED&&<label className="realtime-preview-tone">Sample sound <select aria-label="ChatGPT sample sound" value={sampleSound==='original'?'original':'clear'} disabled={disabled} onChange={async event=>{const tone=event.target.value;if(active)await preview.stop();onSampleSoundChange?.(tone);}}><option value="clear">Clear</option><option value="original">Original</option></select></label>}
    <p className="realtime-preview-note" role="status">{active?(preview.hint||(preview.phase==='playing'?'Playing preview · microphone off':'Starting preview…')):selected&&voices&&!availableSelection?'Your previous voice is unavailable. ChatGPT’s default will be used; choose another to update your preference.':!RECORDED_PREVIEWS_INCLUDED?'Voice samples are not included in this beta.':sampleSound==='original'?'Original recording · microphone off':'Clear sample · microphone off · live speech unchanged'}</p>
    {(error||previewError)&&<p className="inline-error" role="alert">{error||previewError}</p>}
  </div>;
}

export default function VoiceControls({ api, voice, settings, onVoiceChange, onSampleSoundChange, canTalk, canDictate,canRealtime, openSettings,openConnections }) {
  const [open, setOpen] = useState(false), area = useRef(null);
  const [menuSpace,setMenuSpace]=useState({height:400,below:false});
  const placeMenu=()=>{if(!area.current)return;const bounds=area.current.getBoundingClientRect(),header=document.querySelector('.topbar')?.getBoundingClientRect().bottom||20,above=Math.max(40,bounds.top-header-20),below=Math.max(40,innerHeight-bounds.bottom-24),down=above<220&&below>above;setMenuSpace({height:down?below:above,below:down});};
  useEffect(()=>{if(!open)return;placeMenu();window.addEventListener('resize',placeMenu);return()=>window.removeEventListener('resize',placeMenu);},[open]);
  useDismiss(area, open, () => setOpen(false));
  if (voice.active) return <div className="voice-toolbar"><button type="button" className="composer-chip voice-live" aria-label="Stop voice" onClick={voice.stop}><Square size={12} fill="currentColor" /><span>{voice.phase === 'transcribing'?'Transcribing':voice.phase === 'speaking' ? 'Speaking' : voice.phase === 'waiting' ? 'Waiting for reply' : voice.phase === 'starting' ? 'Connecting voice' : 'Listening'}</span></button>{voice.mode==='dictation'&&voice.recording&&voice.phase==='listening'&&<button type="button" className="composer-chip" onClick={voice.finishDictation}>Transcribe recording</button>}{voice.mode === 'realtime'&&<><button type="button" className="composer-chip" aria-label={voice.muted?'Unmute microphone':'Mute microphone'} onClick={voice.mute}>{voice.muted?<MicOff size={13}/>:<Mic size={13}/>}</button>{voice.phase==='speaking'&&<button type="button" className="composer-chip" onClick={voice.interrupt}>Interrupt</button>}</>}{voice.mode === 'conversation' && voice.phase === 'listening' && voice.transcript && <button type="button" className="composer-chip" onClick={voice.submit}>Send now</button>}</div>;
  return <div className="voice-controls" ref={area}><button type="button" className="composer-chip" aria-label="Voice options" aria-expanded={open} onClick={() => {if(!open)placeMenu();setOpen(!open);}}><Mic size={14} /><span>Voice</span><ChevronDown size={11} /></button>{open && <div className="popover voice-menu" role="dialog" aria-label="Voice options" style={{maxHeight:menuSpace.height,...(menuSpace.below?{bottom:'auto',top:'calc(100% + 12px)'}:{})}}>
    <h3>Use your voice</h3>
    <button type="button" disabled={!canRealtime} onClick={()=>{setOpen(false);voice.start('realtime');}}><Headphones size={17}/><span><strong>Talk with AI</strong><small>ChatGPT audio · microphone and chat context shared</small></span></button>
    {!canRealtime&&<p className="voice-menu-note">Needs a connected ChatGPT account and a chat with no unsent draft or active reply.</p>}
    {!canRealtime&&openConnections&&<button type="button" onClick={()=>{setOpen(false);openConnections('codex');}}>ChatGPT connection</button>}
    <button type="button" disabled={!canDictate} onClick={() => { setOpen(false); voice.start('dictation'); }}><Mic size={17} /><span><strong>Dictate a message</strong><small>Add speech to the message box, then review and send.</small></span></button>
    <button type="button" disabled={!canTalk} onClick={() => { setOpen(false); voice.start('conversation'); }}><Volume2 size={17} /><span><strong>Talk with device speech</strong><small>Windows audio stays here. Text goes to your AI after a pause.</small></span></button>
    {!canTalk && canRealtime && <p className="voice-menu-note">Device speech needs a chat with no unsent draft or active reply.</p>}
    {(!canRealtime||!!voice.error)&&<details className="voice-recovery"><summary>Use device speech as my default</summary><DeviceVoiceChoice api={api} voice={voice} visible canTalk={canTalk}/></details>}
    <button type="button" className="voice-settings-link" onClick={() => { setOpen(false); openSettings('voice'); }}><Volume2 size={16} /><span>Voice settings and previews</span></button>
  </div>}</div>;
}

export function VoiceStatus({ voice }) {
  if (!voice.active && !voice.error && !voice.dictation) return null;
  return <div className={`voice-status ${voice.error ? 'has-error' : ''}`} role={voice.error ? 'alert' : 'status'} aria-live="polite"><span>{voice.error || voice.hint || (voice.phase === 'listening' ? `Microphone on${voice.language ? ' · ' + voice.language : ''}` : voice.phase === 'starting' ? 'Starting Windows speech…' : voice.phase === 'waiting' ? 'Microphone paused while your AI replies.' : voice.phase === 'speaking' ? 'Reading the reply aloud.' : 'Dictation stopped. Review your draft before sending.')}</span>{['conversation','realtime'].includes(voice.mode) && voice.transcript && <p>{voice.transcript}</p>}{voice.dictation&&<details className="dictation-original"><summary>Last recognized phrase{voice.dictation.changed?' · cleanup applied':''}</summary><label>Original recognition<textarea readOnly aria-label="Original dictation" value={voice.dictation.original}/></label>{voice.dictation.changed&&<><label>Added to your draft<textarea readOnly aria-label="Prepared dictation" value={voice.dictation.text}/></label><button type="button" className="secondary-button" disabled={voice.dictation.restored} onClick={voice.recoverOriginal}>{voice.dictation.restored?'Original restored':'Restore original in draft'}</button></>}{voice.dictation.error&&<p role="alert">{voice.dictation.error}</p>}<button type="button" className="text-button" onClick={voice.dismissDictation}>Dismiss recognition</button></details>}</div>;
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
  return <div className="settings-row"><div><strong>Test speakers</strong><p>Three tones through your default Windows output. No microphone or AI request.</p></div><button type="button" className="secondary-button" disabled={playing} onClick={test}><Volume2 size={14}/><span>{playing?'Playing…':'Play test tone'}</span></button></div>;
}

export function VoiceSettings({ api, settings, onChange, voice,openConnections,projectId='',projectName='' }) {
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  useEffect(() => { let active = true; api.invoke('voice.status').then(value => { if (active) setStatus(value); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [api]);
  const value = normalizeVoice(settings), save = patch => onChange(patch);
  return <section className="settings-section" id="settings-voice"><div className="section-title"><h2>Voice</h2><span>Choose how to talk and how replies sound.</span></div>
    <div className="settings-row"><div><strong>Companion Talk voice</strong><p>Used by Talk beside your companion. Never switches automatically.</p></div><select aria-label="Companion Talk voice" value={value.companionMode} disabled={voice.active} onChange={event=>save({companionMode:event.target.value})}><option value="realtime">ChatGPT AI voice</option><option value="device">Windows device speech</option></select></div>
    <div className="settings-row realtime-voice-row"><div><strong>AI speaking voice</strong><p>ChatGPT realtime audio, independent of your text model.</p></div><RealtimeVoicePicker api={api} value={value.realtimeVoice} onChange={realtimeVoice=>save({realtimeVoice})} sampleSound={value.previewTone} onSampleSoundChange={previewTone=>save({previewTone})} preview={voice.preview} disabled={voice.active}/></div>
    {openConnections&&<button type="button" className="secondary-button" onClick={()=>openConnections('codex')}>ChatGPT connection</button>}
    <details className="voice-privacy"><summary>Audio sharing and availability</summary><p className="voice-description">ChatGPT AI voice is experimental and uses your connected subscription. Audio and chat context go to OpenAI; completed transcripts stay in this chat and Exomina does not save audio. The first conversation asks for your acknowledgment before microphone access. Your account determines availability and limits. Use a typed or dictated message for actions that need tools.</p></details>
    <details className="device-speech-settings" open={value.companionMode==='device'||undefined}><summary><span>Device speech</span><small>Windows voices, dictation and pause length</small></summary>
    <p className="voice-description">Audio stays on this PC. Recognized text goes to your selected AI after a pause; Windows reads the completed reply.</p>
    <LocalDictationSetup api={api} value={value} save={save} voice={voice} initial={status?.localDictation}/>
    <div className="settings-row"><div><strong>Dictation text</strong><p>Raw recognition is the default. Minimal cleanup changes repeated spaces and your preferred casing; paths, flags and quoted text stay raw. Messages remain editable before sending.</p></div><select aria-label="Dictation text" value={value.dictationMode} onChange={event=>save({dictationMode:event.target.value})}><option value="raw">Raw recognition</option><option value="minimal">Minimal cleanup</option></select></div>
    <DictationVocabulary key={projectId} projectId={projectId} projectName={projectName} settings={value} save={save}/>
    {!status && !error && <p>Checking installed speech languages…</p>}{error && <p className="inline-error" role="alert">{error}</p>}{status && !status.available && <p className="inline-error">{status.error||'No speech recognizer is installed. Add Speech for your language in Windows Settings → Time & language → Language & region, then restart Exomina.'}</p>}
    <div className="settings-row"><div><strong>Speech language</strong><p>Choose the language you will speak.</p></div><select aria-label="Speech language" value={value.language} onChange={event => save({ language: event.target.value })}><option value="">Windows default</option>{status?.recognizers?.map(item => <option key={item.id} value={item.language}>{item.name} ({item.language})</option>)}</select></div>
    <div className="settings-row"><div><strong>Windows speaking voice</strong><p>Used only for device speech and reading replies aloud.</p></div><select aria-label="Speaking voice" value={value.voice} onChange={event => save({ voice: event.target.value })}><option value="">Windows default</option>{status?.voices?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.language}</option>)}</select></div>
    <div className="settings-row"><div><strong>Speaking speed</strong></div><label className="voice-rate"><input type="range" min="-5" max="5" step="1" value={value.rate} aria-label="Speaking speed" onChange={event => save({ rate: Number(event.target.value) })} /><span>{value.rate === 0 ? 'Normal' : value.rate > 0 ? 'Faster' : 'Slower'}</span></label></div>
    <div className="settings-row"><div><strong>Pause before sending</strong><p>Windows spoken replies wait this long after a recognized phrase.</p></div><select aria-label="Pause before sending" value={value.silenceMs} onChange={event => save({ silenceMs: Number(event.target.value) })}><option value={900}>Short · 0.9 seconds</option><option value={1400}>Medium · 1.4 seconds</option><option value={2200}>Long · 2.2 seconds</option></select></div>
    <button type="button" className="secondary-button" disabled={!status?.voices?.length} onClick={() => voice.active ? voice.stop() : voice.speak('This is your Windows device voice. AI voice is selected separately in Exomina.')}>{voice.active ? <Square size={14} /> : <Volume2 size={14} />}{voice.active ? 'Stop preview' : 'Preview Windows voice'}</button>
    </details><SpeakerTest/>
  </section>;
}

function LocalDictationSetup({api,value,save,voice,initial}) {
  const [status,setStatus]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(initial)setStatus(initial);},[initial]);
  useEffect(()=>{if(!busy&&!status?.download?.running)return;let live=true;const timer=setInterval(()=>api.invoke('voice.status').then(result=>{if(live)setStatus(result.localDictation);}).catch(()=>{}),1000);return()=>{live=false;clearInterval(timer);};},[api,busy,status?.download?.running]);
  const action=async method=>{setBusy(true);setError('');try{setStatus(await api.invoke(method));}catch(failure){setError(failure.message);}finally{setBusy(false);}};
  const downloading=busy||status?.download?.running;
  return <div className="local-dictation-setup">
    <div className="settings-row"><div><strong>Dictation recognizer</strong><p>Used only by Dictate a message. Talking with device speech keeps the Windows recognizer.</p></div><select aria-label="Dictation recognizer" value={value.dictationEngine||'windows'} disabled={voice.active||downloading} onChange={event=>save({dictationEngine:event.target.value})}><option value="windows">Windows speech</option><option value="whisper" disabled={!status?.installed}>Local Whisper · experimental</option></select></div>
    <details><summary>Local recognition · English and German</summary><p>Optional Windows x64 download: 157 MB. Record up to two minutes, then choose Transcribe recording. Stop discards the recording. Transcription uses up to four CPU threads and about 400 MB of memory, then unloads. Audio stays on this PC; a temporary WAV is deleted after recognition. Review names, numbers and commands before sending.</p>
      <p>In ten synthetic speech samples, word error fell from 45% with Windows speech to 12% with this recognizer. Human speech and microphone quality have not been evaluated.</p>
      {!status?.supported?<p>Local recognition is currently available on Windows x64.</p>:<div className="workbench-actions">
        {status?.installed?<button type="button" className="secondary-button" disabled={voice.active||downloading} onClick={()=>action('voice.local.remove')}>Remove local recognizer</button>:<button type="button" className="secondary-button" disabled={voice.active||downloading} onClick={()=>action('voice.local.install')}>{downloading?'Downloading…':'Download local recognizer · 157 MB'}</button>}
        {downloading&&<button type="button" className="secondary-button" onClick={()=>api.invoke('voice.local.cancel').catch(failure=>setError(failure.message))}>Cancel download</button>}
      </div>}
      {status?.download&&<p role="status">{status.download.running?`${Math.round(status.download.done/1000000)} / 157 MB downloaded`:status.download.error||(status.installed?'Local recognition is installed. Choose it above to use it.':'')}</p>}
      <small>MIT licenses: <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">whisper.cpp</a> and <a href="https://huggingface.co/ggerganov/whisper.cpp" target="_blank" rel="noreferrer">Whisper base weights</a>.</small>
    </details>{(error||status?.cleanupWarning)&&<p className="inline-error" role="alert">{error||status.cleanupWarning}</p>}
  </div>;
}

function DictationVocabulary({projectId,projectName,settings,save}) {
  const terms=settings.dictationVocabularies?.find(item=>item.projectId===projectId)?.terms||[];
  const [text,setText]=useState(terms.join('\n')),[error,setError]=useState(''),[saved,setSaved]=useState(false),[saving,setSaving]=useState(false);
  useEffect(()=>{setText(terms.join('\n'));},[terms.join('\n')]);
  const submit=async()=>{const entered=text.split(/\r?\n/).map(term=>term.trim()).filter(Boolean),valid=dictationTerms(entered);if(entered.length>40||valid.length!==new Set(entered.map(term=>term.toLocaleLowerCase('en-US'))).size){setError('Use up to 40 distinct single words, 3–64 letters each. Numbers, command syntax and negations cannot be dictionary entries.');return;}setSaving(true);setError('');try{await save({dictationVocabulary:{projectId,terms:valid}});setSaved(true);}catch(failure){setError(failure.message);}finally{setSaving(false);}};
  return <div className="settings-row dictation-vocabulary"><div><strong>Preferred spelling{projectName?` · ${projectName}`:''}</strong><p>{projectId?'One word per line. Applies only to this project, only in minimal cleanup. Changes capitalization of exact matches; does not guess missing words.':'Select a project in chat to set its dictation vocabulary.'}</p></div><div><textarea disabled={!projectId||saving} aria-label="Project dictation vocabulary" value={text} maxLength={2600} onChange={event=>{setText(event.target.value);setSaved(false);}} rows={3}/><button type="button" className="secondary-button" disabled={!projectId||saving} onClick={submit}>{saving?'Saving…':'Save preferred spelling'}</button>{saved&&<p role="status">Preferred spelling saved.</p>}{error&&<p className="inline-error" role="alert">{error}</p>}</div></div>;
}
