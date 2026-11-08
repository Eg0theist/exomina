// A deliberately small finite explorer for Exomina's reviewed delivery and
// install-receipt boundaries. It is a model, not verification of arbitrary JS.
// Production replay tests accompany each invariant and a broken variant must
// expose a counterexample. No target code, shell or network is executed here.
export const PROTOCOL_MODELS=Object.freeze({
  delivery:{name:'Reviewed delivery',implementation:['desktop/workflow-journal.mjs:resume','desktop/workflow-journal.mjs:restore','desktop/workflow-journal.mjs:resolve'],
    assumptions:['One active journal owner; exclusive() serializes a run.','A save is atomic and awaited before dispatch.','At most one permission change and one artifact revision; at most two sends.','Connector failures after invocation leave the remote effect uncertain.'],
    invariants:['An effect uses current permission and the exact approved artifact.','An unknown effect cannot be replayed before explicit reconciliation.'],
    replay:'test/protocol-explorer.test.mjs: production journal interruption and revocation replays'},
  installation:{name:'Installation completion receipt',implementation:['desktop/update-completion.mjs:pendingUpdateReceipt','desktop/update-completion.mjs:settleUpdateReceipts'],
    assumptions:['Only host-created marks enter the trusted outcome store.','The host installed predicate observes the currently running build.','Exactly two symbolic build identities are explored.'],
    invariants:['Only a matching verified host installed mark closes an approved receipt.'],
    replay:'test/protocol-explorer.test.mjs: exhaustive production receipt mark combinations'},
});
const clone=value=>structuredClone(value);
const key=value=>JSON.stringify(value);
function deliveryNext(s,broken){
  const next=[],add=(action,patch)=>next.push({action,state:{...s,...patch}});
  if(s.epoch===0&&s.stage!=='done')add('permission-revoked',{epoch:1});
  if(s.revision===0&&['pending','approved','committed'].includes(s.stage))add('artifact-changed',{revision:1});
  if(s.stage==='pending')add('review-and-approve',{stage:'approved',approvedEpoch:s.epoch,approvedRevision:s.revision});
  if(s.stage==='approved')add('durable-dispatch-checkpoint',{stage:s.approvedEpoch===s.epoch&&s.approvedRevision===s.revision?'committed':'blocked'});
  if(s.stage==='committed'){
    const authorized=s.approvedEpoch===s.epoch&&s.approvedRevision===s.revision;
    if(authorized||broken==='skip-final-authorization')add('invoke-connector',{stage:'sending',effects:s.effects+1,badAuthorization:!authorized,replayedUnknown:s.unresolved});
    else add('final-check-blocked',{stage:'blocked'});
    add('crash-after-checkpoint',{stage:'unknown',unresolved:true});
  }
  if(s.stage==='sending'){
    add('acknowledgement-saved',{stage:'done',unresolved:false});
    add('lost-ack-or-owner-crash',{stage:'unknown',unresolved:true});
  }
  if(s.stage==='unknown'){
    add('human-confirms-delivered',{stage:'done',unresolved:false});
    if(s.effects<2)add('human-confirms-not-sent',{stage:'pending',unresolved:false});
    if(broken==='replay-unknown'&&s.effects<2)add('automatic-retry',{stage:'pending'});
  }
  if(s.stage==='blocked')add('new-explicit-review',{stage:'pending'});
  return next.filter(item=>item.state.effects<=2);
}
function installNext(s,broken){
  if(s.stage!=='approved')return [];
  const rows=[];
  for(const host of [false,true])for(const kind of ['file','update_staged','update_installed'])for(const status of ['verified','contradicted','unavailable'])for(const matching of [false,true]){
    const accepted=(broken==='trust-staged-mark'?host&&kind==='update_staged'&&status==='verified'&&matching:host&&kind==='update_installed'&&status==='verified'&&matching);
    rows.push({action:`observe:${JSON.stringify({host,kind,status,matching})}`,state:{stage:'settled',accepted,valid:host&&kind==='update_installed'&&status==='verified'&&matching}});
  }
  return rows;
}
export function exploreProtocol(id,{maxStates=5000,maxDepth=16,broken=null}={}){
  if(!PROTOCOL_MODELS[id])throw Error('Unknown protocol model.');
  if(!Number.isInteger(maxStates)||maxStates<2||maxStates>20000||!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>32)throw Error('Use 2–20,000 states and depth 1–32.');
  if(broken&&!['skip-final-authorization','replay-unknown','trust-staged-mark'].includes(broken))throw Error('Unknown deliberate fault.');
  const initial=id==='delivery'?{stage:'pending',epoch:0,revision:0,approvedEpoch:null,approvedRevision:null,effects:0,unresolved:false,badAuthorization:false,replayedUnknown:false}:{stage:'approved'};
  const queue=[{state:initial,trace:[]}],seen=new Set([key(initial)]);let transitions=0,bounded=false;
  for(let cursor=0;cursor<queue.length;cursor++){
    const item=queue[cursor],s=item.state;
    const violation=id==='delivery'?s.badAuthorization?'effect-with-stale-approval':s.replayedUnknown?'unknown-effect-replayed':null:s.accepted&&!s.valid?'installation-without-matching-host-installed-mark':null;
    if(violation)return {model:id,status:'counterexample',violation,states:seen.size,transitions,trace:item.trace,finalState:clone(s),limits:{maxStates,maxDepth},assumptions:PROTOCOL_MODELS[id].assumptions,meaning:'A counterexample in the bounded model; replay against production code before diagnosing a product defect.'};
    const successors=id==='delivery'?deliveryNext(s,broken):installNext(s,broken);
    for(const next of successors){
      transitions++;const nextKey=key(next.state);if(seen.has(nextKey))continue;
      if(item.trace.length>=maxDepth||seen.size>=maxStates){bounded=true;continue;}
      seen.add(nextKey);queue.push({state:next.state,trace:[...item.trace,{action:next.action,state:clone(next.state)}]});
    }
  }
  return {model:id,status:bounded?'inconclusive':'satisfied_in_model',states:seen.size,transitions,limits:{maxStates,maxDepth},assumptions:PROTOCOL_MODELS[id].assumptions,
    meaning:bounded?'The search limit was reached; no success is established.':'The finite model was exhausted under the listed assumptions. This is not proof of implementation, liveness, connector behavior or general correctness.'};
}
