import React, {useEffect, useId, useRef, useState} from 'react';
import {ArrowRight, BookOpen, Brain, Code2, Compass, FileSearch, FileSpreadsheet, Globe2, Image, Monitor, PenLine, Shapes, Smartphone, Sparkles, X} from 'lucide-react';
import './workspace-map.css';

const examples = [
  {id:'research',title:'Research a decision',short:'Evidence, comparisons, clear recommendations.',Icon:Globe2,label:'BROWSER + REASONING',result:'A decision you can examine',description:'Compare options, investigate a claim or understand a topic using original sources and links you can check.',steps:['Read original sources','Weigh the tradeoffs','Deliver a sourced recommendation'],prompt:'Help me decide between [options] for [purpose]. Research current information in the shared browser, compare the tradeoffs and costs, and recommend an option with source links. Separate verified facts from your judgment.',setup:'tools',setupLabel:'Browser access'},
  {id:'build',title:'Build or fix software',short:'From a real project to a tested change.',Icon:Code2,label:'FILES + COMMANDS',result:'Working changes, with evidence',description:'Read a project, trace a bug, implement a feature and run the checks that show whether it works.',steps:['Understand the project','Make the change','Test and explain the result'],prompt:'In my selected project folder, investigate [bug or feature]. Read the relevant code, implement a suitable solution and run the appropriate checks. Tell me what changed, what passed and what remains unverified.',setup:'tools',setupLabel:'File & command access'},
  {id:'write',title:'Write something that fits',short:'A strong draft, a careful edit, your voice.',Icon:PenLine,label:'WRITING + REVISION',result:'Words shaped for their purpose',description:'Develop an argument, edit a manuscript or turn rough material into a clear document, with attention to voice and audience.',steps:['Understand the intent','Draft or revise','Refine against the brief'],prompt:'Help me refine [text or idea] for [audience and purpose]. Preserve what works and my intended voice. Improve clarity, structure and rhythm, and explain the changes that affect the meaning.',setup:null},
  {id:'documents',title:'Make a document or spreadsheet',short:'A proposal, report, budget or comparison.',Icon:FileSpreadsheet,label:'DRAFT + EDITABLE FILE',result:'A reply you can use outside chat',description:'Build a clear document or a table from your material. Save a completed reply as a Word document, or save its tables as an Excel workbook.',steps:['Bring the material and purpose','Draft the document or tables','Use Save reply to choose a file'],prompt:'Create [a report, proposal, budget or comparison] from [my material] for [audience and purpose]. Check the supplied facts and calculations. Put spreadsheet data in clearly labelled tables. Give me the finished content in your reply so I can use Save reply to export it as Word or Excel.',setup:null},
  {id:'explain',title:'Make something easier to understand',short:'A clear example, comparison or visual explanation.',Icon:Shapes,label:'EXPLANATION + EXAMPLES',result:'Understanding you can build on',description:'Choose the form that explains the idea best: a worked example, comparison table, diagram or an interactive example when the available tools support it.',steps:['Find the difficult part','Choose a useful form','Check it against the original facts'],prompt:'Help me understand [topic] for [purpose]. Use clear language and a worked example. Choose a comparison table, diagram or interactive example if it makes the idea easier to understand. Keep the explanation accurate, identify important limits and verify the result with the available tools.',setup:null},
  {id:'images',title:'Create and edit images',short:'Illustrations, mockups and visual variations.',Icon:Image,label:'IDEA + IMAGE TOOLS',result:'A visual you can build on',description:'Describe a new image or bring a reference to edit, then iterate on composition, style and detail.',steps:['Describe the visual','Generate or edit','Refine the result'],prompt:'Create an image of [subject] for [purpose], in [style], with [composition, colours and details]. Use [aspect ratio]. If I attach a reference, preserve [elements to keep] while changing [requested edits].',setup:'connections',setupLabel:'AI connections'},
  {id:'notes',title:'Turn ideas into progress',short:'Find the useful work hiding in your notes.',Icon:BookOpen,label:'NOTEBOOK + ACTION',result:'A next step grounded in your ideas',description:'Connect scattered ideas, organize them into topics and carry a worthwhile task through to a verified result.',steps:['Read shared source notes','Find a worthwhile next step','Do the work and verify it'],prompt:'Read my shared notebook and its overview. Identify a useful unfinished idea, check what is already implemented, and recommend a concrete next step. Once we choose it, carry it through and verify the outcome.',setup:'notes',setupLabel:'Shared notebook'},
  {id:'memory',title:'Pick up an earlier thread',short:'Past conversations become useful context.',Icon:Brain,label:'MEMORY + CONVERSATIONS',result:'Continuity across chats and AIs',description:'Recover a previous decision, connect related conversations or continue a project without rebuilding its context from scratch.',steps:['Find the original exchange','Recover decisions and open work','Continue with the right context'],prompt:'Find our earlier conversations about [topic or project]. Read the original messages where needed, recover the decisions and unfinished work, and help me continue from where we left off. Flag anything uncertain or superseded.',setup:'memory',setupLabel:'Shared memory'},
  {id:'apps',title:'Get work done in apps',short:'Documents, websites and desktop workflows.',Icon:Monitor,label:'CONNECTED TOOLS + COMPUTER USE',result:'Actions in the tools you use',description:'Work in connected services, use a website or operate a desktop application. Available integrations and enabled controls determine the route.',steps:['Inspect the app and available tools','Carry out the requested work','Check the saved result'],prompt:'Help me complete [task] in [app or website]. Inspect the current state and available connected tools first, then do the work using the permitted controls. Verify the result in the app and tell me about any limitation.',setup:'tools',setupLabel:'App & desktop access'},
  {id:'inspect',title:'Understand an application',short:'Look inside code and supported executables.',Icon:FileSearch,label:'STATIC ANALYSIS + GHIDRA',result:'An explanation backed by code',description:'Inspect JavaScript, Electron or .NET applications, or explore a supported Windows executable with Ghidra.',steps:['Select the application','Trace code and references','Explain findings with evidence'],prompt:'Help me understand [application or executable] using static analysis. Locate it, select it for inspection and investigate [behaviour or question]. Cite the relevant code or addresses, explain the limits of the evidence and never execute the target.',setup:'tools',setupLabel:'App analysis tools'},
];

function exampleAccess(id,{desktop,canBrowse,localFiles,privateChat,settings}) {
  if(privateChat && !['write','explain'].includes(id))return {blocked:true,text:'Temporary chats support text only. Open a regular chat to use this workflow.'};
  if(!desktop && ['build','notes','apps','inspect','images'].includes(id))return {blocked:true,text:'Use the desktop app for this workflow.'};
  if(id==='research')return {blocked:!canBrowse||!settings.browserEnabled,text:!canBrowse?'Browser research is unavailable in this environment.':settings.browserEnabled?'Uses the browser selected in Tools.':'Browser tools are off. Enable them in Tools to research sources.'};
  if(id==='build')return {blocked:!localFiles,text:localFiles?'Choose a project folder in chat. Commands follow that chat’s permissions.':'File and command tools are unavailable in this environment.'};
  if(id==='notes')return {text:'Only notes you share with the AI can be used.'};
  if(id==='memory')return {blocked:!settings.memoryEnabled,text:settings.memoryEnabled?'Shared memory is on. Original conversations can be retrieved when needed.':'Shared memory is off. Enable it to connect earlier conversations.'};
  if(id==='apps')return {text:settings.desktopEnabled?'Computer use is enabled; connected app tools have their own access.':'Computer use is off. Connected app tools may still be available.'};
  if(id==='images')return {text:'Requires a connected AI with image tools. Availability and usage limits depend on the provider.'};
  if(id==='documents')return {blocked:!desktop,text:desktop?'Save reply is available below completed replies. Excel exports tables as values, with one sheet per table; attachments are saved separately.':'Draft on any device. Use the desktop app to export replies as Word or Excel.'};
  if(id==='explain')return {text:privateChat?'Use text and tables in this temporary chat. Open a regular chat for files and interactive examples.':'Text and tables work in chat. Creating interactive files or other media depends on the AI’s enabled tools.'};
  if(id==='inspect')return {text:'Native analysis is experimental: Windows x86/x64 EXE, with Ghidra and a full JDK configured.'};
  return {text:privateChat?'Works with the AI selected in your temporary chat. Paste your working text there.':'Works with the AI selected in your chat. Paste or attach your material there.'};
}

export function LayoutPreview({kind}) {
  const right=kind==='writing'?'Notes':'Browser',bottom=kind==='research'?'Notes':kind==='writing'?'Projects':'Terminal';
  return <div className={'layout-preview layout-'+kind} aria-hidden="true"><span className="layout-chat">Chat<i/><i/><i/></span><span className="layout-side">{right}<i/><i/></span><span className="layout-bottom">{bottom}<i/></span></div>;
}

export default function WorkspaceMap({open,onChange,onPrompt,onNavigate,onSettings,onNotes,desktop=false,canBrowse=false,localFiles=false,privateChat=false,settings={}}) {
  const dialog=useRef(null),detail=useRef(null),headingId=useId(),restoreFocus=useRef(true),downOnBackdrop=useRef(false);
  const [selected,setSelected]=useState('research');
  const example=examples.find(item=>item.id===selected),access=exampleAccess(selected,{desktop,canBrowse,localFiles,privateChat,settings});
  const Icon=example.Icon,detailId=headingId+'-example';
  useEffect(()=>{
    if(!open)return;
    const node=dialog.current,previous=document.activeElement;restoreFocus.current=true;node.showModal();
    return()=>{if(node.open)node.close();if(restoreFocus.current&&previous?.isConnected)previous.focus({preventScroll:true});};
  },[open]);
  const go=action=>{restoreFocus.current=false;dialog.current?.close();onChange(false);action();};
  function choose(id) {
    setSelected(id);
    // Reveal the example below the choices on narrow screens without moving keyboard focus.
    if(window.matchMedia('(max-width:700px)').matches)requestAnimationFrame(()=>detail.current?.scrollIntoView({block:'nearest',behavior:'instant'}));
  }
  function setup() {
    if(example.setup==='notes')go(onNotes);
    else if(example.setup==='memory')go(()=>onSettings('memory'));
    else if(example.setup==='connections')go(()=>onSettings('connections'));
    else go(()=>onNavigate('tools'));
  }
  return <><button type="button" className="browser-toggle workspace-map-trigger" aria-label="Explore workspace" aria-haspopup="dialog" aria-expanded={open} onClick={()=>onChange(true)}><Compass size={15}/><span>Explore</span></button>
    {open&&<dialog className="workspace-map" ref={dialog} aria-labelledby={headingId} onClose={()=>onChange(false)} onCancel={event=>{event.preventDefault();onChange(false);}} onPointerDown={event=>{downOnBackdrop.current=event.target===event.currentTarget;}} onClick={event=>{if(downOnBackdrop.current&&event.target===event.currentTarget)onChange(false);}}>
      <div className="workspace-map-content">
        <header><div><span className="eyebrow"><Sparkles size={13}/> EXPLORE EXOMINA</span><h2 id={headingId}>What would you like to accomplish?</h2><p>Go from a question or an idea to work you can use.</p></div><button type="button" autoFocus className="icon-button" aria-label="Close Explore" onClick={()=>onChange(false)}><X size={20}/></button></header>
        <div className="explore-body">
          <div className="explore-choices" role="group" aria-label="Things to try">{examples.map(({id,title,short,Icon:ChoiceIcon})=><button type="button" key={id} className={'explore-choice explore-'+id} aria-pressed={id===selected} aria-controls={detailId} onClick={()=>choose(id)}><span className="explore-choice-icon"><ChoiceIcon size={21} strokeWidth={1.6}/></span><span><strong>{title}</strong><small>{short}</small></span><ArrowRight className="explore-choice-arrow" size={14}/></button>)}</div>
          <section className={'explore-detail explore-'+selected} ref={detail} id={detailId} aria-labelledby={detailId+'-title'}>
            <div className="explore-detail-heading" aria-live="polite"><span className="explore-detail-icon"><Icon size={25} strokeWidth={1.5}/></span><span className="eyebrow">{example.label}</span><h3 id={detailId+'-title'}>{example.result}</h3><p>{example.description}</p></div>
            <ol className="explore-steps" aria-label="Example workflow">{example.steps.map((step,index)=><li key={step}><span className="explore-step-number">{index+1}</span><span>{step}</span></li>)}</ol>
            <div className="explore-prompt"><span className="eyebrow">TRY ASKING</span><p>{example.prompt}</p></div>
            <p className="explore-access" id={detailId+'-access'}>{access.text}</p>
            <div className="explore-actions"><button type="button" className="primary-button" disabled={access.blocked} aria-describedby={detailId+'-access'} onClick={()=>go(()=>onPrompt(example.prompt))}>Add to chat<ArrowRight size={15}/></button>{example.setup&&!privateChat&&(desktop||['connections','memory'].includes(example.setup))&&<button type="button" className="text-button" onClick={setup}>{example.setupLabel}</button>}</div>
            <small className="explore-draft-hint">Adds an editable prompt to your draft. You choose when to send.</small>
          </section>
        </div>
        <footer className="explore-footer"><p><Brain size={15}/><span>{privateChat?'Choose the AI for your task. Temporary chats use text only, without shared memory.':'Choose the AI for your task. Shared memory can carry context across models; your enabled tools and permissions apply.'}</span></p>{desktop&&!privateChat&&<button type="button" className="explore-phone" onClick={()=>go(()=>onSettings('messaging'))}><Smartphone size={19}/><span><strong>Take a task with you</strong><small>Discord: tasks and approvals. Telegram: chat and memory. Pair your bot and keep this PC awake, online and running Exomina.</small></span><ArrowRight size={16}/></button>}</footer>
      </div>
    </dialog>}
  </>;
}
