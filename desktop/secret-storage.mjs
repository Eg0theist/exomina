const unavailable = () => Object.assign(new Error('Protected credential encryption is unavailable. Unlock or enable secure credential storage and try again. No secret has been saved.'), { code: 'SECRET_STORAGE_UNAVAILABLE' });

/** A read-only Mac status must not synchronously open Keychain before the UI.
 * Secret operations below still require the actual protected OS backend.
 */
export function protectedSecretStorageStatus(encryption,{platform=process.platform}={}) {
  if(platform==='darwin')return {secretStorageAvailable:null,secretStorageStatus:'unchecked'};
  try{requireProtectedSecretStorage(encryption);return {secretStorageAvailable:true,secretStorageStatus:'available'};}
  catch{return {secretStorageAvailable:false,secretStorageStatus:'unavailable'};}
}

/** Electron can report encryption available while using Linux's basic_text
 * fallback. That backend uses a public key and cannot protect saved secrets.
 * Other encryption adapters (such as the server's explicit AES key) do not
 * expose an OS backend. This guard never changes their existing blob format.
 */
export function requireProtectedSecretStorage(encryption) {
  try {
    if (encryption?.isEncryptionAvailable?.() !== true) throw unavailable();
    if (typeof encryption.getSelectedStorageBackend === 'function') {
      const backend = encryption.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') throw unavailable();
    }
  } catch { throw unavailable(); }
  return encryption;
}

export function encryptProtectedSecret(encryption, value) {
  requireProtectedSecretStorage(encryption);
  try {
    const bytes = encryption.encryptString(value);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw Error();
    return bytes;
  } catch { throw Object.assign(new Error('Credential encryption failed. No secret has been saved.'), { code: 'SECRET_STORAGE_ENCRYPT_FAILED' }); }
}

export function decryptProtectedSecret(encryption, bytes) {
  requireProtectedSecretStorage(encryption);
  try {
    const value = encryption.decryptString(bytes);
    if (typeof value !== 'string') throw Error();
    return value;
  } catch { throw Object.assign(new Error('Saved credentials could not be unlocked. Unlock secure credential storage or reconnect on this device and user account.'), { code: 'SECRET_STORAGE_DECRYPT_FAILED' }); }
}
