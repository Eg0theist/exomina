import {createPublicKey,sign,verify} from 'node:crypto';

export const UPDATE_SIGNATURE_DOMAIN=Buffer.from('Exomina update release v2\0','utf8');
const MAX_PAYLOAD=128*1024,MAX_VALIDITY=90*24*60*60*1000,SKEW=5*60*1000;
const keyIdValid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const channelValid=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(value);

/** Only bundled build configuration may supply these keys. Never use feed,
 * settings, environment or cached-record fields as a publisher trust root. */
export function normalizeUpdateTrust(value){
 if(!channelValid(value?.channel)||!value?.trustedKeys||typeof value.trustedKeys!=='object'||Array.isArray(value.trustedKeys))return null;
 const keys=new Map(),entries=Object.entries(value.trustedKeys);if(!entries.length||entries.length>8)return null;
 try{for(const[id,pem]of entries){
  if(!keyIdValid(id)||typeof pem!=='string'||pem.length>4096)return null;
  const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')return null;keys.set(id,key);
 }}catch{return null;}
 return{channel:value.channel,keys};
}
function decode(value,limit,label){
 if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||!value.length)throw Error('Invalid signed update '+label+'.');
 const bytes=Buffer.from(value,'base64');if(bytes.length>limit||bytes.toString('base64')!==value)throw Error('Invalid signed update '+label+'.');return bytes;
}
/** Exact bytes, including whitespace, are signed. This avoids ambiguous JSON
 * canonicalization between publisher tools and installed clients. */
export function signReleaseEnvelope(payload,{keyId,privateKey}){
 if(!keyIdValid(keyId))throw Error('Invalid update signing key ID.');
 const bytes=Buffer.from(JSON.stringify(payload),'utf8');if(bytes.length>MAX_PAYLOAD)throw Error('Signed update payload is too large.');
 return{format:2,keyId,payload:bytes.toString('base64'),signature:sign(null,Buffer.concat([UPDATE_SIGNATURE_DOMAIN,bytes]),privateKey).toString('base64')};
}
export function verifyReleaseEnvelope(envelope,{trustedKeys,channel,trust,now=Date.now()}={}){
 const pinned=trust||normalizeUpdateTrust({trustedKeys,channel});
 if(!pinned)throw Error('Public updates require bundled publisher authentication keys.');
 if(envelope?.format!==2||!keyIdValid(envelope.keyId)||!pinned.keys.has(envelope.keyId))throw Error('The update publisher signing key is not trusted.');
 const bytes=decode(envelope.payload,MAX_PAYLOAD,'payload'),signature=decode(envelope.signature,64,'signature');
 if(signature.length!==64||!verify(null,Buffer.concat([UPDATE_SIGNATURE_DOMAIN,bytes]),pinned.keys.get(envelope.keyId),signature))throw Error('The update publisher signature is invalid.');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let payload;try{payload=JSON.parse(text);}catch{throw Error('The signed update payload is invalid JSON.');}
 if(payload?.format!==2||payload.channel!==pinned.channel)throw Error('The signed update belongs to another release channel.');
 const published=Date.parse(payload.publishedAt),expires=Date.parse(payload.expiresAt);
 if(!Number.isFinite(now)||!Number.isFinite(published)||!Number.isFinite(expires)||published>now+SKEW||expires<=now||expires<=published||expires-published>MAX_VALIDITY)throw Error('The signed update metadata is expired or has invalid publication dates.');
 return payload;
}
