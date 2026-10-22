import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {signReleaseEnvelope,verifyReleaseEnvelope,normalizeUpdateTrust} from '../desktop/update-auth.mjs';

const key=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519'),publicKey=key.publicKey.export({type:'spki',format:'pem'}),now=Date.now();
const options={trustedKeys:{release:publicKey},channel:'stable',now};
const payload={format:2,channel:'stable',id:'release-build-test',publishedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString()};
const signed=value=>signReleaseEnvelope(value,{keyId:'release',privateKey:key.privateKey});
test('Ed25519 envelope authenticates exact bytes with only pinned publisher keys',()=>{
 assert.deepEqual(verifyReleaseEnvelope(signed(payload),options),payload);
 assert.equal(normalizeUpdateTrust({channel:'stable',trustedKeys:{}}),null);
 assert.throws(()=>verifyReleaseEnvelope(signed(payload),{...options,trustedKeys:{release:other.publicKey.export({type:'spki',format:'pem'})}}),/signature/);
 assert.throws(()=>verifyReleaseEnvelope({...signed(payload),keyId:'feed-key',publicKey},options),/not trusted/);
 assert.throws(()=>verifyReleaseEnvelope(payload,options),/not trusted/);
});
test('tampering payload, signature, encoding or signing domain is rejected',()=>{
 const envelope=signed(payload),changed={...payload,id:'tampered-build-test'};
 assert.throws(()=>verifyReleaseEnvelope({...envelope,payload:Buffer.from(JSON.stringify(changed)).toString('base64')},options),/signature/);
 assert.throws(()=>verifyReleaseEnvelope({...envelope,signature:Buffer.alloc(64).toString('base64')},options),/signature/);
 assert.throws(()=>verifyReleaseEnvelope({...envelope,payload:envelope.payload+'\n'},options),/payload/);
 assert.throws(()=>verifyReleaseEnvelope({...envelope,signature:sign(null,Buffer.from(JSON.stringify(payload)),key.privateKey).toString('base64')},options),/signature/);
});
test('expired, future, overlong or cross-channel signed metadata is refused',()=>{
 for(const value of[{...payload,expiresAt:new Date(now-1).toISOString()},{...payload,publishedAt:new Date(now+600000).toISOString()},{...payload,expiresAt:new Date(now+91*86400000).toISOString()},{...payload,channel:'beta'}])assert.throws(()=>verifyReleaseEnvelope(signed(value),options),/dates|expired|channel/);
});
