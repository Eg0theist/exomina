import React from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import useUpdateStatus from './useUpdateStatus.js';

// Only shown when there is something to act on; checking lives in Settings → Updates.
export default function UpdateButton({onOpen}){
 const{status}=useUpdateStatus(),progress=status?.remote?.progress;
 const downloading=['downloading','verifying'].includes(progress?.phase);
 const ready=status?.available,offered=!!status?.remote?.release;
 if(!ready&&!downloading&&!offered)return null;
 const version=status?.staged?.version?.replace(/^\d+\.\d+\.\d+-/,'');
 const label=ready?(version?`${version} ready`:'Update ready'):downloading?'Downloading update':'Update available';
 return <button className={`app-update-button ${ready?'update-ready':''}`} aria-label={`Exomina updates: ${label}`} onClick={onOpen} title={progress?.message||label}>{downloading?<LoaderCircle size={14} className="spin"/>:<Download size={14}/>}<span>{label}</span></button>;
}
