import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AssetStore,validateImageAsset,MAX_ASSET_BYTES} from '../desktop/assets.mjs';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-assets-')),stores=[];t.after(async()=>{for(const store of stores)store.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await rm(dir,{recursive:true,force:true});});const open=async()=>{const store=new AssetStore(dir);stores.push(store);await store.init();return store;};return {dir,open};}
test('images round-trip, deduplicate and reopen with metadata-only indexes',async t=>{
 const f=await fixture(t),a=await f.open(),meta=await a.put(PNG,{mimeType:'image/png'});assert.equal(meta.bytes,68);assert.equal(meta.id,meta.sha256);assert.deepEqual(Object.keys(meta).sort(),['bytes','id','mimeType','sha256']);assert.deepEqual(await a.put(Buffer.from(PNG,'base64')),meta);assert.deepEqual(a.index(),[meta]);assert.equal((await a.get(meta.id)).dataBase64,PNG);assert.deepEqual(await a.import(await a.export(meta.id)),meta);a.close();const b=await f.open();assert.deepEqual(b.index(),[meta]);assert.equal((await b.get(meta.id)).dataBase64,PNG);assert.equal((await readdir(path.join(f.dir,'assets'))).filter(name=>name.endsWith('.asset')).length,1);assert.equal((await readdir(path.join(f.dir,'assets'))).some(name=>name.endsWith('.tmp')),false);
 await b.remove(meta.id);assert.deepEqual(b.index(),[]);assert.equal(await b.get(meta.id),null);
});
test('invalid base64, oversize data, SVG and MIME mismatches never persist',async t=>{
 const f=await fixture(t),a=await f.open();for(const value of ['',PNG+'\n','!!!!','Zg===','Zh==','data:image/png;base64,'+PNG])await assert.rejects(a.put(value),/base64/);await assert.rejects(a.put(Buffer.alloc(MAX_ASSET_BYTES+1)),/20 MiB/);await assert.rejects(a.put(Buffer.from('<svg/>')),/PNG, JPEG and WebP/);await assert.rejects(a.put(PNG,{mimeType:'image/jpeg'}),/MIME/);await assert.rejects(a.put(Buffer.from(PNG,'base64').subarray(0,40)),/Truncated|Incomplete/);assert.deepEqual(a.index(),[]);
});
test('safe IDs, checksums and file integrity prevent path access and silent corruption',async t=>{
 const f=await fixture(t),a=await f.open();for(const id of ['../private','C:\\private','a'.repeat(64)+'..','a/b','A'.repeat(64)]){await assert.rejects(a.get(id),/ID/);await assert.rejects(a.remove(id),/ID/);}
 const meta=await a.put(PNG);await assert.rejects(a.import({...meta,dataBase64:PNG,id:'b'.repeat(64)}),/ID/);await assert.rejects(a.import({...meta,dataBase64:PNG,sha256:'b'.repeat(64)}),/checksum/);await assert.rejects(a.import({...meta,dataBase64:PNG,bytes:1}),/byte count/);
 const file=path.join(f.dir,'assets',meta.id+'.asset'),bytes=await readFile(file);bytes[45]^=1;await writeFile(file,bytes);await assert.rejects(a.get(meta.id),/content/);
});
test('hard-linked assets are refused and concurrent identical writes stay consistent',async t=>{
 const f=await fixture(t),a=await f.open(),b=await f.open();const results=await Promise.all(Array.from({length:100},(_,n)=>(n%2?a:b).put(PNG))),one=results[0];assert.ok(results.every(value=>JSON.stringify(value)===JSON.stringify(one)));assert.equal(a.index().length,1);assert.equal((await readdir(path.join(f.dir,'assets'))).filter(name=>name.endsWith('.asset')).length,1);assert.equal((await readdir(path.join(f.dir,'assets'))).some(name=>name.endsWith('.tmp')),false);const file=path.join(f.dir,'assets',one.id+'.asset');await link(file,path.join(f.dir,'external-link'));await assert.rejects(a.get(one.id),/redirected|invalid/);await assert.rejects(a.remove(one.id),/redirected|invalid/);
});
test('JPEG and WebP recognition checks their frame/container headers',()=>{
 const jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);assert.equal(validateImageAsset(jpeg).metadata.mimeType,'image/jpeg');
 const webp=Buffer.alloc(26);webp.write('RIFF');webp.writeUInt32LE(18,4);webp.write('WEBPVP8L',8);webp.writeUInt32LE(5,16);webp[20]=47;assert.equal(validateImageAsset(webp).metadata.mimeType,'image/webp');webp.writeUInt32LE(100,4);assert.throws(()=>validateImageAsset(webp),/Truncated WebP/);
});
