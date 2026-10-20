import {validateImageAsset} from './assets.mjs';
import {normalizeCompanionArtwork} from './companion-design.mjs';

export const MAX_COMPANION_IMPORT_BYTES=4*1024*1024;
function size(bytes,mime){
 if(mime==='image/png')return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(mime==='image/jpeg'){
  let offset=2;while(offset<bytes.length-2){if(bytes[offset++]!==255)break;while(offset<bytes.length&&bytes[offset]===255)offset++;if(offset>=bytes.length)throw Error('Malformed JPEG header.');const marker=bytes[offset++];if(marker===1||marker>=208&&marker<=215)continue;if(offset+2>bytes.length)throw Error('Truncated JPEG header.');const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)throw Error('Truncated JPEG header.');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)throw Error('Malformed JPEG frame.');return {width:bytes.readUInt16BE(offset+5),height:bytes.readUInt16BE(offset+3)};}offset+=length;}
 }
 if(mime==='image/webp'){
  let offset=12;while(offset+8<=bytes.length){const kind=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;
   if(length>bytes.length-start)throw Error('Truncated WebP header.');
   if((kind==='VP8X'||kind==='VP8 ')&&length<10||kind==='VP8L'&&length<5)throw Error('Malformed WebP frame.');
   if(kind==='VP8X')return {width:bytes.readUIntLE(start+4,3)+1,height:bytes.readUIntLE(start+7,3)+1};
   if(kind==='VP8 ')return {width:bytes.readUInt16LE(start+6)&16383,height:bytes.readUInt16LE(start+8)&16383};
   if(kind==='VP8L'){const bits=bytes.readUInt32LE(start+1);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}offset=start+length+(length%2);
  }
 }
 throw Error('This artwork does not contain a supported raster image.');
}
export async function importCompanionArtwork(input,{assets,nativeImage}){
 if(!input||!['image/png','image/jpeg','image/webp'].includes(input.mimeType)||typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(MAX_COMPANION_IMPORT_BYTES/3)*4)throw Error('Choose a PNG, JPEG or WebP image up to 4 MiB. For animation, use a PNG sprite sheet.');
 let checked,dimensions;try{checked=validateImageAsset(input.dataBase64,{mimeType:input.mimeType});dimensions=size(checked.buffer,input.mimeType);}catch(error){if(error instanceof RangeError)throw Error('This artwork has a malformed or truncated image header.');throw error;}
 if(checked.buffer.length>MAX_COMPANION_IMPORT_BYTES)throw Error('Companion artwork can be at most 4 MiB.');
 if(input.mimeType==='image/png'){for(let offset=8;offset+12<=checked.buffer.length;){const length=checked.buffer.readUInt32BE(offset),kind=checked.buffer.toString('ascii',offset+4,offset+8);if(kind==='acTL')throw Error('Animated PNG files are not supported. Import a PNG sprite sheet instead.');offset+=length+12;}}
 if(input.mimeType==='image/webp'){for(let offset=12;offset+8<=checked.buffer.length;){const length=checked.buffer.readUInt32LE(offset+4),kind=checked.buffer.toString('ascii',offset,offset+4);if(['ANIM','ANMF'].includes(kind))throw Error('Animated WebP files are not supported. Import a PNG sprite sheet instead.');offset+=8+length+length%2;}}
 const template=normalizeCompanionArtwork({id:'0'.repeat(64),...dimensions,frames:input.frames,rows:input.rows,fps:input.fps});
 if(!template)throw Error('Use artwork up to 2048 × 2048 pixels, 1–16 equal frames per row, 1 or 3 equal rows, and 1–12 frames per second.');
 const decoded=nativeImage.createFromBuffer(checked.buffer);if(decoded.isEmpty())throw Error('This image could not be decoded.');
 const actual=decoded.getSize();if(actual.width!==template.width||actual.height!==template.height)throw Error('The decoded image dimensions did not match its header.');
 // Re-encoding removes metadata and embedded secondary payloads. No SVG or remote address is accepted.
 const png=decoded.toPNG();if(!png.length||png.length>20*1024*1024)throw Error('The decoded artwork is too large.');
 const saved=await assets.put(png,{mimeType:'image/png'});return {...template,id:saved.id};
}
