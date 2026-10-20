import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ApiConnections} from '../desktop/api-connections.mjs';
import {CloudClient} from '../desktop/cloud-client.mjs';

test('empty API and cloud startup never inspect or decrypt an OS credential backend',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-empty-credentials-'));
 let backendAccesses=0;
 const encryption=new Proxy({}, {get(){backendAccesses++;throw Error('Unexpected Keychain access from empty startup.');}});
 const api=new ApiConnections({dataDir,encryption});
 const cloud=new CloudClient({dataDir,encryption,autoSync:false,fetchImpl:()=>{throw Error('Empty startup must not issue a request.');}});
 t.after(async()=>{await cloud.close();await rm(dataDir,{recursive:true,force:true});});
 await api.init();await cloud.init();
 assert.ok(api.status().every(connection=>connection.connected===false));
 assert.equal(cloud.status().enabled,false);assert.equal(cloud.status().state,'disabled');
 await cloud.sync();assert.equal(backendAccesses,0);
});
