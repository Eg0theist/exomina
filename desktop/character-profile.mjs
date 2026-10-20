import {normalizeAppearance} from './themes.mjs';
import {normalizeVoice} from './voice-settings.mjs';
/** Portable declarative profile. No executable hooks, network URLs or keys. */
export function characterProfile(value){
 if(value?.format!=='exomina-character'||value.version!==1||typeof value.name!=='string'||!value.name.trim()||value.name.length>40||typeof value.essence!=='string'||value.essence.length>1200)throw Error('Choose an Exomina character profile with a name and character description.');
 if(Object.keys(value).some(k=>!['format','version','name','essence','appearance','voice'].includes(k)))throw Error('Character profiles cannot include executable extensions, account keys or provider settings.');
 const look=normalizeAppearance(value.appearance||{}),voice=normalizeVoice(value.voice||{});
 if(look.companionAvatar==='artwork')throw Error('Move custom artwork through a library backup, or import the image separately on this device.');
 const appearance=Object.fromEntries(Object.entries(look).filter(([k])=>k.startsWith('companion')&&k!=='companionArtwork'));
 return {format:'exomina-character',version:1,name:value.name.trim(),essence:value.essence,appearance,voice};
}
