import React,{useEffect,useRef,useState} from 'react';

/** Query device speech only when an explicit recovery option is relevant. No capture. */
export default function DeviceVoiceChoice({api,voice,visible,canTalk}){
 const [available,setAvailable]=useState(false),[busy,setBusy]=useState(false),eligible=useRef(false);
 // Saving the explicit device preference hides this choice before capture starts.
 // Only losing Talk eligibility or unmounting invalidates that accepted action.
 eligible.current=Boolean(canTalk&&!voice.active);
 useEffect(()=>()=>{eligible.current=false;},[]);
 useEffect(()=>{let live=true;setAvailable(false);if(visible&&canTalk&&!voice.active)api.invoke('voice.status').then(status=>{if(live)setAvailable(Boolean(status?.available&&status.voices?.length));}).catch(()=>{});return()=>{live=false;};},[api,visible,canTalk,voice.active]);
 if(!visible||!canTalk||voice.active||!available||!voice.chooseDeviceSpeech)return null;
 return <div className="device-voice-choice"><button type="button" className="text-button" disabled={busy} onClick={async()=>{setBusy(true);try{await voice.chooseDeviceSpeech(()=>eligible.current);}finally{setBusy(false);}}}>{busy?'Starting device speech…':'Use this PC’s speech'}</button><small>Audio stays on this PC. Recognized text goes to your selected AI. This becomes your companion’s Talk voice.</small></div>;
}
