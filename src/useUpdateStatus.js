import { useCallback, useEffect, useState } from 'react';
import { api } from './transport.js';

export default function useUpdateStatus(){
 const [status,setStatus]=useState(null),[error,setError]=useState('');
 const load=useCallback(()=>api.invoke('update.status').then(setStatus).catch(failure=>setError(failure.message||String(failure))),[]);
 useEffect(()=>{
  let mounted=true,activityTimer;
  const quiet=()=>api.invoke('update.status').then(value=>{if(mounted)setStatus(value);}).catch(()=>{});
  quiet();
  // A locally packaged build emits no event, so recheck on focus and every minute (local read only).
  const refresh=()=>{if(document.visibilityState!=='hidden')quiet();};
  const timer=setInterval(refresh,60000);
  window.addEventListener('focus',refresh);
  const unsubscribe=api.onEvent(event=>{
   if(event.type==='update.progress'){
    setStatus(current=>current?{...current,remote:{...current.remote,progress:event.progress}}:current);
    if(['ready','available','current','cancelled','error'].includes(event.progress?.phase))load();
   }else if(event.type==='state.changed')quiet();
   else if(['terminal.changed','chat.done','chat.queue','voice.event','voice.realtime.event','analysis.changed'].includes(event.type)){clearTimeout(activityTimer);activityTimer=setTimeout(quiet,150);}
  });
  return()=>{mounted=false;clearInterval(timer);clearTimeout(activityTimer);window.removeEventListener('focus',refresh);unsubscribe?.();};
 },[load]);
 return{status,setStatus,error,setError,load};
}
