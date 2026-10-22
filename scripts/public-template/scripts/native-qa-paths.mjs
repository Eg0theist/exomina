import path from 'node:path';

/** Chromium's observed Linux singleton socket includes this scoped suffix.
 * sun_path has 108 bytes including its NUL terminator; count UTF-8 bytes.
 */
export function assertLinuxQaSocketLength(profile,{pathApi=path}={}) {
 const candidate=pathApi.join(profile,'data','runtime-tmp','scoped_dirXXXXXX','SingletonSocket');
 const bytes=Buffer.byteLength(candidate,'utf8');
 if(bytes>=108)throw Error('The synthetic Linux profile is too long for Chromium sockets. Use a shorter checkout path.');
 return {maximumExclusive:108,candidateBytes:bytes};
}
