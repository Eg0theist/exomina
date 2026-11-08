import React,{useEffect,useState} from 'react';
import {api} from './transport.js';
import DiffReview from './DiffReview.jsx';
import './task-workspace.css';
export default function TaskWorkspace({conversationId,running,onDraft}){
  const [record,setRecord]=useState(null),[review,setReview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let live=true;setRecord(null);setReview(null);setError('');api.invoke('taskWorkspace.status',{conversationId}).then(value=>{if(live)setRecord(value);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[conversationId]);
  async function act(action){setBusy(true);setError('');try{const value=await api.invoke('taskWorkspace.'+action,{conversationId});if(action==='diff')setReview(value);else{setRecord(['remove','forget'].includes(action)?null:value);setReview(null);}}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <details className="task-workspace"><summary>Coding workspace{record?' · separate branch':''}</summary>{record?<><p><strong>{record.branch}</strong></p><code>{record.folder}</code><p>Based on {record.base.slice(0,12)}. The original checkout stays separate.</p><button disabled={busy} onClick={()=>act('diff')}>Review changes</button><button disabled={busy||running} onClick={()=>act('remove')}>Remove clean task folder</button><button disabled={busy||running} onClick={()=>act('forget')}>Detach without deleting files</button>{review&&<DiffReview key={review.revision} review={review} conversationId={conversationId} onDraft={onDraft}/>}</>:<><p>Create a separate branch and checkout for this chat from the selected project’s committed files. Untracked and ignored files stay out. This does not sandbox programs.</p><button disabled={busy||running} onClick={()=>act('create')}>Create coding workspace</button></>}{error&&<p className="inline-error" role="alert">{error}</p>}</details>;
}
