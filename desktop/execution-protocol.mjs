import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const executionProof=(token,role,...fields)=>createHmac('sha256',token).update(JSON.stringify([1,role,...fields])).digest('hex');
export const equalProof=(a,b)=>typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function executionEndpoint(root){const suffix=createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,24);return process.platform==='win32'?'\\\\.\\pipe\\exomina-execution-'+suffix:path.join(tmpdir(),'exomina-execution-'+process.getuid()+'-'+suffix,'host.sock');}
