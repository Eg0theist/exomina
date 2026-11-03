import {THEMES,PALETTE_ANCHORS,validateAppearance} from './themes.mjs';
import {normalizeSounds,SOUND_PRESETS,SOUND_EVENTS} from './sound-settings.mjs';

export const APP_DESTINATIONS=['chat','connections','tools','memory','settings:general','settings:appearance','settings:sounds','settings:personalization','settings:usage','settings:permissions','settings:memory','settings:data','settings:phone','settings:updates','settings:skills','settings:workers'];
const appearanceKeys=['theme','lightTheme','darkTheme','readingFont','textSize','uiScale','chatWidth','glow','motion','textColor','customPalette','companionEnabled','companionAvatar','companionColor','companionLabel','companionAnimate','companionExpressive'];
const paletteSchema={anyOf:[{type:'null',description:'Reset to the selected base theme.'},{type:'object',additionalProperties:false,required:['baseTheme','colors'],properties:{baseTheme:{type:'string',enum:THEMES.map(theme=>theme.id),description:'Must match appearance.theme, which cannot be system. Changing the base theme clears the previous custom palette.'},colors:{type:'object',additionalProperties:false,minProperties:1,properties:Object.fromEntries(PALETTE_ANCHORS.map(key=>[key,{type:'string',pattern:'^#[0-9a-f]{6}$'}])),description:'Override only known colour anchors; other anchors stay with the base theme. Mixed text and button contrast checks must pass, including the current textColor override. No CSS, scripts or URLs.'}}}]};
const settingBooleans=['quickAccess','closeToTray','promptSuggestions','attentionNotifications','autoTitle'];
const object=(value,label)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error(`Use an object for ${label}.`);return value;};
const only=(value,keys,label)=>{object(value,label);for(const key of Object.keys(value))if(!keys.includes(key))throw Error(`Unsupported ${label} field: ${key}.`);return value;};
const text=(value,max,label,{empty=false}={})=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw Error(`Use ${empty?'up to':'1 to'} ${max} characters for ${label}.`);return value.trim();};
const identity=value=>value===undefined?undefined:text(value,100,'record ID');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export const APP_CONTROL_OPERATIONS=[
  {id:'settings.patch',label:'Change appearance or notifications',description:'Apply a validated theme, custom colour palette, reading size, companion appearance, sound or simple app preference immediately. No restart.',fields:{appearance:appearanceKeys,sounds:['enabled','volume','onlyWhenAway','events'],...Object.fromEntries(settingBooleans.map(key=>[key,'boolean']))},appearanceValues:{customPalette:paletteSchema},restartRequired:false},
  {id:'prompt.save',label:'Create or update a reusable prompt',description:'Save a named slash shortcut and prompt text. Saving does not send the prompt or run an AI.',fields:{id:'existing ID for updates; omit to create',name:'1–80 characters',shortcut:'lowercase letters, digits, hyphens or underscores; starts with a letter',text:'1–100000 characters'},restartRequired:false},
  {id:'project.save',label:'Create or update a project',description:'Save a project name and instructions. Existing folder and file access are preserved. Does not grant new file access or change existing chat assignment.',fields:{id:'existing ID for updates; omit to create',name:'1–80 characters',instructions:'0–30000 characters'},restartRequired:false},
  {id:'navigate',label:'Show a page or settings section',description:'Open a known destination in the originating chat’s active desktop window, preserving drafts. Conflicting navigation or a different active chat cancels the request.',fields:{destination:APP_DESTINATIONS},restartRequired:false},
];

export function prepareAppOperation(operation,input,state){
  if(!APP_CONTROL_OPERATIONS.some(item=>item.id===operation))throw Error('Choose an operation from the app_control catalog.');
  const settings=state.settings||{};
  if(operation==='settings.patch'){
    only(input,['appearance','sounds',...settingBooleans],'settings');
    if(!Object.keys(input).length)throw Error('Choose at least one setting to change.');
    const patch={},before={},after={};
    if(input.appearance!==undefined){
      only(input.appearance,appearanceKeys,'appearance');
      if(!Object.keys(input.appearance).length)throw Error('Choose an appearance field.');
      const current=validateAppearance({},settings.appearance),next=validateAppearance(input.appearance,current);
      if(input.appearance.theme==='system'||THEMES.some(theme=>theme.id===next.theme)){
        const observedKeys=[...Object.keys(input.appearance),...('theme'in input.appearance&&'customPalette'in current?['customPalette']:[])];patch.appearance={...input.appearance};before.appearance=Object.fromEntries(observedKeys.map(key=>[key,current[key]]));after.appearance=Object.fromEntries(observedKeys.map(key=>[key,next[key]]));
      }
    }
    if(input.sounds!==undefined){
      only(input.sounds,['enabled','volume','onlyWhenAway','events'],'sounds');
      if(!Object.keys(input.sounds).length)throw Error('Choose a sound field.');
      for(const key of ['enabled','onlyWhenAway'])if(key in input.sounds&&typeof input.sounds[key]!=='boolean')throw Error(`Use a boolean for sounds.${key}.`);
      if('volume'in input.sounds&&(!Number.isFinite(input.sounds.volume)||input.sounds.volume<0||input.sounds.volume>1))throw Error('Use a sound volume from 0 to 1.');
      if('events'in input.sounds){only(input.sounds.events,SOUND_EVENTS.map(item=>item.id),'sound event');for(const value of Object.values(input.sounds.events))if(!SOUND_PRESETS.some(item=>item.id===value))throw Error('Choose an installed sound preset.');}
      const current=normalizeSounds(settings.sounds),next=normalizeSounds({...current,...input.sounds,events:{...current.events,...input.sounds.events}});
      patch.sounds=next;before.sounds=current;after.sounds=next;
    }
    for(const key of settingBooleans)if(key in input){if(typeof input[key]!=='boolean')throw Error(`Use a boolean for ${key}.`);patch[key]=input[key];before[key]=settings[key]??null;after[key]=input[key];}
    return {operation,section:'settings',resource:'settings',method:'settings.save',payload:patch,before,after,noChange:equal(before,after)};
  }
  if(operation==='navigate'){
    only(input,['destination'],'navigation');
    if(!APP_DESTINATIONS.includes(input.destination))throw Error('Choose a destination from the app_control catalog.');
    return {operation,section:'navigation',resource:'navigation',payload:{destination:input.destination},before:null,after:{destination:input.destination},noChange:false};
  }
  const project=operation==='project.save',collection=project?'projects':'prompts',keys=project?['id','name','instructions']:['id','name','shortcut','text'];
  only(input,keys,project?'project':'prompt');
  const id=identity(input.id),previous=id?(state[collection]||[]).find(item=>item.id===id):null;
  if(id&&!previous)throw Error(`This ${project?'project':'prompt'} no longer exists. Read app_inspect first.`);
  const payload={...(id?{id}:{}),name:text(input.name,80,'name')};
  if(project)payload.instructions=text(input.instructions,30000,'project instructions',{empty:true});
  else{
    payload.shortcut=text(input.shortcut,31,'shortcut').toLowerCase().replace(/^\//,'');
    if(!/^[a-z][a-z0-9_-]{0,29}$/.test(payload.shortcut))throw Error('Use a slash shortcut such as /rewrite.');
    if((state.prompts||[]).some(item=>item.shortcut===payload.shortcut&&item.id!==id))throw Error('That shortcut is already in use.');
    payload.text=text(input.text,100000,'prompt');
  }
  const before=previous?Object.fromEntries(keys.filter(key=>key in previous).map(key=>[key,previous[key]])):null;
  return {operation,section:collection,resource:project?`project:${id||'new'}`:`prompt:${id||payload.shortcut}`,method:project?'projects.save':'prompts.save',payload,before,after:payload,noChange:equal(before,payload)};
}
