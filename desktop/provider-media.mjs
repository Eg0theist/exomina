import {lstat,realpath,open,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateImageAsset,MAX_ASSET_BYTES} from './assets.mjs';
import {pathsEqual} from './path-policy.mjs';

export const GROK_MEDIA_TOOLS = ['image_gen','image_edit','image_to_video','reference_to_video'];
const aliases = new Map([['ImageGen','image_gen'],['ImageEdit','image_edit'],['ImageToVideo','image_to_video'],['ReferenceToVideo','reference_to_video']]);
export function grokMediaTool(call={}) {
  const name=call._meta?.toolName || call.title || '';
  return GROK_MEDIA_TOOLS.includes(name)?name:aliases.get(name);
}
const inside=(root,target)=>{const rel=path.relative(root,target);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
const inputWrites = new Map();

/** Imagine accepts local reference images even when ACP does not accept inline
 * image messages. Cache only the attached, validated pixels in the isolated
 * runtime, using content hashes rather than user/provider-supplied filenames. */
export async function stageProviderImages(images, root) {
  if (!Array.isArray(images) || images.length > 10) throw Error('Attach at most 10 images for Imagine.');
  root = path.resolve(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !pathsEqual(await realpath(root), root)) throw Error('Provider input folder is redirected.');
  const dir = path.join(root, 'imagine-inputs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !pathsEqual(await realpath(dir), dir)) throw Error('Provider input folder is redirected.');
  const checked = images.map(image => validateImageAsset(image.dataBase64, { mimeType: image.mimeType }));
  if (checked.some(value => !value.metadata.mimeType.startsWith('image/')) || checked.reduce((sum, value) => sum + value.buffer.length, 0) > MAX_ASSET_BYTES) throw Error('Imagine references must be PNG, JPEG or WebP images totaling at most 20 MiB.');
  const files = [];
  for (const value of checked) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[value.metadata.mimeType];
    const target = path.join(dir, `${value.metadata.sha256}.${extension}`);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!inputWrites.has(key)) {
      const task = (async () => {
        let handle;
        try {
          handle = await open(target, 'wx', 0o600);
          await handle.writeFile(value.buffer); await handle.sync();
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await handle?.close(); }
        const stored = await readProviderMedia(target, [dir]);
        if (stored.mimeType !== value.metadata.mimeType || stored.dataBase64 !== value.buffer.toString('base64')) throw Error('A cached Imagine reference failed its integrity check.');
      })();
      inputWrites.set(key, task);
      task.then(() => { if (inputWrites.get(key) === task) inputWrites.delete(key); }, () => { if (inputWrites.get(key) === task) inputWrites.delete(key); });
    }
    await inputWrites.get(key);
    files.push({ path: target, mimeType: value.metadata.mimeType });
  }
  return files;
}

/** Only a completed, approved native media call may reference local output.
 * Read regular files under isolated runtime/session directories, never remote
 * URLs or a provider-supplied account/config root. Revalidate every byte. */
export async function readProviderMedia(reference,roots) {
  if(typeof reference!=='string'||reference.length>4096||/[\x00-\x1f]/.test(reference))throw Error('Invalid provider media reference.');
  let target;
  if(reference.startsWith('file:')){const url=new URL(reference);if(url.host)throw Error('Remote media files are unsupported.');target=fileURLToPath(url);}
  else {if(/^[a-z][a-z0-9+.-]*:/i.test(reference)&&!path.isAbsolute(reference))throw Error('Remote media URLs are unsupported.');target=path.resolve(reference);}
  if(!/\.(png|jpe?g|webp|mp4)$/i.test(target))throw Error('Unsupported provider media format.');
  const root=roots.map(p=>path.resolve(p)).find(p=>inside(p,target));
  if(!root)throw Error('Provider media is outside its isolated output folder.');
  const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||!pathsEqual(await realpath(root),root))throw Error('Provider output folder is redirected.');
  let current=root;
  for(const part of path.relative(root,target).split(path.sep)){
    current=path.join(current,part);const stat=await lstat(current);
    if(stat.isSymbolicLink())throw Error('Provider media is redirected.');
  }
  const stat=await lstat(target);
  if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>MAX_ASSET_BYTES)throw Error('Provider media must be a regular file within the 20 MiB limit.');
  const resolved=await realpath(target);if(!inside(root,resolved))throw Error('Provider media is redirected.');
  const handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const check=await handle.stat();if(check.ino!==stat.ino||check.size!==stat.size||check.nlink!==1||!check.isFile())throw Error('Provider media changed during read.');
    const bytes=Buffer.alloc(check.size);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('Provider media is incomplete.');offset+=bytesRead;}
    const checked=validateImageAsset(bytes);return {mimeType:checked.metadata.mimeType,dataBase64:bytes.toString('base64')};
  }finally{await handle.close();}
}

export function inlineProviderMedia(content){
  if(!['image','resource'].includes(content?.type))return null;
  const value=content.type==='resource'?content.resource:content;
  if(!['image/png','image/jpeg','image/webp','video/mp4'].includes(value?.mimeType))return null;
  const data=value?.data??value?.blob;
  if(typeof data!=='string')return null;
  const checked=validateImageAsset(data,{mimeType:value.mimeType});
  return {mimeType:checked.metadata.mimeType,dataBase64:checked.buffer.toString('base64')};
}

/** ACP standard content plus Grok Build's MediaGenOutput (files,
 * absolute_root_path, session_folder, uploaded_url). Never fetch uploaded_url. */
export function grokOutputFiles(update){
  const output=update.rawOutput?.content??update.rawOutput;
  const refs=[];
  for(const part of update.content||[]){const block=part.content??part;if(['resource_link','resource','image'].includes(block.type)&&block.uri)refs.push(block.uri);if(block.resource?.uri&&!block.resource.blob)refs.push(block.resource.uri);}
  const base=output?.absolute_root_path;
  for(const file of Array.isArray(output?.files)?output.files:[]){
    const name=typeof file==='string'?file:file?.path;
    if(typeof name==='string')refs.push(base&&!path.isAbsolute(name)&&!name.startsWith('file:')?path.resolve(base,output.session_folder||'',name):name);
  }
  return [...new Set(refs)].slice(0,20);
}
