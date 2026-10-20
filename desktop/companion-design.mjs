export const COMPANION_PARTS={body:['round','plush','robot','cloud','droplet'],ears:['none','round','pointed','long','antenna'],eyes:['round','sleepy','visor','cyclops'],tail:['none','curl','flame','fin'],accessory:['none','scarf','crown','headphones','wings']};
export const DEFAULT_COMPANION_DESIGN={version:1,body:'round',ears:'antenna',eyes:'round',tail:'curl',accessory:'scarf',coat:'#91b8ae',accent:'#e8b57c',ink:'#273b40'};
const hex=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/.test(value);
export function normalizeCompanionDesign(value={}){const input=value&&typeof value==='object'?value:{},result={version:1};for(const [key,options]of Object.entries(COMPANION_PARTS))result[key]=options.includes(input[key])?input[key]:DEFAULT_COMPANION_DESIGN[key];for(const key of ['coat','accent','ink'])result[key]=hex(input[key])?input[key]:DEFAULT_COMPANION_DESIGN[key];return result;}
export function normalizeCompanionArtwork(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id))return null;
 const {width,height,frames,rows,fps}=value;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>2048||height>2048||!Number.isInteger(frames)||frames<1||frames>16||![1,3].includes(rows)||!Number.isInteger(fps)||fps<1||fps>12||width%frames||height%rows)return null;
 return {id:value.id,width,height,frames,rows,fps};
}
