import React,{useState} from 'react';
import {api} from './transport.js';
export default function CharacterProfile(){
 const[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 async function run(method){setBusy(true);setError('');try{const result=await api.invoke(method);if(!result?.canceled)setNotice(method==='character.import'?'Character profile applied. Reload Personalisation to see its fields.':'Character profile saved.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <details><summary>Character profiles: personality, avatar and voice</summary><p>Keep the Soul’s name and character, companion design and voice choices together. Exomina profiles are declarative JSON. Custom images travel in library backups or can be imported separately. A voice may need choosing again on another operating system.</p><button className="secondary-button" disabled={busy} onClick={()=>run('character.export')}>Export character profile</button><button className="secondary-button" disabled={busy} onClick={()=>run('character.import')}>Import character profile</button>{notice&&<p role="status">{notice}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}</details>;
}
