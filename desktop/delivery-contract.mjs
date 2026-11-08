import {createHash} from 'node:crypto';

// These contracts describe the implemented bridge, not a provider promise of
// exactly-once delivery. A successful POST acknowledges acceptance, not reading.
export function deliveryContract(channel) {
  if (!['telegram','discord'].includes(channel)) throw Error('Unsupported delivery connector.');
  return {version:1,channel,acknowledgement:'message_id',retry:'rate_limit_only',recovery:'owner_reconciliation',automaticReplay:false};
}
export function deliveryPart(text,index,total) {
  return {index,total,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text,'utf8')};
}
export function acknowledgedMessageId(channel,value) {
  const id=channel==='telegram'?value?.message_id:value?.id;
  return (typeof id==='string'&&/^\d{1,32}$/.test(id))||(Number.isSafeInteger(id)&&id>0)?String(id):null;
}
export function recordDeliveryProgress(attempt,progress,at) {
  const {index,total,sha256,bytes,status,messageId}=progress||{};
  if (!Number.isInteger(index)||!Number.isInteger(total)||total<1||total>300||index<0||index>=total||!Number.isInteger(bytes)||bytes<1||bytes>16000||!/^([a-f0-9]{64})$/.test(sha256||'')||!['dispatching','acknowledged'].includes(status)) throw Error('Invalid connector progress.');
  const previous=attempt.parts[index];
  if (status==='dispatching') {
    if(previous||index!==attempt.parts.length||index&&attempt.parts[index-1].status!=='acknowledged'||attempt.parts.length&&attempt.parts[0].total!==total) throw Error('Out-of-order connector dispatch.');
    attempt.parts.push({index,total,sha256,bytes,status,at});
  } else {
    if(!previous||previous.status!=='dispatching'||previous.sha256!==sha256||previous.bytes!==bytes||previous.total!==total||typeof messageId!=='string'||!/^\d{1,32}$/.test(messageId)) throw Error('Connector acknowledgement does not match its dispatch.');
    Object.assign(previous,{status,messageId,at});
  }
}
