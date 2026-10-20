import {mkdir,lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathsEqual} from './path-policy.mjs';

export const MAX_ASSET_BYTES=20*1024*1024;
const ID=/^[a-f0-9]{64}$/;
const MIME=new Set(['image/png','image/jpeg','image/webp','video/mp4']);
// The immutable destination is shared by duplicate generations. Serialize its
// publication across store instances so Windows never replaces a file that a
// concurrent deduplication read has open.
const publications=new Map();
async function publishOnce(key,operation){const previous=publications.get(key)||Promise.resolve(),current=previous.catch(()=>{}).then(operation);publications.set(key,current);try{return await current;}finally{if(publications.get(key)===current)publications.delete(key);}}
const metadata=row=>({id:row.id,mimeType:row.mimeType,bytes:row.bytes,sha256:row.sha256});
const safeId=id=>{if(typeof id!=='string'||!ID.test(id))throw Error('Invalid image asset ID.');return id;};
function bytesOf(value){
  if(typeof value==='string'){
    if(!value.length||value.length>Math.ceil(MAX_ASSET_BYTES/3)*4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Image data must be canonical base64 within the 20 MiB limit.');
    const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw Error('Image data must be canonical base64.');return bytes;
  }
  if(!Buffer.isBuffer(value)&&!(value instanceof Uint8Array))throw Error('Image data must be a byte buffer or base64 string.');
  if(value.byteLength>MAX_ASSET_BYTES)throw Error('Image exceeds the 20 MiB limit.');return Buffer.from(value);
}
function dimensions(width,height){if(!width||!height||width>32768||height>32768||width*height>100000000)throw Error('Image dimensions exceed the supported limit.');}
/** Validate image container headers. This does not execute SVG or decode untrusted pixels. */
function identify(bytes){
  if(bytes.length>=24&&bytes.toString('ascii',4,8)==='ftyp'){
    let offset=0,brand=false,movie=false,media=false;
    while(offset+8<=bytes.length){let size=bytes.readUInt32BE(offset),header=8;const type=bytes.toString('ascii',offset+4,offset+8);if(size===1){if(offset+16>bytes.length)throw Error('Truncated MP4 box.');const large=bytes.readBigUInt64BE(offset+8);if(large>BigInt(bytes.length))throw Error('Truncated MP4 box.');size=Number(large);header=16;}else if(size===0)size=bytes.length-offset;if(size<header||size>bytes.length-offset)throw Error('Truncated MP4 video.');if(type==='ftyp'){if(size<16)throw Error('Malformed MP4 header.');brand=true;}if(type==='moov')movie=true;if(type==='mdat'&&size>header)media=true;offset+=size;}
    if(offset!==bytes.length||!brand||!movie||!media)throw Error('Incomplete MP4 video.');return 'video/mp4';
  }
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    if(bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw Error('Malformed PNG image header.');dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
    let offset=8,data=false,end=false;while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(length>bytes.length-offset-12)throw Error('Truncated PNG image.');if(type==='IDAT')data=true;offset+=length+12;if(type==='IEND'){if(length||offset!==bytes.length)throw Error('Malformed PNG image ending.');end=true;break;}}
    if(!data||!end)throw Error('Incomplete PNG image.');return 'image/png';
  }
  if(bytes.length>=12&&bytes.readUInt16BE(0)===0xffd8){
    if(bytes.readUInt16BE(bytes.length-2)!==0xffd9)throw Error('Truncated JPEG image.');let offset=2,frame=false,scan=false;
    while(offset<bytes.length-2){if(bytes[offset++]!==255)throw Error('Malformed JPEG header.');while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===0xd9)break;if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;if(offset+2>bytes.length)throw Error('Truncated JPEG header.');const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)throw Error('Truncated JPEG segment.');if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8)throw Error('Malformed JPEG frame.');dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));frame=true;}if(marker===0xda){scan=true;break;}offset+=length;}
    if(!frame||!scan)throw Error('JPEG image has no frame or scan.');return 'image/jpeg';
  }
  if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    if(bytes.readUInt32LE(4)!==bytes.length-8)throw Error('Truncated WebP image.');let offset=12,image=false;
    while(offset+8<=bytes.length){const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;if(length>bytes.length-start)throw Error('Truncated WebP chunk.');if(type==='VP8 '){if(length<10||!bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42])))throw Error('Malformed WebP frame.');dimensions(bytes.readUInt16LE(start+6)&16383,bytes.readUInt16LE(start+8)&16383);image=true;}else if(type==='VP8L'){if(length<5||bytes[start]!==47)throw Error('Malformed WebP lossless frame.');const bits=bytes.readUInt32LE(start+1);dimensions((bits&16383)+1,((bits>>>14)&16383)+1);image=true;}else if(type==='VP8X'){if(length!==10)throw Error('Malformed WebP extended header.');dimensions(bytes.readUIntLE(start+4,3)+1,bytes.readUIntLE(start+7,3)+1);}offset=start+length+(length%2);}
    if(!image||offset!==bytes.length)throw Error('Unsupported or incomplete WebP image.');return 'image/webp';
  }
  throw Error('Only PNG, JPEG and WebP images or MP4 videos are supported.');
}
export function validateImageAsset(value,{mimeType,id,sha256,bytes:expectedBytes}={}){
  const bytes=bytesOf(value);if(!bytes.length||bytes.length>MAX_ASSET_BYTES)throw Error('Image must contain between 1 byte and 20 MiB of data.');
  const actualMime=identify(bytes);if(mimeType!==undefined&&(!MIME.has(mimeType)||mimeType!==actualMime))throw Error('Image format does not match its MIME type.');
  const hash=createHash('sha256').update(bytes).digest('hex');if(id!==undefined&&safeId(id)!==hash)throw Error('Image asset ID does not match its content.');if(sha256!==undefined&&sha256!==hash)throw Error('Image checksum does not match its content.');if(expectedBytes!==undefined&&expectedBytes!==bytes.length)throw Error('Image byte count does not match its content.');
  return {metadata:{id:hash,mimeType:actualMime,bytes:bytes.length,sha256:hash},buffer:bytes};
}

/** Caller must initialize the existing EFS/encrypted-volume vault before opening
 * this store. Temporary files and SQLite journals stay under that protected root. */
export class AssetStore {
  constructor(dataDir){this.root=path.resolve(typeof dataDir==='object'?dataDir.dataDir:dataDir);this.dir=path.join(this.root,'assets');this.db=null;}
  async checkDir(){const stat=await lstat(this.dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('The image store must be a regular protected directory.');const resolved=await realpath(this.dir);if(!pathsEqual(resolved,this.dir))throw Error('The image store cannot use redirected directories.');}
  async init(){if(this.db)return;await mkdir(this.dir,{recursive:true,mode:0o700});await this.checkDir();const dbFile=path.join(this.dir,'index.sqlite');try{const s=await lstat(dbFile);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('The image index must be a regular file.');}catch(e){if(e.code!=='ENOENT')throw e;}
    this.db=new DatabaseSync(dbFile);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,mimeType TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL);');}
  async ready(){if(!this.db)await this.init();await this.checkDir();}
  file(id){return path.join(this.dir,safeId(id)+'.asset');}
  index(){if(!this.db)throw Error('Image store is not open.');return this.db.prepare('SELECT id,mimeType,bytes,sha256 FROM assets ORDER BY id').all().map(metadata);}
  async get(id){safeId(id);await this.ready();const row=this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);if(!row)return null;const file=this.file(id),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_ASSET_BYTES||stat.size!==row.bytes)throw Error('Stored image file is missing, redirected or invalid.');
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let raw;try{const current=await handle.stat();if(!current.isFile()||current.size!==stat.size||current.ino!==stat.ino||current.nlink!==1)throw Error('Stored image changed during read.');raw=Buffer.alloc(current.size);let offset=0;while(offset<raw.length){const {bytesRead}=await handle.read(raw,offset,raw.length-offset,offset);if(!bytesRead)throw Error('Stored image is truncated.');offset+=bytesRead;}}finally{await handle.close();}
    const checked=validateImageAsset(raw,row);return {...checked.metadata,dataBase64:raw.toString('base64')};}
  async put(value,options={}){const checked=validateImageAsset(value,options),key=this.file(checked.metadata.id);return publishOnce(process.platform==='win32'?key.toLowerCase():key,()=>this.writeAsset(checked));}
  async writeAsset(checked){await this.ready();const {id}=checked.metadata;if(this.db.prepare('SELECT 1 FROM assets WHERE id=?').get(id)){await this.get(id);return checked.metadata;}
    const file=this.file(id);try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Image target is redirected or invalid.');}catch(e){if(e.code!=='ENOENT')throw e;}
    const temp=path.join(this.dir,`${id}.${randomUUID()}.tmp`);let handle;try{handle=await open(temp,'wx',0o600);await handle.writeFile(checked.buffer);await handle.sync();await handle.close();handle=null;await rename(temp,file);this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?)').run(id,checked.metadata.mimeType,checked.metadata.bytes,checked.metadata.sha256);}finally{await handle?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return checked.metadata;}
  async export(id){return this.get(id);}
  async import(value){if(!value||typeof value!=='object')throw Error('Invalid image asset record.');return this.put(value.dataBase64,value);}
  async remove(id){safeId(id);await this.ready();const file=this.file(id);try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Image target is redirected or invalid.');await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}this.db.prepare('DELETE FROM assets WHERE id=?').run(id);}
  close(){this.db?.close();this.db=null;}
}
