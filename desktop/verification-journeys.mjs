import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

// Product promises and repeatable journeys. These are maintained instructions,
// not evidence that the journey was executed or that a product is correct.
export const VERIFICATION_JOURNEYS=Object.freeze([
  {id:'update-handover',name:'Install an update and retain the workspace',promise:'The exact approved build opens a responsive workspace and retains encrypted data.',entry:'Settings → Updates',
    preconditions:['Use an isolated installed layout and synthetic encrypted profile.','Record the candidate build ID before approving its restart.'],
    steps:['Open a synthetic retained conversation and draft.','Approve the exact candidate; exercise the live update handover.','Read the running build stamp after reopening and run outcome_verify for update_installed.'],
    expected:['The workspace is responsive with the retained conversation.','Installation completion is tied to the same approved build; staging alone never closes it.'],
    checks:['node scripts/qa-update-handoff.mjs <candidate>','node --test test/update-completion.test.mjs'],
    sources:['desktop/updates.mjs','desktop/update-activation.cjs','desktop/update-completion.mjs','desktop/update-restart-guard.mjs','scripts/qa-update-handoff.mjs'],
    exclusions:['Synthetic profile checks do not establish real-account authentication.','Windows evidence does not qualify macOS or Linux.']},
  {id:'interrupted-delivery',name:'Recover an interrupted report delivery',promise:'Uncertain external delivery is retained for reconciliation and cannot silently replay.',entry:'Library → scheduled reports → run history',
    preconditions:['Use a synthetic connector; do not send a real message.','Prepare a multi-part report and a paired synthetic destination.'],
    steps:['Record approval for the exact report bytes and destination.','Interrupt after a connector accepts a part but before its acknowledgement is durable.','Relaunch and inspect receipts; attempt resume and cancellation.','Reconcile explicitly, then confirm a fresh approval is required before a new send.'],
    expected:['Acknowledged, uncertain and undispatched parts remain distinguishable.','Unknown effects block automatic resend and cancellation.','Revocation prevents later parts from being sent.'],
    checks:['node --test test/workflow-journal-crash.test.mjs test/workflow-multipart.test.mjs','node scripts/qa-workflow-receipts.mjs'],
    sources:['desktop/workflow-journal.mjs','desktop/workflow-delivery.mjs','desktop/delivery-contract.mjs','desktop/messaging.mjs','src/Workbench.jsx'],
    exclusions:['A connector acknowledgement does not prove a person received or read a message.','Synthetic connectors do not establish live service compatibility.']},
  {id:'terminal-crash-recovery',name:'Reconnect a terminal after an app crash',promise:'An unexpected app disconnect preserves a new terminal host and shell during the recovery grace period.',entry:'Terminal → Agent commands',
    preconditions:['Create an isolated fresh terminal host.','Capture the shell PID and a unique output marker before the crash.'],
    steps:['Run a PowerShell command and record its folder and PID.','Force-kill only the synthetic owner process and reconnect within ten minutes.','Confirm the same shell PID, retained marker and successful new input.','Cleanly detach and confirm ordinary non-keep-alive shells stop.'],
    expected:['The shell survives the unexpected owner exit.','Clean quit follows the explicit keep-alive rules.','After host or machine loss, output/folder recovery does not claim the process survived.'],
    checks:['node scripts/qa-terminal-crash-grace.mjs <report> <packaged-desktop>','node --test test/execution-continuity.test.mjs'],
    sources:['desktop/execution-host.mjs','desktop/execution-client.mjs','desktop/execution-daemon.mjs','desktop/execution-runtime.mjs','scripts/qa-terminal-crash-grace.mjs'],
    exclusions:['Old live hosts retain their original behavior until replaced.','A machine power loss ends its running processes.']},
  {id:'procedure-acceptance',name:'Prepare and evaluate a reusable procedure',promise:'A procedure revision requires fresh host-observed checks for its exact inputs and does not gain execution authority.',entry:'Library → Skills → procedure',
    preconditions:['Use a saved synthetic chat and a harmless local artifact.','Retain the procedure revision, hash and selected input values.'],
    steps:['Prepare a checklist with named inputs.','Observe each condition through an appropriate host tool after preparation.','Evaluate using distinct matching same-chat marks.','Revise the procedure and confirm acceptance resets; test expiry and a permission change.'],
    expected:['Preparation validates inputs without executing steps.','Expired, reused, mismatched or pre-checklist marks are refused.','Mechanical conditions remain separate from content quality and human review.'],
    checks:['node --test test/skill-procedures.test.mjs','node scripts/qa-skill-procedures.mjs'],
    sources:['desktop/skill-procedures.mjs','desktop/skill-library.mjs','desktop/outcome-marks.mjs','src/SkillProcedure.jsx','scripts/qa-skill-procedures.mjs'],
    exclusions:['File existence and hashes do not establish factual or semantic correctness.','One checked case does not demonstrate general performance.']},
]);

const NOTICE='Journey instructions and fingerprints are observations about coverage, not a passing test. Attached host marks prove only their stated predicates. QA reports and human review remain separate.';
export const VERIFICATION_JOURNEYS_TOOL={name:'verification_journeys',description:'Inspect maintained product verification journeys, exact source fingerprints and evidence limits. catalog lists promises; inspect returns reproduction steps and source/build observations. Compare baseline fingerprints to see what needs rechecking. Does not execute tests, approve actions, or accept agent-supplied passing claims.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['catalog','inspect']},id:{type:'string',maxLength:80},query:{type:'string',maxLength:300},baseline:{type:'object',properties:{buildId:{type:'string',maxLength:80},sources:{type:'object',maxProperties:40,additionalProperties:{type:['string','null'],maxLength:64}}},required:['sources'],additionalProperties:false},markIds:{type:'array',maxItems:12,items:{type:'string',maxLength:100}}},required:['action'],additionalProperties:false}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=journey=>({id:journey.id,name:journey.name,promise:journey.promise,entry:journey.entry});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const boundedText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
function validateArgs(args){
  if(!record(args)||!['catalog','inspect'].includes(args.action))throw Error('Choose catalog or inspect.');
  const allowed=args.action==='catalog'?new Set(['action','query']):new Set(['action','id','baseline','markIds']);
  if(Object.keys(args).some(key=>!allowed.has(key)))throw Error('Unexpected verification journey argument.');
  if(args.query!==undefined&&!boundedText(args.query,300))throw Error('Use a single-line query of up to 300 characters.');
  if(args.action==='inspect'&&(!boundedText(args.id,80)||!args.id))throw Error('Choose a journey ID from catalog.');
  if(args.markIds!==undefined&&(!Array.isArray(args.markIds)||args.markIds.length>12||args.markIds.some(id=>!boundedText(id,100)||!id)||new Set(args.markIds).size!==args.markIds.length))throw Error('Select at most twelve unique host outcome IDs.');
  if(args.baseline!==undefined){
    const b=args.baseline,paths=new Set(VERIFICATION_JOURNEYS.flatMap(j=>j.sources));
    if(!record(b)||Object.keys(b).some(key=>!['buildId','sources'].includes(key))||!record(b.sources)||Object.keys(b.sources).length>40||b.buildId!==undefined&&b.buildId!==null&&!boundedText(b.buildId,80))throw Error('Provide only the previous build ID and source fingerprint map.');
    if(Object.entries(b.sources).some(([file,value])=>!paths.has(file)||value!==null&&(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))))throw Error('Use known source paths with SHA-256 fingerprints or null.');
  }
}

export function compareJourneyFingerprints(current,baseline){
  if(!baseline)return {status:'not_compared',reason:'No previous source fingerprint was supplied.'};
  if(!baseline.sources||typeof baseline.sources!=='object'||Array.isArray(baseline.sources))throw Error('Provide the previous source fingerprint map.');
  const files=Object.keys(current.sources),changed=files.filter(file=>current.sources[file]!==baseline.sources[file]),missing=files.filter(file=>current.sources[file]===null);
  return {status:missing.length?'incomplete':changed.length?'needs_recheck':'same_sources',changed,missing,buildChanged:typeof baseline.buildId==='string'&&baseline.buildId!==current.buildId,
    reason:missing.length?'Some sources could not be observed.':changed.length?'Changed sources require the affected journey to be exercised again.':'Matching source bytes preserve traceability; they do not establish that a test ran or that environments match.'};
}

export class VerificationJourneys{
  constructor({sourceRoot,getBuild=()=>null,getMarks=()=>[],now=()=>new Date()}){Object.assign(this,{sourceRoot,getBuild,getMarks,now});}
  async fingerprint(journey){
    const root=await realpath(this.sourceRoot),sources={},unavailable=[];
    for(const file of journey.sources){
      // All paths originate in the fixed manifest, never from tool arguments.
      try{
        const target=path.resolve(root,file),relative=path.relative(root,target);
        if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Source escaped the application root.');
        const info=await lstat(target),resolved=await realpath(target),within=path.relative(root,resolved);
        if(info.isSymbolicLink()||within.startsWith('..'+path.sep)||path.isAbsolute(within)||!info.isFile()||info.size>4*1024*1024)throw Error('Source is unavailable.');
        sources[file]=hash(await readFile(resolved));
      }catch{sources[file]=null;unavailable.push(file);}
    }
    const build=await this.getBuild();
    return {buildId:build?.id||null,version:build?.version||null,sources,unavailable,capturedAt:this.now().toISOString(),
      identityLimit:'The running build stamp and inspected source bytes are observed separately. Their correspondence is not established here. Customized installations may retain an older official source baseline.'};
  }
  async call(args={},conversationId){
    validateArgs(args);
    if(args.action==='catalog'){
      const query=String(args.query||'').toLowerCase().trim();
      return {journeys:VERIFICATION_JOURNEYS.filter(j=>!query||JSON.stringify(j).toLowerCase().includes(query)).map(metadata),notice:NOTICE};
    }
    if(args.action!=='inspect')throw Error('Choose catalog or inspect.');
    const journey=VERIFICATION_JOURNEYS.find(j=>j.id===args.id);if(!journey)throw Error('Choose a journey ID from catalog.');
    if(args.markIds!==undefined&&(!Array.isArray(args.markIds)||args.markIds.length>12||args.markIds.some(id=>typeof id!=='string'||id.length>100)))throw Error('Select at most twelve host outcome IDs.');
    const fingerprint=await this.fingerprint(journey),available=await this.getMarks(conversationId);
    const marks=Array.isArray(available)?available:available?.marks||[];
    const evidence=(args.markIds||[]).map(id=>{
      const mark=marks.find(item=>item.id===id&&item.checkedBy==='exomina');
      if(!mark)return {id,status:'unavailable',reason:'No accessible same-chat host mark has this ID.'};
      return {id:mark.id,kind:mark.kind,status:mark.status,at:mark.at,subject:mark.subject,observed:mark.observed||null,reason:mark.reason||null,
        coverage:'Only the host-observed predicate, not journey execution or semantic correctness.'};
    });
    return {journey:structuredClone(journey),fingerprint,comparison:compareJourneyFingerprints(fingerprint,args.baseline),
      verification:{journeyExecuted:'not_established',humanReview:'not_recorded',hostPredicates:evidence},notice:NOTICE};
  }
}
