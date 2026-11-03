import React, { useEffect, useId, useRef, useState } from 'react';
import { glyphPath, inventScript, seeded } from './invented-script.js';
import { Hand,MessageSquare, Mic, Square, Settings2, X } from 'lucide-react';
import { normalizeAppearance } from '../desktop/themes.mjs';
import CompanionDesigner,{CustomCreature,ImportedCompanion} from './CompanionDesign.jsx';
import {api} from './transport.js';
import {characterStage} from './character-stage.js';
import './companion.css';
import {companionVoiceAction} from './companion-voice.js';
import DeviceVoiceChoice from './DeviceVoiceChoice.jsx';

const BUILT_IN_AVATARS=[['fox','Fox'],['cat','Cat'],['star','Star'],['sigil','Sigil']];

/** Vesper's own choice: a living astrolabe-eye. Its rings are written in the Palimpsest theme's invented script.
 *  It follows the pointer, glances about when left alone, dilates when you come close, narrows and scans while working. */
const SIGIL_SCRIPT=inventScript(seeded(0x5161)).slice(0,10),SIGIL_EYE='M37 52Q60 31 83 52Q60 73 37 52Z';
function Sigil({animate}){
  const uid=`sigil${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`,look=useRef(null);
  useEffect(()=>{
    const el=look.current,svg=el?.ownerSVGElement;if(!animate||!el||!svg)return;
    let frame=0,pending=null,idle=0;
    const place=(x,y,near)=>{el.style.transform=`translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;el.classList.toggle('sigil-near',near);};
    const apply=()=>{frame=0;const box=svg.getBoundingClientRect();if(!pending||!box.width)return;
      const scale=Math.min(box.width/120,box.height/110),cx=box.left+box.width/2,cy=box.top+box.height/2-3*scale;
      const dx=pending.x-cx,dy=pending.y-cy,distance=Math.hypot(dx,dy),reach=Math.min(1,distance/240)*4.6,k=distance?reach/distance:0;
      place(dx*k,dy*k*.8,distance<26*scale);pending=null;};
    // Left alone, it looks around on its own.
    const wander=()=>{const angle=Math.random()*Math.PI*2,r=Math.random()*4.2;place(Math.cos(angle)*r,Math.sin(angle)*r*.8,false);idle=setTimeout(wander,2400+Math.random()*4200);};
    const moved=event=>{pending={x:event.clientX,y:event.clientY};clearTimeout(idle);idle=setTimeout(wander,7000);if(!frame)frame=requestAnimationFrame(apply);};
    window.addEventListener('pointermove',moved,{passive:true});idle=setTimeout(wander,4000);
    return()=>{window.removeEventListener('pointermove',moved);cancelAnimationFrame(frame);clearTimeout(idle);el.style.transform='';el.classList.remove('sigil-near');};
  },[animate]);
  return <>
    <defs>
      <radialGradient id={`${uid}-halo`}><stop offset="0" className="sigil-halo-in"/><stop offset="1" className="sigil-halo-out"/></radialGradient>
      <radialGradient id={`${uid}-iris`} cx="50%" cy="44%" r="56%"><stop offset="0" className="sigil-iris-core"/><stop offset=".55" className="sigil-iris-mid"/><stop offset="1" className="sigil-iris-rim"/></radialGradient>
      <clipPath id={`${uid}-eye`}><path d={SIGIL_EYE}/></clipPath>
    </defs>
    <circle className="sigil-halo" cx="60" cy="52" r="52" fill={`url(#${uid}-halo)`}/>
    <g className="sigil-rings">
      <g className="sigil-ring-outer"><circle className="sigil-line sigil-ticks" cx="60" cy="52" r="45"/><circle className="sigil-line sigil-hair" cx="60" cy="52" r="48"/></g>
      <g className="sigil-script">{SIGIL_SCRIPT.map((glyph,i)=><path key={i} transform={`rotate(${i*36} 60 52)`} d={glyphPath(glyph,60,15,8)}/>)}</g>
      <g className="sigil-orbit"><circle className="sigil-line sigil-hair" cx="60" cy="52" r="28"/><circle className="sigil-moon" cx="60" cy="24" r="2.4"/></g>
    </g>
    <g className="sigil-eye"><g className="sigil-blink">
      <path className="sigil-white" d={SIGIL_EYE}/>
      <g clipPath={`url(#${uid}-eye)`}><g ref={look} className="sigil-look"><g className="sigil-scan">
        <circle className="sigil-iris" cx="60" cy="52" r="11.5" fill={`url(#${uid}-iris)`}/>
        <circle className="sigil-iris-ring" cx="60" cy="52" r="7.6"/>
        <ellipse className="sigil-pupil" cx="60" cy="52" rx="4.3" ry="4.3"/>
        <circle className="companion-glint" cx="64.2" cy="47.8" r="1.7"/>
      </g></g></g>
      <path className="sigil-lid" d={SIGIL_EYE}/>
    </g></g>
  </>;
}

/** Original vector avatars; no downloaded models, images or background inference. */
export function CompanionAvatar({ avatar = 'fox', color = '#b2c9bb', animate = true, state = 'ready',design,artwork }) {
  if(avatar==='artwork')return <ImportedCompanion artwork={artwork} animate={animate} state={state}/>;
  return <svg className={`companion-avatar avatar-${avatar} companion-${state} ${animate ? '' : 'companion-still'}`} viewBox="0 0 120 110" style={{ '--companion-color': color }} aria-hidden="true" focusable="false">
    <ellipse cx="60" cy="101" rx="30" ry="4" className="companion-shadow" />
    <g className="companion-body">
      {avatar==='custom'?<CustomCreature design={design} state={state}/>:avatar==='sigil'?<Sigil animate={animate}/>:avatar === 'star' ? <><path className="companion-coat" d="M60 12 Q64 12 74 37 L101 42 Q108 44 101 52 L82 70 L86 96 Q87 104 79 100 L60 88 L40 100 Q32 104 34 96 L38 70 L18 52 Q12 44 20 42 L46 37 Q56 12 60 12Z" /><path d="M41 33L46 21M86 29L92 20M100 78L109 81" className="companion-sparkles" /></> : <>
        <path className="companion-tail companion-coat" d={avatar === 'cat' ? 'M80 87 Q111 99 105 70 Q103 61 98 65 Q92 69 97 76 Q103 89 83 81Z' : 'M79 88 Q115 92 110 61 Q105 67 96 66 Q100 79 80 78Z'} />
        <ellipse className="companion-coat" cx="59" cy="79" rx="26" ry="20" />
        <path className="companion-coat companion-ear" d={avatar === 'cat' ? 'M29 47L27 13L49 32M70 31L93 13L90 48' : 'M28 47L24 9L49 32M71 32L97 9L92 48'} />
        <path className="companion-inner" d="M33 36L32 24L42 34M79 34L88 24L86 37" />
        <path className="companion-coat" d="M28 44Q30 29 60 28Q90 29 93 44L88 65Q79 82 60 83Q40 82 31 65Z" />
        <path className="companion-muzzle" d={avatar === 'cat' ? 'M35 57Q44 66 60 64Q76 66 86 57Q83 76 60 77Q38 76 35 57' : 'M29 49L52 62L60 73L68 62L92 49Q88 76 60 78Q33 76 29 49'} />
        <path className="companion-paws" d="M42 93L51 93M67 93L77 93" />
      </>}
      {avatar!=='custom'&&avatar!=='sigil'&&<g className="companion-face"><ellipse cx="45" cy="51" rx="3.4" ry="4.1" /><ellipse cx="75" cy="51" rx="3.4" ry="4.1" /><path d="M56 61Q60 58 64 61L60 65Z" /><path d="M52 68Q60 74 68 68" fill="none" strokeWidth="2.5" strokeLinecap="round" /></g>}
    </g>
  </svg>;
}

export default function Companion({ appearance: value, name = 'Vesper', working = false, needsInput = false, onCustomize, onHide,onNeedsInput,voice={},reply='',onTalk,canTalk=false,canRealtime=false,voiceSettings,onVoiceSettings,talkUnavailableReason='' }) {
  const appearance = normalizeAppearance(value);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [reduced,setReduced]=useState(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches),[playful,setPlayful]=useState(false),[showTalkReason,setShowTalkReason]=useState(false),waveTimer=useRef(null),talkReasonId=useId();
  useEffect(()=>setShowTalkReason(false),[canTalk,canRealtime,voice.active,talkUnavailableReason]);
  useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),changed=()=>setReduced(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  useEffect(()=>()=>clearTimeout(waveTimer.current),[]);
  useEffect(() => { let nativeVisible=true;const changed = () => setVisible(nativeVisible&&document.visibilityState !== 'hidden');const off=api.onEvent(event=>{if(event.type==='companion.visibility'){nativeVisible=event.visible===true;changed();}});document.addEventListener('visibilitychange', changed);return () => {off();document.removeEventListener('visibilitychange', changed);}; }, []);
  if (!appearance.companionEnabled) return null;
  const label = appearance.companionLabel || name;
  const {state,label:status}=characterStage({needsInput,working,voice,reply,expressive:appearance.companionExpressive,playful});
  const animate = visible && appearance.companionAnimate && appearance.motion !== 'reduced'&&!reduced;
  const talk=companionVoiceAction({settings:voiceSettings,active:voice.active,canTalk,canRealtime,unavailableReason:talkUnavailableReason});
  return <section className="companion-dock" aria-label="Your companion">
    <button type="button" className="companion-open" onClick={onCustomize} title="Customize your companion" aria-label={`${label}: ${status}. Customize companion`}>
      <CompanionAvatar avatar={appearance.companionAvatar} color={appearance.companionColor} design={appearance.companionDesign} artwork={appearance.companionArtwork} animate={animate} state={state} />
      <span className="companion-caption"><strong>{label}</strong><small>{status}</small></span>
    </button>
    <div className="companion-interactions">{onTalk&&<button type="button" className={`companion-talk ${voice.active?'is-active':''}`} title={talk.description} aria-disabled={!talk.available} aria-describedby={!talk.available?talkReasonId:undefined} aria-expanded={!talk.available?showTalkReason:undefined} onClick={()=>{if(!talk.available){setShowTalkReason(value=>!value);return;}onTalk(talk.mode);}}>{voice.active?<Square size={13}/>:<Mic size={13}/>}<span>{voice.active?'Stop':'Talk'}</span></button>}{needsInput&&onNeedsInput?<button type="button" className="text-button companion-answer" onClick={onNeedsInput}><MessageSquare size={13}/>Answer</button>:<button type="button" className="icon-button" aria-label="Wave to companion" title="Wave" onClick={()=>{setPlayful(true);clearTimeout(waveTimer.current);waveTimer.current=setTimeout(()=>setPlayful(false),1400);}}><Hand size={14}/></button>}{onVoiceSettings&&<button type="button" className="icon-button" aria-label="Companion voice settings" title="Voice settings" onClick={onVoiceSettings}><Settings2 size={14}/></button>}</div>
    {onTalk&&!talk.available&&<p id={talkReasonId} className={showTalkReason?'companion-voice-reason':'sr-only'} role={showTalkReason?'status':undefined}>{talk.description}</p>}
    {onTalk&&voice.error&&<p className="companion-voice-reason" role="alert">{voice.error}</p>}
    {onTalk&&!voice.active&&voice.error&&<details className="companion-voice-recovery"><summary>Voice options</summary><p className="companion-voice-reason">{talk.description}</p><DeviceVoiceChoice api={api} voice={voice} visible={talk.mode==='realtime'} canTalk={canTalk}/></details>}
    <button type="button" className="icon-button companion-hide" aria-label="Hide companion" title="Hide companion; enable it again in Personalisation" onClick={onHide}><X size={12} /></button>
  </section>;
}

export function CompanionSettings({ appearance: value, onChange, name = 'Vesper' }) {
  const appearance = normalizeAppearance(value);
  const [label, setLabel] = useState(appearance.companionLabel);
  const [color, setColor] = useState(appearance.companionColor);
  const [importBusy,setImportBusy]=useState(false);
  useEffect(() => setLabel(appearance.companionLabel), [appearance.companionLabel]);
  useEffect(() => setColor(appearance.companionColor), [appearance.companionColor]);
  const saveLook = () => onChange({ companionLabel: label.trim(), companionColor: color });
  return <div className="persona-styles companion-settings">
    <div className="persona-styles-head"><div><strong>Visual companion</strong><small>An avatar that shows activity, listens and talks.</small></div>
      <button type="button" role="switch" aria-checked={appearance.companionEnabled} disabled={importBusy} aria-label="Show visual companion" className={`toggle ${appearance.companionEnabled ? 'on' : ''}`} onClick={() => onChange({ companionEnabled: !appearance.companionEnabled })}><span /></button></div>
    {appearance.companionEnabled && <fieldset className="companion-editors" disabled={importBusy}>
      <div className="companion-choices" role="radiogroup" aria-label="Companion avatar">{BUILT_IN_AVATARS.map(([id, title], index, list) => <button type="button" role="radio" key={id} tabIndex={appearance.companionAvatar===id||index===0&&!list.some(([item])=>item===appearance.companionAvatar)?0:-1} aria-checked={appearance.companionAvatar === id} aria-label={title} onClick={() => onChange({ companionAvatar: id })} onKeyDown={event => {const keys={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1,Home:-index,End:list.length-1-index};if(!(event.key in keys))return;event.preventDefault();const next=(index+keys[event.key]+list.length)%list.length;onChange({companionAvatar:list[next][0]});event.currentTarget.parentElement.querySelectorAll('[role=radio]')[next]?.focus();}}><CompanionAvatar avatar={id} color={color} animate={false} /><span>{title}</span></button>)}</div>
      <div className="companion-fields"><label>Display label<input aria-label="Companion display label" value={label} placeholder={name} maxLength={40} onChange={event => setLabel(event.target.value)} onBlur={() => label.trim() !== appearance.companionLabel && onChange({ companionLabel: label.trim() })} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveLook();}}} /><small>Leave empty to follow the Soul’s name. This label changes only its appearance.</small></label>
        <label>Colour<input type="color" aria-label="Companion colour" value={color} onChange={event => setColor(event.target.value.toLowerCase())} onBlur={() => color!==appearance.companionColor&&onChange({companionColor:color})} /></label></div>
      <div className="style-actions"><button type="button" className="secondary-button small" disabled={label.trim()===appearance.companionLabel&&color===appearance.companionColor} onClick={saveLook}>Apply label and colour</button></div>
      <label className="companion-motion"><input type="checkbox" checked={appearance.companionAnimate} onChange={event => onChange({ companionAnimate: event.target.checked })} />Animate when motion is allowed</label>
      <label className="companion-motion"><input type="checkbox" checked={appearance.companionExpressive} onChange={event=>onChange({companionExpressive:event.target.checked})}/>React to explicit delivery cues such as [happy] and [thoughtful]</label>
      <details className="companion-about"><summary>Voice and animation</summary><p className="style-help">Choose AI or device speech in Voice settings. AI voice asks for your acknowledgment before sharing microphone audio and chat context. The avatar follows actual listening, speaking and task activity.</p><p className="style-help">Animation respects reduced motion and pauses when hidden. The avatar itself makes no AI requests.</p></details>
      <CompanionDesigner appearance={appearance} onChange={onChange} Avatar={CompanionAvatar} onBusyChange={setImportBusy}/>
    </fieldset>}
  </div>;
}
