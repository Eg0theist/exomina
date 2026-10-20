import React, { useState, useEffect } from 'react';
import { ArrowRight, ArrowLeft, Check, X, CircleHelp } from 'lucide-react';
import './tutorials.css';

export const TUTORIALS = [
  { id:'good-habits', title:'Getting the most out of Exomina', description:'Five habits that make memory, AI switching and long chats work for you.', steps:[
    { title:'One chat per project', text:'Exomina remembers a whole chat, however long. Older parts are summarised, and the AI can open the original messages when it needs them. Summaries follow time, not topic, so a chat about one subject stays clear, while a chat that mixes several squeezes them together. Keep one long-running chat per project, such as a book, a website or a work client. Use fresh chats for quick one-off questions.', page:'chat', target:'.new-chat-button' },
    { title:'Save decisions as notes', text:'With shared memory enabled, saved notes help other chats and connected AIs pick up useful facts and decisions. When you settle something, say “remember this”. Review Memory and correct or delete outdated notes. Notes and summaries are source material; important details still need checking.', page:'memory', target:'.memory-overview' },
    { title:'Point a new chat to older work', text:'A new chat can search your other chats, but only when it knows there is something to find. A few words such as “continuing the chapter edits from my book chat” tell it where to look.', page:'chat', target:'.composer', example:'Continuing our work from the other chat about ' },
    { title:'Pick the AI for the job', text:'When you switch AI within a chat, the conversation comes with you. Choose the one that suits the task, or whichever still has allowance. Before an important decision, ask another AI for a second opinion, and ask it for a critique rather than a vote.', page:'chat', target:'.model-chip' },
    { title:'Ask how it knows', text:'Summaries help the AI find things, but they are not proof. When an exact detail matters, ask the AI to check the original message or file. “How do you know?” is a fair question whenever an answer sounds certain.', page:'chat', target:'.composer', example:'How do you know? Please check the original message or file before relying on that.' }
  ]},
  { id:'voice', title:'Dictation and voice conversation', description:'Speak a message or hear your AI reply.', steps:[
    { title:'Dictate a draft', text:'Choose Voice beside Send, then Dictate a message. Speak in the language selected in Settings → Voice. Your words appear in the message box. Stop voice, review the words and send when ready.', page:'chat', target:'.voice-controls' },
    { title:'Talk in realtime', text:'Select a connected ChatGPT model and start with an empty message box. Choose Voice → Realtime ChatGPT. Audio streams to OpenAI through your subscription, and you can interrupt while it speaks. Mute pauses your microphone; Stop voice ends the connection. Transcripts are saved in this chat. Other models offer Windows dictation and spoken replies.', page:'chat', target:'.voice-controls' },
    { title:'Talk for ideas, type for precision', text:'Voice is good for thinking out loud, a quick check or planning on the move. Type anything where the exact wording matters, such as passages for a manuscript, instructions or specifications.', page:'chat', target:'.voice-controls' },
    { title:'Choose a voice', text:'Open Voice in Settings to choose an installed Windows language, speaking voice, speed and pause length. Read aloud under any completed reply plays that reply. Audio stays on this PC; sent text goes to the selected AI. This uses Windows speech rather than the provider’s native realtime voice.', page:'settings', section:'voice', target:'#settings-voice' }
  ]},
  { id:'first-chat', title:'Your first conversation', description:'Connect an AI and send a message.', steps:[
    { title:'Choose an AI', text:'Open Connections and choose a supported account. Available plans and free allowances depend on the provider. API keys are billed separately by their provider. Local models need their own server and model download, available through Advanced view. Subscription sign-in opens the provider’s official page; return here when it finishes.', page:'connections', target:'.connection-grid' },
    { title:'Review access', text:'Open Tools to choose browser, computer and file access. Ask lets you review actions before they happen. The access control beside Send applies to this chat. Choose broader access only when it suits your task.', page:'tools', target:'.capability-grid' },
    { title:'Start a conversation', text:'Click New chat. Choose your AI in the menu beside Send. Write a question in the message box. Press Enter or click the arrow to send; Shift + Enter adds a new line.', page:'chat', target:'.composer', example:'Explain what Exomina can help me do in everyday language.' },
    { title:'Keep talking', text:'Your chats appear on the left. Click one to continue from the latest message. Use Top and Bottom in the header to move through a long chat. You can start another chat while an AI is replying. Giving each project its own chat keeps its memory clear.', page:'chat', target:'.new-chat-button' }
  ]},
  { id:'models-usage', title:'Models, usage, and continuity', description:'Choose who answers and keep a task going.', steps:[
    { title:'Choose the model', text:'Open the AI menu beside Send. A model is a version of the AI; effort controls how much time it spends working through a request. You can switch AI within an existing chat.', page:'chat', target:'.model-chip' },
    { title:'Check your allowance', text:'Open Settings → Usage & resets to see remaining subscription usage and reset times after connecting an account. Exomina refreshes it every minute. “Stale” means the last refresh failed. Each provider’s button opens its own usage page in the browser pane. Click elsewhere to close the panel.', page:'settings', section:'usage', target:'#settings-usage' },
    { title:'See resets and expiry dates', text:'Details in the usage panel opens Settings → Usage & resets. It lists your limits with exact reset dates and any ChatGPT reset credits with the date each one expires. Credits expiring within three days are listed first and highlighted.', page:'settings', section:'usage', target:'#settings-usage' },
    { title:'Choose visible models and fallbacks', text:'In Models & continuity, hide models you do not use and choose fallback models. Automatic fallback keeps a task going when the current model exhausts its allowance. Reset credits are always used by you, with confirmation.', page:'settings', section:'models', target:'#settings-models' },
    { title:'Ask for a second opinion', text:'Ask your AI to consult another available model for a review. Its contribution appears in the same chat. Helpers need verified available usage. An explicit image request can use ChatGPT’s native image tool.', page:'chat', target:'.composer', example:'Ask another available AI to review your answer, then explain any changes you would make.' }
  ]},
  { id:'files-tools', title:'Files and permissions', description:'Share a file and understand approval requests.', steps:[
    { title:'Share a file or screenshot', text:'Click the paperclip, drag a file onto the message box, or paste a screenshot. Review the attachments before sending. A message can include up to 10 files and 20 MiB in total.', page:'chat', target:'.attach-button' },
    { title:'Choose permissions for this chat', text:'The shield beside Send changes only this chat. Ask means you review actions. Read only prevents changes. Full access allows actions without routine prompts; Codex can still require confirmation. Settings controls the default for new chats.', page:'chat', target:'.permission-picker' },
    { title:'Understand an approval', text:'An approval explains the action, its purpose, and its impact. You can allow it once, for the chat, or as a saved rule. Declining is fine: the AI should explain what it can do next. Computer and browser access are enabled in Tools.', page:'tools', target:'.capability-grid' },
    { title:'Watch the browser', text:'When the AI researches the web, it uses the shared browser so you can watch and step in. Browser in the chat header shows or hides it. If you hide it, pages the AI opens load out of sight; pages you open yourself always show.', page:'chat', target:'.browser-toggle' },
    { title:'Follow the work', text:'The activity timeline shows the AI’s visible updates, steps, and elapsed time. Scroll up to read without being pulled back down. Choose Follow latest activity when you want to resume following.', page:'chat', target:'.composer' }
  ]},
  { id:'memory-style', title:'Memory and your writing style', description:'Make continuing conversations feel familiar.', steps:[
    { title:'Review saved notes', text:'Memory stores short, useful facts for connected AIs when sharing is enabled. Temporary chats and sharing settings limit access. Open Memory to read, correct or delete a note. Imported conversations can be searched when relevant and allowed. Keep passwords and login codes out of memory.', page:'memory', target:'.memory-overview' },
    { title:'Remember whole chats', text:'Each saved chat keeps its history across AI changes. When chat memory is enabled, compact summaries help find older parts, and the AI can open the original messages. Access to other chats depends on shared-memory settings. A correction should link back to its source; a summary alone is not proof.', page:'settings', section:'memory', target:'.chat-memory-settings' },
    { title:'Set your preferences', text:'Personalisation controls the default tone and instructions, including for continuing chats. You can add your own writing samples to create an editable style guide for replies or documents.', page:'settings', section:'personalization', target:'#settings-personalization' },
    { title:'Adjust this chat as you go', text:'Use Style beside Send, or tell the AI how you want it to respond from now on. Say “in this chat” or “in all chats” to make the scope clear.', page:'chat', target:'.chat-style', example:'In this chat, keep your replies concise and explain unfamiliar terms.' }
  ]},
  { id:'projects-prompts', title:'Projects, prompts, and branches', description:'Organise work and explore different directions.', steps:[
    { title:'Create a project', text:'Open Projects & prompts, choose New project, and give it a name and instructions. Choose a folder you trust and add shared files. Every chat in that project receives its current instructions and file list.', page:'workbench', target:'.workbench-tabs' },
    { title:'Reuse a prompt', text:'In Saved prompts, save text you use often and give it a shortcut such as /rewrite. Type / in the message box and choose a saved prompt. Edit the inserted text before you send it.', page:'workbench', target:'.workbench-tabs' },
    { title:'Try a different direction', text:'Under one of your messages, choose Edit & branch. Edit the message and create a branch, then send it when ready. Branch after an AI reply to keep that answer and continue differently. The original chat stays available. Open a chat from the list first if none is open.', page:'chat', target:'.messages, .chat-list-scroll' }
  ]},
  { id:'scheduled-work', title:'Scheduled tasks and phone results', description:'Create a recurring briefing or project summary.', steps:[
    { title:'Connect your phone, if you want', text:'In Messaging, connect your Telegram or Discord bot and send its pairing code. Only paired conversations can receive scheduled results. You can also keep results entirely in Exomina.', page:'settings', section:'messaging', target:'#settings-messaging' },
    { title:'Create a schedule', text:'In Projects & prompts, open Scheduled tasks. Choose a name, a clear request, an AI, and a daily, weekly, or one-time schedule. Select a project if needed. Review the time zone and delivery recipient before saving.', page:'workbench', target:'.workbench-tabs' },
    { title:'Review and control it', text:'Run now tests the task. Pause stops future runs. Open result shows the saved chat. Exomina must be running and your PC awake. A missed time is recorded; it does not trigger a surprise batch after sleep. Tasks cannot approve actions that need your attention.', page:'workbench', target:'.workbench-tabs' }
  ]},
  { id:'github', title:'Let the AI work with GitHub', description:'Sign in to GitHub once; every change still waits for your approval.', steps:[
    { title:'Sign in with GitHub', text:'In Connections, open the GitHub tab, choose which repositories the AI may reach and select Sign in with GitHub. Prefer a personal access token? Use the token option below the button instead.', page:'connections', target:'.github-connection' },
    { title:'Confirm on GitHub', text:'Exomina shows a short code and opens GitHub. Enter the code there and approve. The sign-in is kept encrypted on this computer, and the AI never sees it.', page:'connections', target:'.github-connection' },
    { title:'Ask for what you need', text:'Ask the AI to read a repository, explain an issue or review a pull request. Before it comments, commits, merges or deletes anything, Exomina shows you exactly what will change and does nothing until you approve. Disconnect removes the sign-in at any time.', page:'chat', target:'.composer' }
  ]},
  { id:'appearance-quick', title:'Make it yours', description:'Themes, text colour, and instant access.', steps:[
    { title:'Pick a look', text:'Choose a theme in Appearance, or match Windows. You can also adjust text colour, reading font and size. Ask Exomina in chat to help design a different look.', page:'settings', section:'appearance', target:'#settings-appearance' },
    { title:'Use quick access', text:'Enable Quick access in General. Press Ctrl + Shift + Space from another application to open a small question window. Sending starts a normal Exomina chat and opens the full app for its reply. Exomina must be running.', page:'settings', section:'general', target:'#settings-general' },
    { title:'Come back whenever you need', text:'Choose Learn Exomina on the home screen in either Standard or Advanced view. Every tutorial can be replayed. Advanced view also shows an optional daily tip; you can hide or restore tips here.', page:'tutorials', target:'.tutorial-grid' }
  ]}
];
// Keep saved tutorial IDs stable while putting the first-run path first.
TUTORIALS.sort((a,b)=>Number(b.id==='first-chat')-Number(a.id==='first-chat'));
TUTORIALS.push(
  {id:'backup-restore',title:'Back up and move your library',description:'Keep a restorable copy of conversations, memory and attachments.',steps:[
    {title:'Create a library backup',text:'Open Settings → Export & transfer and choose Back up library. Choose a destination you control. The backup includes conversations, memory, projects and attachment files. It can contain private information, so keep it in protected storage.',page:'settings',section:'data',target:'#settings-data'},
    {title:'Restore on another device',text:'Install Exomina, then choose Restore library in Export & transfer. Inspect the selected backup before confirming. Restore creates a separate library and needs the app to be idle. Open the launcher in its restored folder, then connect your provider accounts again. Project folders outside the library need copying separately.',page:'settings',section:'data',target:'#settings-data'},
    {title:'Choose the right export',text:'Context exports make old material searchable; they do not recreate a working library. Use a library backup for restoration, or a smaller saved-memory export when you only need those notes.',page:'settings',section:'data',target:'#settings-data'}]},
  {id:'work-plans',title:'Let agents coordinate a task',description:'Start a plan once and follow its progress.',steps:[
    {title:'Create a work plan',text:'Open Projects & prompts and select Work plans. Define the result, the steps and their dependencies. Choose available AIs and a request budget. Each worker uses your existing permissions.',page:'workbench',target:'.workbench-tabs'},
    {title:'Run and inspect',text:'Run the plan once. Independent steps can run together; the coordinator reviews results, requests revisions and advances dependent steps. You can inspect the chats and decisions. Optional human review pauses for your acceptance.',page:'workbench',target:'.workbench-tabs'},
    {title:'Stay in control',text:'Pause stops new steps from starting. Request limits and connection availability can also stop progress. Read the recorded reason and results before continuing. Provider usage and API charges still apply.',page:'workbench',target:'.workbench-tabs'}]},
  {id:'phone-access',title:'Continue from your phone',description:'Pair a phone and reconnect to work on your computer.',steps:[
    {title:'Pair your phone',text:'Open Settings → Phone access. Configure your private relay, then use its invitation or QR code on your phone. Keep pairing invitations private. Your computer and Exomina must stay running; this does not run tasks while the PC is off.',page:'settings',section:'phone',target:'#settings-phone'},
    {title:'Continue and steer work',text:'The phone page lets you open chats, send follow-ups and answer questions or approval requests. Reconnect after a network change. Check connection diagnostics in Phone access when the relay is unavailable.',page:'settings',section:'phone',target:'#settings-phone'},
    {title:'Manage access',text:'Review and revoke paired devices in Phone access. Discord and Telegram are separate options under Messaging. Discord offers /help and its own paired-account access level.',page:'settings',section:'messaging',target:'#settings-messaging'}]}
);
export const TIPS = [
  { text:'Keep one long chat per project. Quick questions can go in a fresh chat.', tutorial:'good-habits', step:0 },
  { text:'Settled something? Say “remember this”. Shared-memory settings control which chats can use the note.', tutorial:'good-habits', step:1 },
  { text:'Starting a chat that builds on older work? Mention it in a few words.', tutorial:'good-habits', step:2 },
  { text:'Switching AI keeps the chat’s context. Pick the one that suits the task.', tutorial:'good-habits', step:3 },
  { text:'When an exact detail matters, ask the AI to check the original.', tutorial:'good-habits', step:4 },
  { text:'Talk ideas through by voice. Type anything where the exact wording matters.', tutorial:'voice', step:2 },
  { text:'Before a big decision, ask another AI for a second opinion.', tutorial:'models-usage', step:4 }
];
const TIPS_KEY='exomina.tips.hidden';
export function tipsHidden() { try { return localStorage.getItem(TIPS_KEY)==='true'; } catch { return false; } }
export function setTipsHidden(hidden) { try { localStorage.setItem(TIPS_KEY,String(hidden)); } catch {} }
/** One tip per local day, so returning users see something new without being nagged. */
export function tipOfTheDay(date = new Date()) { return Math.floor((date.getTime()-date.getTimezoneOffset()*60000)/86400000)%TIPS.length; }

export default function Tutorials({ completed = {}, onStart }) {
  const [showTips,setShowTips] = useState(()=>!tipsHidden());
  return <div className="content-page tutorials-page"><div className="page-heading"><div><div className="eyebrow">LEARN AT YOUR PACE</div><h1>Learn Exomina</h1><p>Short walkthroughs in everyday language. Replay any tutorial whenever you like.</p></div><label className="tutorial-tips-toggle"><input type="checkbox" checked={showTips} onChange={event=>{setShowTips(event.target.checked);setTipsHidden(!event.target.checked);}}/>Show a tip on the start screen</label></div><div className="tutorial-grid">{TUTORIALS.map(t=><button className="tutorial-card" key={t.id} onClick={()=>onStart(t.id)}><CircleHelp size={22}/><strong>{t.title}</strong>{t.id==='first-chat'&&!completed[t.id]&&<em className="tutorial-badge">Start here</em>}<span>{t.description}</span><small>{t.steps.length} steps · {completed[t.id]?'Completed · Replay':'Start tutorial'}<ArrowRight size={14}/></small></button>)}</div></div>;
}
export function TutorialGuide({ tutorial, step, onStep, onClose, onComplete, onNavigate, onExample }) {
  const [highlight,setHighlight] = useState(false);
  const current = tutorial.steps[step];
  useEffect(()=>{
    if (!highlight) return;
    const timer=setTimeout(()=>{const el=document.querySelector(current.target); if(el){el.classList.add('tutorial-highlight'); el.scrollIntoView({block:'nearest',behavior:'smooth'});}},120);
    return ()=>{clearTimeout(timer); document.querySelectorAll('.tutorial-highlight').forEach(el=>el.classList.remove('tutorial-highlight'));};
  },[highlight,current]);
  return <aside className="tutorial-guide" aria-label="Tutorial walkthrough"><div aria-live="polite" aria-atomic="true"><small>{tutorial.title} · Step {step+1} of {tutorial.steps.length}</small><h2 id="tutorial-step-title">{current.title}</h2><p>{current.text}</p></div><div className="tutorial-guide-actions"><button className="secondary-button" onClick={()=>{onNavigate(current); setHighlight(true);}}>Show me<ArrowRight size={13}/></button>{current.example&&<button className="secondary-button" onClick={()=>onExample(current.example)}>Put example in message box</button>}<button className="icon-button" disabled={step===0} aria-label="Previous tutorial step" onClick={()=>{setHighlight(false);onStep(step-1);}}><ArrowLeft size={16}/></button>{step<tutorial.steps.length-1?<button className="primary-button" onClick={()=>{setHighlight(false);onStep(step+1);}}>Next<ArrowRight size={14}/></button>:<button className="primary-button" onClick={onComplete}>Finish<Check size={14}/></button>}<button className="icon-button" aria-label="Close tutorial" onClick={onClose}><X size={17}/></button></div></aside>;
}
