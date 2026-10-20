import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const executable=new URL('../vendor/muse/muse.exe',import.meta.url),metadata=JSON.parse(await readFile(new URL('../vendor/muse/provenance.json',import.meta.url),'utf8'));
const hash=createHash('sha256');for await(const chunk of createReadStream(executable))hash.update(chunk);
if((await stat(executable)).size!==metadata.bytes||hash.digest('hex')!==metadata.sha256)throw Error('The official Muse runtime did not match its pinned release checksum.');
console.log('Verified official Muse Code '+metadata.version+' and its release SHA-256.');
