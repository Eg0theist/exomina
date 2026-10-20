import test from 'node:test';
import assert from 'node:assert/strict';
import {requireProtectedSecretStorage,encryptProtectedSecret,decryptProtectedSecret,protectedSecretStorageStatus} from '../desktop/secret-storage.mjs';
import {serverEncryption} from '../cloud/service.mjs';

test('read-only Mac credential status stays unchecked without entering Keychain, while secret operations still fail closed',()=>{
 let probes=0;
 const encryption={isEncryptionAvailable:()=>{probes++;throw Error('native Keychain interaction');}};
 assert.deepEqual(protectedSecretStorageStatus(encryption,{platform:'darwin'}),{secretStorageAvailable:null,secretStorageStatus:'unchecked'});
 assert.equal(probes,0);
 assert.throws(()=>encryptProtectedSecret(encryption,'synthetic-secret'),error=>error.code==='SECRET_STORAGE_UNAVAILABLE');
 assert.throws(()=>decryptProtectedSecret(encryption,Buffer.from('existing encrypted bytes')),error=>error.code==='SECRET_STORAGE_UNAVAILABLE');
 assert.equal(probes,2);
 assert.deepEqual(protectedSecretStorageStatus(encryption,{platform:'win32'}),{secretStorageAvailable:false,secretStorageStatus:'unavailable'});
 assert.equal(probes,3);
});

test('unavailable, basic_text and uninitialized OS backends never reach encryption',()=>{
  let calls=0;
  for(const encryption of [undefined,{isEncryptionAvailable:()=>false},{isEncryptionAvailable:()=>{throw Error('native diagnostic');}},...['basic_text','unknown'].map(backend=>({isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>backend,encryptString:()=>{calls++;return Buffer.from('public-key cipher');}}))]){
    assert.throws(()=>encryptProtectedSecret(encryption,'synthetic-secret'),error=>error.code==='SECRET_STORAGE_UNAVAILABLE'&&!error.message.includes('synthetic-secret'));
  }
  assert.equal(calls,0);
});

test('known Linux keyrings preserve the existing encrypted bytes and round trip',()=>{
  for(const backend of ['gnome_libsecret','kwallet','kwallet5','kwallet6']){
    const bytes=Buffer.from('original encrypted bytes');
    const encryption={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>backend,encryptString:value=>{assert.equal(value,'synthetic');return bytes;},decryptString:value=>{assert.equal(value,bytes);return 'synthetic';}};
    assert.equal(requireProtectedSecretStorage(encryption),encryption);
    assert.equal(encryptProtectedSecret(encryption,'synthetic'),bytes);
    assert.equal(decryptProtectedSecret(encryption,bytes),'synthetic');
  }
});

test('explicit server-key encryption is retained without an OS backend or format migration',()=>{
  const encryption=serverEncryption(Buffer.alloc(32,27).toString('base64'));
  const existing=encryption.encryptString('synthetic old credential');
  assert.equal(decryptProtectedSecret(encryption,existing),'synthetic old credential');
  const saved=encryptProtectedSecret(encryption,'synthetic new credential');
  assert.equal(encryption.decryptString(saved),'synthetic new credential');
});

test('native failures return neutral errors without credential or diagnostic leakage',()=>{
  const encryption={isEncryptionAvailable:()=>true,encryptString:()=>{throw Error('synthetic-secret native details');},decryptString:()=>{throw Error('synthetic-secret native details');}};
  assert.throws(()=>encryptProtectedSecret(encryption,'synthetic-secret'),error=>error.code==='SECRET_STORAGE_ENCRYPT_FAILED'&&!/synthetic-secret|Windows/.test(error.message));
  assert.throws(()=>decryptProtectedSecret(encryption,Buffer.from('synthetic')),error=>error.code==='SECRET_STORAGE_DECRYPT_FAILED'&&!/synthetic-secret|Windows/.test(error.message));
});
