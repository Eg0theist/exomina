export const UI_SCALES=[0.9,1,1.1,1.25,1.5];
export function normalizeUiScale(value){return UI_SCALES.includes(value)?value:1;}
/** Keyboard zoom changes the application chrome; embedded pages keep their own zoom. */
export function installUiZoom(window,{getScale,onChange}){
  const apply=()=>window.webContents.setZoomFactor(normalizeUiScale(getScale()));
  window.webContents.on('did-finish-load',apply);
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||!(input.control||input.meta)||input.alt)return;
    const key=input.key;
    if(!['+','=','-','0'].includes(key))return;
    event.preventDefault();
    const current=normalizeUiScale(getScale()),index=UI_SCALES.indexOf(current);
    const next=key==='0'?1:UI_SCALES[Math.max(0,Math.min(UI_SCALES.length-1,index+(key==='-'?-1:1)))];
    if(next!==current)Promise.resolve(onChange(next)).then(apply).catch(()=>{});
  });
  return apply;
}
