import React, { useEffect, useRef, useState } from 'react';
import { Hand,MessageSquare, X } from 'lucide-react';
import { normalizeAppearance } from '../desktop/themes.mjs';
import CompanionDesigner,{CustomCreature,ImportedCompanion} from './CompanionDesign.jsx';
import {api} from './transport.js';
import {characterStage} from './character-stage.js';
import './companion.css';

/** Original vector avatars; no downloaded models, images or background inference. */
export function CompanionAvatar({ avatar = 'fox', color = '#b2c9bb', animate = true, state = 'ready',design,artwork }) {
  if(avatar==='artwork')return <ImportedCompanion artwork={artwork} animate={animate} state={state}/>;
  return <svg className={`companion-avatar avatar-${avatar} companion-${state} ${animate ? '' : 'companion-still'}`} viewBox="0 0 120 110" style={{ '--companion-color': color }} aria-hidden="true" focusable="false">
    <ellipse cx="60" cy="101" rx="30" ry="4" className="companion-shadow" />
    <g className="companion-body">
      {avatar==='custom'?<CustomCreature design={design} state={state}/>:avatar === 'star' ? <><path className="companion-coat" d="M60 12 Q64 12 74 37 L101 42 Q108 44 101 52 L82 70 L86 96 Q87 104 79 100 L60 88 L40 100 Q32 104 34 96 L38 70 L18 52 Q12 44 20 42 L46 37 Q56 12 60 12Z" /><path d="M41 33L46 21M86 29L92 20M100 78L109 81" className="companion-sparkles" /></> : <>
        <path className="companion-tail companion-coat" d={avatar === 'cat' ? 'M80 87 Q111 99 105 70 Q103 61 98 65 Q92 69 97 76 Q103 89 83 81Z' : 'M79 88 Q115 92 110 61 Q105 67 96 66 Q100 79 80 78Z'} />
        <ellipse className="companion-coat" cx="59" cy="79" rx="26" ry="20" />
        <path className="companion-coat companion-ear" d={avatar === 'cat' ? 'M29 47L27 13L49 32M70 31L93 13L90 48' : 'M28 47L24 9L49 32M71 32L97 9L92 48'} />
        <path className="companion-inner" d="M33 36L32 24L42 34M79 34L88 24L86 37" />
        <path className="companion-coat" d="M28 44Q30 29 60 28Q90 29 93 44L88 65Q79 82 60 83Q40 82 31 65Z" />
        <path className="companion-muzzle" d={avatar === 'cat' ? 'M35 57Q44 66 60 64Q76 66 86 57Q83 76 60 77Q38 76 35 57' : 'M29 49L52 62L60 73L68 62L92 49Q88 76 60 78Q33 76 29 49'} />
        <path className="companion-paws" d="M42 93L51 93M67 93L77 93" />
      </>}
      {avatar!=='custom'&&<g className="companion-face"><ellipse cx="45" cy="51" rx="3.4" ry="4.1" /><ellipse cx="75" cy="51" rx="3.4" ry="4.1" /><path d="M56 61Q60 58 64 61L60 65Z" /><path d="M52 68Q60 74 68 68" fill="none" strokeWidth="2.5" strokeLinecap="round" /></g>}
    </g>
  </svg>;
}

export default function Companion({ appearance: value, name = 'Vesper', working = false, needsInput = false, onCustomize, onHide,onNeedsInput,voice={},reply='',onTalk,canTalk=false }) {
  const appearance = normalizeAppearance(value);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [reduced,setReduced]=useState(()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches),[playful,setPlayful]=useState(false),waveTimer=useRef(null);
  useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),changed=()=>setReduced(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  useEffect(()=>()=>clearTimeout(waveTimer.current),[]);
  useEffect(() => { let nativeVisible=true;const changed = () => setVisible(nativeVisible&&document.visibilityState !== 'hidden');const off=api.onEvent(event=>{if(event.type==='companion.visibility'){nativeVisible=event.visible===true;changed();}});document.addEventListener('visibilitychange', changed);return () => {off();document.removeEventListener('visibilitychange', changed);}; }, []);
  if (!appearance.companionEnabled) return null;
  const label = appearance.companionLabel || name;
  const {state,label:status}=characterStage({needsInput,working,voice,reply,expressive:appearance.companionExpressive,playful});
  const animate = visible && appearance.companionAnimate && appearance.motion !== 'reduced'&&!reduced;
  return <section className="companion-dock" aria-label="Your companion">
    <button type="button" className="companion-open" onClick={onCustomize} title="Customize your companion" aria-label={`${label}: ${status}. Customize companion`}>
      <CompanionAvatar avatar={appearance.companionAvatar} color={appearance.companionColor} design={appearance.companionDesign} artwork={appearance.companionArtwork} animate={animate} state={state} />
      <span className="companion-caption"><strong>{label}</strong><small>{status}</small></span>
    </button>
    <div className="companion-interactions">{needsInput&&onNeedsInput?<button type="button" className="text-button" onClick={onNeedsInput}><MessageSquare size={12}/>Answer</button>:<button type="button" className="text-button" aria-label="Wave to companion" onClick={()=>{setPlayful(true);clearTimeout(waveTimer.current);waveTimer.current=setTimeout(()=>setPlayful(false),1400);}}><Hand size={12}/>Wave</button>}{onTalk&&<button type="button" className="text-button" disabled={!voice.active&&!canTalk} onClick={onTalk}>{voice.active?'Stop voice':'Talk'}</button>}</div>
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
    <div className="persona-styles-head"><div><strong>Visual companion</strong><small>An optional animated pet or avatar for your shared Soul. Customize the character, tone and instructions here; the visual companion shows task status.</small></div>
      <button type="button" role="switch" aria-checked={appearance.companionEnabled} disabled={importBusy} aria-label="Show visual companion" className={`toggle ${appearance.companionEnabled ? 'on' : ''}`} onClick={() => onChange({ companionEnabled: !appearance.companionEnabled })}><span /></button></div>
    {appearance.companionEnabled && <fieldset className="companion-editors" disabled={importBusy}>
      <div className="companion-choices" role="radiogroup" aria-label="Companion avatar">{[['fox', 'Fox'], ['cat', 'Cat'], ['star', 'Star']].map(([id, title], index) => <button type="button" role="radio" key={id} tabIndex={appearance.companionAvatar===id||index===0&&!['fox','cat','star'].includes(appearance.companionAvatar)?0:-1} aria-checked={appearance.companionAvatar === id} aria-label={title} onClick={() => onChange({ companionAvatar: id })} onKeyDown={event => {const keys={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1,Home:-index,End:2-index};if(!(event.key in keys))return;event.preventDefault();const next=(index+keys[event.key]+3)%3;onChange({companionAvatar:['fox','cat','star'][next]});event.currentTarget.parentElement.querySelectorAll('[role=radio]')[next]?.focus();}}><CompanionAvatar avatar={id} color={color} animate={false} /><span>{title}</span></button>)}</div>
      <div className="companion-fields"><label>Display label<input aria-label="Companion display label" value={label} placeholder={name} maxLength={40} onChange={event => setLabel(event.target.value)} onBlur={() => label.trim() !== appearance.companionLabel && onChange({ companionLabel: label.trim() })} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();saveLook();}}} /><small>Leave empty to follow the Soul’s name. This label changes only its appearance.</small></label>
        <label>Colour<input type="color" aria-label="Companion colour" value={color} onChange={event => setColor(event.target.value.toLowerCase())} onBlur={() => color!==appearance.companionColor&&onChange({companionColor:color})} /></label></div>
      <div className="style-actions"><button type="button" className="secondary-button small" disabled={label.trim()===appearance.companionLabel&&color===appearance.companionColor} onClick={saveLook}>Apply label and colour</button></div>
      <label className="companion-motion"><input type="checkbox" checked={appearance.companionAnimate} onChange={event => onChange({ companionAnimate: event.target.checked })} />Animate when motion is allowed</label>
      <label className="companion-motion"><input type="checkbox" checked={appearance.companionExpressive} onChange={event=>onChange({companionExpressive:event.target.checked})}/>React to explicit delivery cues such as [happy] and [thoughtful]</label>
      <p className="style-help">Talk uses the existing spoken-replies voice mode. Microphone access begins only after you choose Talk. The avatar follows actual listening and speaking state. Your Soul supplies the same personality across text and voice.</p>
      <p className="style-help">Shows task activity and requests for your input. Animation follows reduced-motion settings and pauses when the window is hidden. It makes no extra AI requests.</p>
      <CompanionDesigner appearance={appearance} onChange={onChange} Avatar={CompanionAvatar} onBusyChange={setImportBusy}/>
    </fieldset>}
  </div>;
}
