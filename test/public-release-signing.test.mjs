import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createSignedRelease} from '../scripts/create-public-update.mjs';
import {verifyReleaseEnvelope} from '../desktop/update-auth.mjs';
test('publisher metadata binds immutable URL, archive and inventory to the packaged trust key',()=>{
 const key=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519'),trust={channel:'stable',trustedKeys:{release:key.publicKey.export({type:'spki',format:'pem'})}},now=Date.now(),args={stamp:{id:'publisher-test-build',version:'0.5.0',builtAt:new Date(now-1000).toISOString()},url:'https://github.com/example/exomina/releases/download/v0.5.0/package.zip',size:123,sha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),notes:'Release notes',channel:'stable',trust,keyId:'release',privateKey:key.privateKey,now};
 const result=createSignedRelease(args),payload=verifyReleaseEnvelope(result.envelope,{...trust,now});assert.equal(payload.windows.x64.url,args.url);assert.equal(payload.windows.x64.inventorySha256,args.inventorySha256);assert.equal(payload.expiresAt,new Date(now+30*86400000).toISOString());
 assert.throws(()=>createSignedRelease({...args,privateKey:other.privateKey}),/signature/);assert.throws(()=>createSignedRelease({...args,stamp:{...args.stamp,customized:true}}),/customized/);assert.throws(()=>createSignedRelease({...args,expiresDays:91}),/expire/);
});
