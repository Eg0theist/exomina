import React,{useEffect,useState} from 'react';
import {THEMES,PALETTE_ANCHORS,paletteContrastReport} from '../desktop/themes.mjs';

const LABELS={ground:'Background',ink:'Text base',accent:'Accent',leaf:'Secondary accent',lilac:'Text tint',warm:'Warm detail',danger:'Error',warn:'Warning',info:'Information'};

/** Validated colour data only. Drafts render in this sample until Apply is chosen. */
export default function PaletteEditor({appearance,onChange,busy}){
 const base=THEMES.find(theme=>theme.id===appearance.theme);
 const saved=JSON.stringify(appearance.customPalette);
 const[draft,setDraft]=useState(()=>({...base?.colors,...appearance.customPalette?.colors}));
 useEffect(()=>{setDraft({...base?.colors,...appearance.customPalette?.colors});},[appearance.theme,saved]);
 if(!base)return <details className="palette-editor"><summary>Custom colours</summary><p>Choose a fixed theme to customise its colours.</p></details>;
 const candidate={...base,colors:{...base.colors,...draft}},report=paletteContrastReport(candidate,appearance.textColor);
 const applied={...base.colors,...appearance.customPalette?.colors};
 const changed=PALETTE_ANCHORS.some(key=>draft[key]!==applied[key]);
 const controls=keys=><div className="palette-colours">{keys.map(key=><label key={key}><span>{LABELS[key]}</span><input type="color" value={draft[key]||base.colors[key]} disabled={busy} aria-label={`Palette ${LABELS[key]}`} onChange={event=>setDraft(value=>({...value,[key]:event.target.value.toLowerCase()}))}/><code>{draft[key]||base.colors[key]}</code></label>)}</div>;
 return <details className="palette-editor"><summary>Custom colours<span className="palette-summary-state">{appearance.customPalette?'Applied':changed?'Unsaved draft':'Optional'}</span></summary>
  <p>Preview changes here, then apply. Another theme resets custom colours.</p>
  {controls(PALETTE_ANCHORS.slice(0,3))}
  <details className="palette-more"><summary>More colours</summary>{controls(PALETTE_ANCHORS.slice(3))}</details>
  <div className="palette-sample" style={{background:draft.ground,color:appearance.textColor||draft.ink,borderColor:draft.accent}} aria-label="Custom palette sample"><strong>A place for your next idea</strong><p>A preview of your text, background and accent.</p><span style={{background:draft.accent,color:draft.ground}}>Example button</span></div>
  <p className={report.passed?'palette-contrast':'inline-error'} role="status">{report.passed?'Contrast checks pass':`Improve contrast before applying: ${report.checks.filter(check=>!check.passed).map(check=>`${check.label} ${check.ratio.toFixed(1)}:1 (needs ${check.minimum}:1)`).join('; ')}.`}</p>
  <details className="palette-more"><summary>What the colour check covers</summary><p>Checks the app’s mixed main, secondary and muted text, status colours and button text. Artwork and every overlay still need a visual check. An existing Text colour override is included.</p><ul>{report.checks.map(check=><li key={check.label}>{check.label}: {check.ratio.toFixed(1)}:1, minimum {check.minimum}:1</li>)}</ul></details>
  <div className="palette-actions"><button type="button" className="primary-button" disabled={busy||!changed||!report.passed} onClick={()=>onChange({customPalette:{baseTheme:base.id,colors:Object.fromEntries(PALETTE_ANCHORS.map(key=>[key,draft[key]]))}})}>Apply custom colours</button><button type="button" className="secondary-button" disabled={busy||!changed} onClick={()=>setDraft({...applied})}>Discard colour draft</button><button type="button" className="text-button" disabled={busy||(!appearance.customPalette&&!changed)} onClick={()=>{setDraft({...base.colors});if(appearance.customPalette)onChange({customPalette:null});}}>Reset theme colours</button></div>
 </details>;
}
