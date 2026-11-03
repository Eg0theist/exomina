import React from 'react';
import './getting-started.css';
export default function GettingStarted({connections=[],conversations=[],onConnections,onStart,onControls,compact=false}){
 const ready=connections.some(c=>!c.checking&&c.available!==false&&(c.connected||c.configured)),hasWork=conversations.some(c=>c.hasUserMessages||c.messages?.some(m=>m.role==='user'));
 if(compact){
  if(ready&&hasWork)return null;
  const checking=!ready&&connections.some(c=>c.checking);
  return <section className="start-guidance" aria-label="Getting started">
   <div><strong>{ready?'Ready for your first message':checking?'Checking your AI connections…':'Connect an AI to start'}</strong><p>{ready?'Choose your AI beside Send, then type what you need below. Enter sends; Shift + Enter adds a line.':checking?'You can prepare a draft while we check.':'Exomina brings your AI, tools and saved work together. Sign in with an AI account you already use; its plan and usage limits apply.'}</p></div>
   {!ready&&!checking&&<button type="button" className="primary-button" onClick={onConnections}>Connect your AI</button>}
   <details className="start-guidance-details"><summary>How your first task works</summary><ol><li><strong>Ask in your own words.</strong> Say what you need back, such as a plan, an edited document or an explanation. No commands or special format are needed.</li><li><strong>Start with Ask before acting.</strong> Read permission requests before allowing changes. You can chat without enabling browser or computer control. <button type="button" className="text-button" onClick={onControls}>Review tools and access</button></li><li><strong>Review the result.</strong> Continue in the same chat to correct or improve it. Use a new chat for a different subject.</li></ol>{!ready&&<p>A subscription sign-in does not require an API key. Separately billed API connections and local model servers are optional alternatives in AI connections.</p>}</details>
  </section>;
 }
 return <details className="getting-started" open={!hasWork||undefined}><summary>Getting started{ready?' · AI connected':''}</summary><ol><li><strong>{ready?'Your AI is connected':'Connect an AI'}</strong><p>Use an existing subscription, a separately billed API key or your own local model.</p><button type="button" className="text-button" onClick={onConnections}>{ready?'Manage connections':'Connect your AI'}</button></li><li><strong>Choose access</strong><p>“Ask before acting” lets you review actions. Change access beside Send.</p><button type="button" className="text-button" onClick={onControls}>Tools and access</button></li><li><strong>Ask for what you need</strong><p>Bring a question, text, file or website. Review the result and continue in the same chat.</p><button type="button" className="text-button" onClick={onStart}>Choose a starting point</button></li></ol></details>;
}
