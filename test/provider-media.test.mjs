import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,link,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {AssetStore,validateImageAsset} from '../desktop/assets.mjs';
import {readProviderMedia,inlineProviderMedia,grokOutputFiles,grokMediaTool,stageProviderImages} from '../desktop/provider-media.mjs';
import {mediaAttachment,mediaBlob,mergeChatAsset,imageFilename} from '../src/image-assets.js';
import {ImageSupport} from '../desktop/image-support.mjs';
import {cleanAttachment} from '../desktop/data-export.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=','base64');
const box=(name,data=Buffer.alloc(0))=>{const out=Buffer.alloc(data.length+8);out.writeUInt32BE(out.length);out.write(name,4);data.copy(out,8);return out;};
// Container fixture only. Playback is verified separately with a real video.
const mp4=Buffer.concat([box('ftyp',Buffer.from('isom0000isom')),box('moov'),box('mdat',Buffer.from('synthetic frame'))]);

test('Imagine attachment handoff deduplicates validated pixels and refuses redirected or tampered cache files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imagine-input-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const image = { mimeType: 'image/png', dataBase64: png.toString('base64'), name: '../../private.png' };
  const [first, second] = await Promise.all([stageProviderImages([image], root), stageProviderImages([image], root)]);
  assert.deepEqual(first, second);
  assert.ok(first[0].path.startsWith(path.join(root, 'imagine-inputs') + path.sep));
  assert.equal((await readProviderMedia(first[0].path, [root])).dataBase64, image.dataBase64);
  await writeFile(first[0].path, Buffer.from('tampered cache'));
  await assert.rejects(stageProviderImages([image], root), /supported|integrity/);
  const redirected = path.join(root, 'redirected-root');
  await symlink(root, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageProviderImages([image], redirected), /redirected/);
  await assert.rejects(stageProviderImages(Array(11).fill(image), root), /at most 10/);
});

test('provider media never reads remote, account, redirected, hard-linked or oversized files',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'provider-media-'));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'output');await mkdir(output);
 const file=path.join(output,'image.png');await writeFile(file,png);assert.equal((await readProviderMedia(file,[output])).dataBase64,png.toString('base64'));
 const secret=path.join(root,'private.png');await writeFile(secret,png);await assert.rejects(readProviderMedia(secret,[output]),/outside/);await assert.rejects(readProviderMedia('https://example.com/image.png',[output]),/Remote/);await assert.rejects(readProviderMedia('file://server/image.png',[output]),/Remote/);
 const hard=path.join(output,'hard.png');await link(secret,hard);await assert.rejects(readProviderMedia(hard,[output]),/regular file/);
 const redirect=path.join(output,'redirect');await symlink(root,redirect,process.platform==='win32'?'junction':'dir');await assert.rejects(readProviderMedia(path.join(redirect,'private.png'),[output]),/redirected/);
 await assert.rejects(readProviderMedia(path.join(output,'auth.json'),[output]),/format/);
 const large=path.join(output,'large.png');await writeFile(large,Buffer.alloc(20*1024*1024+1));await assert.rejects(readProviderMedia(large,[output]),/20 MiB/);
});

test('ACP inline content validates bytes and Grok media output ignores uploaded URLs',()=>{
 assert.equal(inlineProviderMedia({type:'image',mimeType:'image/png',data:png.toString('base64')}).mimeType,'image/png');
 assert.equal(inlineProviderMedia({type:'resource',resource:{mimeType:'video/mp4',blob:mp4.toString('base64')}}).mimeType,'video/mp4');
 assert.equal(inlineProviderMedia({type:'text',text:'not media'}),null);
 assert.equal(inlineProviderMedia({type:'resource',resource:{mimeType:'application/pdf',blob:'not image data'}}),null);
 assert.throws(()=>inlineProviderMedia({type:'image',mimeType:'image/png',data:'invalid'}));
 const root=path.resolve('synthetic-output');assert.deepEqual(grokOutputFiles({rawOutput:{files:['video.mp4'],absolute_root_path:root,session_folder:'session',uploaded_url:'https://example.com/ignored'}}),[path.join(root,'session','video.mp4')]);
 assert.equal(grokMediaTool({title:'ImageToVideo'}),'image_to_video');assert.equal(grokMediaTool({title:'Bash'}),undefined);
});

test('MP4 survives storage, reopen, export, chat metadata merge and verified renderer blobs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'media-assets-'));let store=new AssetStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const meta=await store.put(mp4,{mimeType:'video/mp4'}),attachment={...meta,kind:'video'};store.close();store=new AssetStore(dir);
 const data=await store.get(meta.id);assert.deepEqual(Buffer.from(data.dataBase64,'base64'),mp4);assert.equal((await mediaBlob(data,attachment)).type,'video/mp4');assert.equal(cleanAttachment(attachment).kind,'video');assert.equal(mediaAttachment(attachment).kind,'video');
 assert.equal(imageFilename('../generated.mp4','video/mp4'),'generated.mp4');
 const chat=mergeChatAsset([{id:'c',messages:[{role:'assistant',content:'Video ready'}]}],{conversationId:'c',attachment});assert.equal(chat[0].messages[0].content,'Video ready');assert.equal(chat[0].messages[0].attachments[0].kind,'video');
 await assert.rejects(mediaBlob({...data,dataBase64:Buffer.from(mp4.map((b,i)=>i===30?b^1:b)).toString('base64')},attachment),/integrity/);
 assert.throws(()=>validateImageAsset(mp4.subarray(0,mp4.length-1),{mimeType:'video/mp4'}),/Truncated/);
});

test('video publication stores metadata and cannot be read through the image tool',async()=>{
 const meta={id:createHash('sha256').update(mp4).digest('hex'),mimeType:'video/mp4',bytes:mp4.length,sha256:createHash('sha256').update(mp4).digest('hex')},published=[];
 const host=new ImageSupport({assets:{put:async()=>meta,get:async()=>({...meta,dataBase64:mp4.toString('base64')})},getRun:()=>({}),publish:async(_id,a)=>published.push(a),canReadAsset:()=>true});
 assert.equal(host.handle({type:'chat.media.generated',conversationId:'c',mimeType:'video/mp4',dataBase64:mp4.toString('base64')}),true);await host.finish('c');assert.equal(published[0].kind,'video');assert.equal(published[0].dataBase64,undefined);await assert.rejects(host.call('image_read',{id:meta.id},'c'),/images only/);
});
