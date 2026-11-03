import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './transport.js';
import {createUpdateStatusRefresh} from './update-status-refresh.js';

export default function useUpdateStatus(){
 const [status,setStatus]=useState(null),[error,setError]=useState('');
 const coordinator=useRef(null);
 const load=useCallback(()=>coordinator.current?.request({immediate:true,reportError:true})||Promise.resolve(),[]);
 useEffect(()=>{
  const refresh=createUpdateStatusRefresh({read:()=>api.invoke('update.status'),apply:value=>{setStatus(value);setError('');},onError:failure=>setError(failure.message||String(failure)),visible:()=>document.visibilityState!=='hidden'});
  coordinator.current=refresh;
  const quiet=()=>refresh.request();
  const immediate=()=>refresh.request({immediate:true});
  immediate();
  // A locally packaged build emits no event, so recheck on focus and every minute (local read only).
  const timer=setInterval(quiet,60000);
  window.addEventListener('focus',immediate);
  document.addEventListener('visibilitychange',immediate);
  const unsubscribe=api.onEvent(event=>{
   if(event.type==='update.progress'){
    setStatus(current=>current?{...current,remote:{...current.remote,progress:event.progress}}:current);
    if(['ready','available','current','cancelled','error'].includes(event.progress?.phase))load();
   }else if(event.type==='transport.reconnected')immediate();
   else if(['state.changed','terminal.changed','chat.done','chat.queue','voice.event','voice.realtime.event','analysis.changed'].includes(event.type))quiet();
  });
  return()=>{refresh.dispose();if(coordinator.current===refresh)coordinator.current=null;clearInterval(timer);window.removeEventListener('focus',immediate);document.removeEventListener('visibilitychange',immediate);unsubscribe?.();};
 },[load]);
 return{status,setStatus,error,setError,load};
}
