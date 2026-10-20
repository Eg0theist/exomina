import React,{useEffect,useRef,useState} from 'react';
import {api} from './transport.js';
import {COMPANION_PARTS,normalizeCompanionDesign,DEFAULT_COMPANION_DESIGN} from '../desktop/companion-design.mjs';
import {createCompanionArtworkCache} from '../desktop/companion-artwork-cache.mjs';
const artworkCache=createCompanionArtworkCache(id=>api.invoke('companion.artwork.read',{id}));
const appearanceSignature=value=>JSON.stringify([value.companionEnabled,value.companionAvatar,value.companionDesign,value.companionArtwork,value.companionLabel,value.companionColor,value.companionAnimate]);

export function CustomCreature({design:input,state='ready'}){
 const design=normalizeCompanionDesign(input),{body,ears,eyes,tail,accessory}=design;
 const bodies={round:'M27 57Q23 19 60 20Q97 19 93 57L89 78Q85 98 60 98Q35 98 31 78Z',plush:'M28 54Q19 23 45 22Q57 14 71 23Q99 21 93 54Q103 72 88 88Q76 103 60 96Q43 103 31 88Q18 72 28 54Z',robot:'M32 25H88Q96 25 96 34V84Q96 95 85 95H35Q24 95 24 84V34Q24 25 32 25Z',cloud:'M25 77Q8 75 14 57Q16 47 30 48Q22 24 44 23Q59 9 72 24Q96 17 95 43Q116 45 109 65Q117 84 94 87H32Q18 88 25 77Z',droplet:'M60 11Q68 35 90 53Q112 88 76 97Q36 111 27 80Q19 58 40 39Q54 25 60 11Z'};
 return <g style={{'--companion-color':design.coat,'--pet-ink':design.ink}}>
  {accessory==='wings'&&<path fill={design.accent} d="M30 52Q0 24 10 63Q0 79 29 80M90 52Q120 24 110 63Q120 79 91 80"/>}
  {tail!=='none'&&<path className="companion-tail" fill={design.accent} d={{curl:'M84 86Q116 97 109 70Q105 58 99 66Q96 73 103 79Q107 90 86 78Z',flame:'M83 88Q116 91 108 49Q103 67 94 59Q103 78 84 78Z',fin:'M84 80L115 62L105 85L115 99L83 91Z'}[tail]}/>}
  {ears==='round'&&<g fill={design.accent}><circle cx="31" cy="27" r="15"/><circle cx="89" cy="27" r="15"/></g>}
  {ears==='pointed'&&<path fill={design.accent} d="M26 43L21 4L49 29M73 29L100 4L95 43"/>}
  {ears==='long'&&<g fill={design.accent}><ellipse cx="39" cy="20" rx="9" ry="19"/><ellipse cx="81" cy="20" rx="9" ry="19"/></g>}
  {ears==='antenna'&&<g fill={design.accent} stroke={design.ink} strokeWidth="3"><path fill="none" d="M43 29L34 9M77 29L86 9"/><circle cx="33" cy="8" r="5"/><circle cx="87" cy="8" r="5"/></g>}
  <path className="companion-coat" d={bodies[body]}/>
  <ellipse fill={design.accent} opacity=".55" cx="60" cy="79" rx="18" ry="12"/>
  <g fill={design.ink} stroke={design.ink}>
   {eyes==='round'&&<><ellipse cx="44" cy="49" rx="4" ry={state==='done'?2:5}/><ellipse cx="76" cy="49" rx="4" ry={state==='done'?2:5}/></>}
   {eyes==='sleepy'&&<path d="M37 49Q44 43 51 49M69 49Q76 43 83 49" fill="none" strokeWidth="4" strokeLinecap="round"/>}
   {eyes==='visor'&&<rect x="34" y="40" width="52" height="18" rx="8"/>}
   {eyes==='cyclops'&&<><ellipse cx="60" cy="47" rx="13" ry="12" fill={design.accent}/><ellipse cx="60" cy="47" rx="5" ry="7"/></>}
   {state==='waiting'?<ellipse cx="60" cy="66" rx="4" ry="5"/>:<path d="M51 65Q60 74 69 65" fill="none" strokeWidth="3" strokeLinecap="round"/>}
   <path d="M37 95H48M72 95H83" strokeWidth="4" strokeLinecap="round"/>
  </g>
  {eyes==='visor'&&<path stroke={design.accent} strokeWidth="3" d={state==='working'?'M41 49H78':'M41 49H53M67 49H78'}/>}
  {accessory==='scarf'&&<path fill={design.accent} d="M30 69Q60 84 91 69L87 81Q62 92 33 80ZM72 80L84 82L82 103L69 99Z"/>}
  {accessory==='crown'&&<path fill={design.accent} stroke={design.ink} strokeWidth="1.5" d="M39 26L34 8L49 17L60 3L71 17L86 8L81 26Z"/>}
  {accessory==='headphones'&&<g stroke={design.ink} strokeWidth="6" fill={design.accent}><path d="M24 52V43Q24 15 60 15Q96 15 96 43V52" fill="none"/><rect x="20" y="43" width="11" height="24" rx="4"/><rect x="89" y="43" width="11" height="24" rx="4"/></g>}
 </g>;
}

export function ImportedCompanion({artwork,animate,state}){
 const [source,setSource]=useState(''),[error,setError]=useState(false),[frame,setFrame]=useState(0);
 useEffect(()=>{let live=true;setSource('');setError(false);if(artwork)artworkCache.load(artwork.id).then(source=>{if(live)setSource(source);}).catch(()=>{if(live)setError(true);});return()=>{live=false;};},[artwork?.id]);
 useEffect(()=>{setFrame(0);if(!animate||!artwork||artwork.frames===1)return;const timer=setInterval(()=>setFrame(value=>(value+1)%artwork.frames),1000/artwork.fps);return()=>clearInterval(timer);},[animate,artwork?.id,artwork?.frames,artwork?.fps]);
 if(!artwork)return null;const width=artwork.width/artwork.frames,height=artwork.height/artwork.rows,row=artwork.rows===3?(state==='waiting'?2:state==='working'?1:0):0;
 return <svg className={`companion-avatar companion-artwork companion-${state}${animate?'':' companion-still'}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" data-frame={frame} data-state-row={row}>
  {source?<image href={source} x={-frame*width} y={-row*height} width={artwork.width} height={artwork.height}/>:<text x="50%" y="60%" textAnchor="middle" fontSize={Math.min(width,height)/3}>{error?'?':'…'}</text>}
 </svg>;
}

export default function CompanionDesigner({appearance,onChange,Avatar,onBusyChange=()=>{}}){
 const [design,setDesign]=useState(appearance.companionDesign),[preview,setPreview]=useState('ready'),[frames,setFrames]=useState(1),[rows,setRows]=useState(1),[fps,setFps]=useState(6),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const latest=useRef(appearance),mounted=useRef(true),generation=useRef(0);latest.current=appearance;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;onBusyChange(false);};},[]);
 useEffect(()=>setDesign(appearance.companionDesign),[JSON.stringify(appearance.companionDesign)]);
 useEffect(()=>{if(appearance.companionArtwork){setFrames(appearance.companionArtwork.frames);setRows(appearance.companionArtwork.rows);setFps(appearance.companionArtwork.fps);}},[appearance.companionArtwork?.id]);
 async function importFile(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;const current=++generation.current,signature=appearanceSignature(latest.current);setError('');setBusy(true);onBusyChange(true);try{
  if(file.size>4*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Choose a PNG, JPEG or WebP image up to 4 MiB. Animated characters use PNG sprite sheets.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('The image could not be read.'));reader.readAsDataURL(file);});
  const artwork=await api.invoke('companion.import',{dataBase64:data,mimeType:file.type,frames,rows,fps});if(!mounted.current||generation.current!==current)return;if(appearanceSignature(latest.current)!==signature)throw Error('Companion settings changed while importing. Your newer choice was kept. Select the file again to use it.');await onChange({companionArtwork:artwork,companionAvatar:'artwork'});
 }catch(error){if(mounted.current&&generation.current===current)setError(String(error?.message||error).replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{if(mounted.current&&generation.current===current){setBusy(false);onBusyChange(false);}}}
 function reset(){generation.current++;setDesign({...DEFAULT_COMPANION_DESIGN});setFrames(1);setRows(1);setFps(6);setPreview('ready');setError('');artworkCache.clear();onChange({companionAvatar:'fox',companionDesign:{...DEFAULT_COMPANION_DESIGN},companionArtwork:null,companionColor:'#b2c9bb',companionLabel:'',companionAnimate:true});}
 return <>
  <details className="companion-designer" open={appearance.companionAvatar==='custom'}><summary>Design your own companion</summary>
   <p className="style-help">Build a character from independent parts. Your design stays editable; saving it changes only the visual companion.</p>
   <div className="companion-design-preview"><Avatar avatar="custom" design={design} state={preview} animate={false}/><label>Preview activity<select aria-label="Companion preview activity" value={preview} onChange={event=>setPreview(event.target.value)}>{['ready','working','waiting','done'].map(state=><option key={state} value={state}>{state}</option>)}</select></label></div>
   <fieldset className="companion-design-fields" disabled={busy}>{Object.entries(COMPANION_PARTS).map(([key,options])=><label key={key}>{key[0].toUpperCase()+key.slice(1)}<select aria-label={`Companion ${key}`} value={design[key]} onChange={event=>setDesign({...design,[key]:event.target.value})}>{options.map(option=><option key={option} value={option}>{option}</option>)}</select></label>)}{[['coat','Body colour'],['accent','Accent colour'],['ink','Face colour']].map(([key,label])=><label key={key}>{label}<input type="color" aria-label={label} value={design[key]} onChange={event=>setDesign({...design,[key]:event.target.value})}/></label>)}</fieldset>
   <div className="style-actions"><button type="button" className="primary-button small" disabled={busy} onClick={()=>onChange({companionDesign:design,companionAvatar:'custom'})}>Save my design</button><button type="button" className="secondary-button small" disabled={busy} onClick={()=>setDesign({...DEFAULT_COMPANION_DESIGN})}>Reset design draft</button></div>
  </details>
  <details className="companion-designer" open={appearance.companionAvatar==='artwork'}><summary>Use your own artwork or sprite sheet</summary>
   <p className="style-help">Import a local PNG, JPEG or WebP, up to 4 MiB and 2048 × 2048 pixels. Sprite sheets use equal horizontal frames, with either one row or three rows: Ready, Working, Needs input. GIF and video files are not supported. Artwork is saved in your protected asset store; existing private-sync settings apply. This feature never sends it to an AI.</p>
   <fieldset className="companion-design-fields" disabled={busy}><label>Frames per row<input aria-label="Companion sprite frames" type="number" min={1} max={16} value={frames} onChange={event=>setFrames(Number(event.target.value))}/></label><label>Activity rows<select aria-label="Companion sprite rows" value={rows} onChange={event=>setRows(Number(event.target.value))}><option value={1}>One row for all states</option><option value={3}>Ready / Working / Needs input</option></select></label><label>Frames per second<input aria-label="Companion sprite speed" type="number" min={1} max={12} value={fps} onChange={event=>setFps(Number(event.target.value))}/></label></fieldset>
   <label className="companion-import">{busy?'Importing…':'Import artwork'}<input type="file" aria-label="Import companion artwork" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={importFile}/></label>
   {appearance.companionArtwork&&<div className="companion-design-preview companion-artwork-preview"><Avatar avatar="artwork" artwork={appearance.companionArtwork} state={preview} animate={false}/><label>Preview activity<select aria-label="Companion artwork preview activity" value={preview} disabled={busy} onChange={event=>setPreview(event.target.value)}>{['ready','working','waiting'].map(state=><option key={state} value={state}>{state}</option>)}</select></label></div>}
   {appearance.companionArtwork&&<><p className="style-help">Saved artwork: {appearance.companionArtwork.frames} frames × {appearance.companionArtwork.rows} rows at {appearance.companionArtwork.fps} fps. Select a file again to replace it or change its playback settings.</p><button type="button" className="secondary-button small" disabled={busy} onClick={()=>onChange({companionAvatar:'artwork'})}>Use saved artwork</button></>}
   {error&&<p className="inline-error" role="alert">{error}</p>}
  </details>
  <button type="button" className="text-button companion-reset" disabled={busy} onClick={reset}>Reset companion appearance</button>
 </>;
}
