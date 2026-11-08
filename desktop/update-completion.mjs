// Reply completion and installation are separate events. Persist the exact
// approved build, then compare it with the fresh running stamp on a later turn.
// This receipt never authorizes a restart or marks unrelated follow-ups done.
export function pendingUpdateReceipt(build, now = new Date()) {
  return {buildId:build.id,version:build.version||null,status:'restart-approved',at:now.toISOString()};
}

export function cancelUpdateReceipt(message, reason, now = new Date()) {
  if(message?.pendingUpdate?.status!=='restart-approved')return false;
  Object.assign(message.pendingUpdate,{status:'restart-cancelled',reason,at:now.toISOString()});
  return true;
}

export function settleUpdateReceipts(messages, mark) {
  if(mark?.checkedBy!=='exomina'||mark.kind!=='update_installed'||mark.status!=='verified'||!mark.observed?.buildId)return false;
  let changed=false;
  for(const message of messages){
    const receipt=message.pendingUpdate;
    if(receipt?.status!=='restart-approved'||receipt.buildId!==mark.observed.buildId)continue;
    Object.assign(receipt,{status:'installed-verified',verifiedAt:mark.at,markId:mark.id});changed=true;
  }
  return changed;
}

export function updateCompletionContext(messages, installed) {
  const pending=messages.filter(message=>message.pendingUpdate?.status==='restart-approved');
  if(!pending.length)return '';
  const rows=pending.slice(-5).map(message=>{
    const receipt=message.pendingUpdate;
    return {messageId:message.id,approvedBuild:receipt.buildId,version:receipt.version,
      runningBuild:installed?.id||null,
      status:installed?.id===receipt.buildId?'running-approved-build':'installation-unverified'};
  });
  return '\nHost update completion checkpoint (fresh running build stamp, not a historical installation claim):\n'+JSON.stringify(rows)+'\nFor a matching build, verify the installed outcome before reporting it and resolve only the associated installation work. For a different or unavailable build, inspect update status; do not repackage or request restart automatically. An approved restart needs the current reply to finish before installation can happen.\n';
}
