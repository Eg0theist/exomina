/** One shared raster URL, including a shared in-flight read. Never caches remote URLs. */
export function createCompanionArtworkCache(read){
 let entry=null;
 return {load(id){
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return Promise.reject(Error('Invalid companion artwork.'));
  if(entry?.id===id)return entry.promise;
  const next={id,promise:null};entry=next;
  next.promise=Promise.resolve().then(()=>read(id)).then(asset=>{
   if(!asset||asset.mimeType!=='image/png'||typeof asset.dataBase64!=='string'||asset.dataBase64.length>Math.ceil(20*1024*1024/3)*4)throw Error('Companion artwork is unavailable.');
   return 'data:image/png;base64,'+asset.dataBase64;
  }).catch(error=>{if(entry===next)entry=null;throw error;});return next.promise;
 },clear(){entry=null;}};
}
