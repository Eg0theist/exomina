import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAppearance,validateAppearance} from '../desktop/themes.mjs';
import {normalizeCompanionDesign,normalizeCompanionArtwork,DEFAULT_COMPANION_DESIGN} from '../desktop/companion-design.mjs';
import {importCompanionArtwork} from '../desktop/companion-assets.mjs';
import {createCompanionArtworkCache} from '../desktop/companion-artwork-cache.mjs';

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
function fixture(){const calls={decode:0,put:0},assets={put:async buffer=>{calls.put++;assert.ok(Buffer.isBuffer(buffer));return {id:'a'.repeat(64)};}},nativeImage={createFromBuffer:()=>{calls.decode++;return {isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>Buffer.from(PNG,'base64')};}};return {calls,assets,nativeImage};}
const input=patch=>({dataBase64:PNG,mimeType:'image/png',frames:1,rows:1,fps:6,...patch});

test('custom companion parts and artwork metadata persist across unrelated appearance changes',()=>{
 const design={...DEFAULT_COMPANION_DESIGN,body:'robot',ears:'long',eyes:'visor',tail:'fin',accessory:'wings',coat:'#ffaa77',accent:'#5588aa',ink:'#111111'},artwork={id:'f'.repeat(64),width:320,height:240,frames:4,rows:3,fps:8};
 const saved=validateAppearance({companionEnabled:true,companionAvatar:'custom',companionDesign:design,companionArtwork:artwork},{}),changed=validateAppearance({theme:'paper'},saved);
 assert.deepEqual(changed.companionDesign,design);assert.deepEqual(changed.companionArtwork,artwork);assert.equal(changed.companionAvatar,'custom');assert.equal(validateAppearance({companionAvatar:'artwork'},changed).companionAvatar,'artwork');
 assert.equal(normalizeAppearance({companionAvatar:'artwork'}).companionAvatar,'fox');assert.equal(normalizeAppearance().companionArtwork,null);
});

test('custom schema rejects unknown versions, executable colors, arbitrary paths and malformed sprite grids',()=>{
 for(const design of [{...DEFAULT_COMPANION_DESIGN,version:2},{...DEFAULT_COMPANION_DESIGN,eyes:'<svg onload=alert(1)>'},{...DEFAULT_COMPANION_DESIGN,coat:'url(https://bad)'},{...DEFAULT_COMPANION_DESIGN,extra:'unexpected'}])assert.throws(()=>validateAppearance({companionDesign:design},{}),/Invalid appearance/);
 for(const artwork of [{id:'../secret',width:1,height:1,frames:1,rows:1,fps:6},{id:'a'.repeat(64),width:100,height:100,frames:3,rows:3,fps:6},{id:'a'.repeat(64),width:100,height:100,frames:1,rows:1,fps:99}]){assert.equal(normalizeCompanionArtwork(artwork),null);assert.throws(()=>validateAppearance({companionArtwork:artwork},{}),/Invalid appearance/);}
 assert.deepEqual(normalizeCompanionDesign({}),DEFAULT_COMPANION_DESIGN);
});

test('raster import decodes then reencodes into the protected asset store and returns only safe metadata',async()=>{
 const f=fixture(),artwork=await importCompanionArtwork(input(),f);assert.deepEqual(artwork,{id:'a'.repeat(64),width:1,height:1,frames:1,rows:1,fps:6});assert.deepEqual(f.calls,{decode:1,put:1});assert.equal(JSON.stringify(artwork).includes(PNG),false);
});

test('unsafe MIME, SVG renamed as PNG, malformed bytes and invalid sprite settings never decode or persist',async()=>{
 const f=fixture();for(const bad of [input({mimeType:'image/svg+xml'}),input({dataBase64:Buffer.from('<svg><script/></svg>').toString('base64')}),input({dataBase64:'https://bad/image.png'}),input({dataBase64:Buffer.from(PNG,'base64').subarray(0,40).toString('base64')}),input({frames:2}),input({rows:3}),input({fps:13}),input({dataBase64:'A'.repeat(6*1024*1024)})])await assert.rejects(importCompanionArtwork(bad,f));
 assert.deepEqual(f.calls,{decode:0,put:0});
});

test('header pixel limits apply before native decoding',async()=>{
 const f=fixture(),bytes=Buffer.from(PNG,'base64');bytes.writeUInt32BE(4096,16);await assert.rejects(importCompanionArtwork(input({dataBase64:bytes.toString('base64')}),f),/2048/);assert.deepEqual(f.calls,{decode:0,put:0});
});

test('animated PNG is rejected explicitly and cannot be silently converted to a still',async()=>{
 const f=fixture(),bytes=Buffer.from(PNG,'base64'),animation=Buffer.alloc(20);animation.writeUInt32BE(8);animation.write('acTL',4);animation.writeUInt32BE(2,8);const apng=Buffer.concat([bytes.subarray(0,33),animation,bytes.subarray(33)]);
 await assert.rejects(importCompanionArtwork(input({dataBase64:apng.toString('base64')}),f),/Animated PNG/);assert.deepEqual(f.calls,{decode:0,put:0});
});

test('empty or mismatched native decoding fails without publishing an asset',async()=>{
 const f=fixture();f.nativeImage.createFromBuffer=()=>({isEmpty:()=>true});await assert.rejects(importCompanionArtwork(input(),f),/decoded/);f.nativeImage.createFromBuffer=()=>({isEmpty:()=>false,getSize:()=>({width:2,height:2})});await assert.rejects(importCompanionArtwork(input(),f),/dimensions/);assert.equal(f.calls.put,0);
});

test('malformed JPEG and WebP headers report clear errors before decoding',async()=>{
 const f=fixture();for(const [mimeType,bytes]of [['image/jpeg',Buffer.from([255,216,255,255,255,217])],['image/webp',Buffer.from('RIFF\x12\0\0\0WEBPVP8L\x05\0\0\0\x2f')]]){
  await assert.rejects(importCompanionArtwork(input({mimeType,dataBase64:bytes.toString('base64')}),f),error=>!(error instanceof RangeError)&&!/out of range|offset/i.test(error.message));
 }assert.deepEqual(f.calls,{decode:0,put:0});
});

test('artwork cache shares one pending raster read, replaces its single entry and retries rejected reads',async()=>{
 let calls=0,resolve;const cache=createCompanionArtworkCache(async()=>{calls++;return new Promise(done=>{resolve=done;});}),a='a'.repeat(64),b='b'.repeat(64),first=cache.load(a),same=cache.load(a);assert.equal(first,same);await new Promise(done=>setImmediate(done));assert.equal(calls,1);resolve({mimeType:'image/png',dataBase64:PNG});assert.equal(await first,'data:image/png;base64,'+PNG);assert.equal(await cache.load(a),await first);cache.clear();const second=cache.load(b);await new Promise(done=>setImmediate(done));assert.equal(calls,2);resolve({mimeType:'image/png',dataBase64:PNG});await second;
 let attempts=0;const retry=createCompanionArtworkCache(async()=>{attempts++;if(attempts===1)throw Error('Temporary read denial');return {mimeType:'image/png',dataBase64:PNG};});await assert.rejects(retry.load(a),/Temporary/);assert.ok((await retry.load(a)).startsWith('data:image/png;'));assert.equal(attempts,2);await assert.rejects(retry.load('../secret'),/Invalid/);
});
