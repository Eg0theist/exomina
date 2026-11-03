// Shared by the host and renderer. Turning a feature off always removes its
// tools from discovery AND refuses stale calls made by an already running AI.
export const FEATURES = Object.freeze([
  {id:'files',name:'Workspace files',description:'Read and edit files in the chosen folder.',pattern:/^workspace_/},
  {id:'terminal',name:'Commands & terminals',description:'Run commands and interactive terminals.',pattern:/^terminal_/},
  {id:'browser',name:'Websites',description:'Use the shared browser.',pattern:/^browser_/,setting:'browserEnabled'},
  {id:'desktop',name:'Computer control',description:'Read the screen and use other apps.',pattern:/^(desktop_|external_cua_)/,setting:'desktopEnabled'},
  {id:'analysis',name:'App analysis',description:'Inspect source and executables with static analysis and Ghidra.',pattern:/^(analysis_|ghidra_)/},
  {id:'images',name:'Images',description:'Create or view images through a connected AI.',pattern:/^image_/},
  {id:'audio',name:'Audio inspection',description:'Measure a local WAV file without uploading it.',pattern:/^audio_inspect$/},
  {id:'helpers',name:'AI reviews',description:'Ask another connected AI for a second opinion.',pattern:/^model_/},
  {id:'cloud',name:'Cloud coding tasks',description:'Use connected cloud coding environments.',pattern:/^codex_cloud_/},
  {id:'github',name:'GitHub',description:'Work with repositories through the GitHub connection.',pattern:/^github_/},
  {id:'extensions',name:'Extensions & services',description:'Use installed local tools and online services.',pattern:/^(extension_|external_(?!cua_))/},
  {id:'skills',name:'Shared skills',description:'Read and maintain reusable procedures.',pattern:/^skill_library$/},
  {id:'workers',name:'Isolated workers',description:'Run approved commands in Docker or on an SSH worker.',pattern:/^worker_run$/},
  {id:'pipelines',name:'Tool pipelines',description:'Combine supported read operations.',pattern:/^tool_pipeline$/},
  {id:'refinement',name:'Approach learning',description:'Compare evidence and keep useful working methods.',pattern:/^task_refine$/},
]);
export function featureFor(name){return FEATURES.find(feature=>feature.pattern.test(name));}
export function featureDisabled(name,settings={}){
  if(name==='humanizer')return true;
  const feature=featureFor(name);
  return !!feature&&(settings.disabledFeatures||[]).includes(feature.id)||(settings.disabledTools||[]).includes(name)===true;
}
export function toolEnabled(name,settings={}){
  if(featureDisabled(name,settings))return false;
  const feature=featureFor(name);
  if(feature?.setting&&settings[feature.setting]!==true)return false;
  if(/^(memory_|archive_)/.test(name)&&settings.memoryEnabled===false)return false;
  return true;
}
export function assertFeature(name,settings){if(featureDisabled(name,settings))throw Error(`${featureFor(name)?.name||'This tool'} is turned off in Tools. No new action was started.`);}
export function normalizeDisabledFeatures(value){
  if(!Array.isArray(value)||value.length>FEATURES.length||value.some(id=>!FEATURES.some(feature=>feature.id===id)))throw Error('Choose valid features to turn off.');
  return [...new Set(value)];
}
export function normalizeDisabledTools(value){
  if(!Array.isArray(value)||value.length>1000||value.some(name=>typeof name!=='string'||!FEATURES.some(feature=>feature.pattern.test(name))||!/^[a-zA-Z0-9_-]{1,160}$/.test(name)))throw Error('Choose valid optional tools to turn off.');
  return [...new Set(value)];
}
export function featureView(settings={},tools=[]){return FEATURES.map(({id,name,description,setting})=>({id,name,description,enabled:!(settings.disabledFeatures||[]).includes(id),accessEnabled:setting?settings[setting]===true:true,tools:tools.filter(tool=>featureFor(tool.name)?.id===id).length}));}
