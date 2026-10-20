// Visual arrangement only. Conversation, note and process state stay with their owners.
export const WORKFLOW_PANELS = Object.freeze(['browser', 'notes', 'terminal', 'workbench']);
export const WORKFLOW_PANEL_LABELS = Object.freeze({browser:'Browser',notes:'Notes',terminal:'Terminal',workbench:'Projects & prompts'});
export const WORKFLOW_STORAGE_KEY = 'exomina.workflowLayouts.v1';
const groups = ['right','bottom'];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clamp = (value,min,max,fallback) => Number.isFinite(value) ? Math.round(Math.max(min,Math.min(max,value))) : fallback;
export function createWorkflowLayout() {
  return {version:1,enabled:false,groups:{right:{panels:['browser','notes'],active:'browser'},bottom:{panels:['terminal','workbench'],active:'terminal'}},sizes:{right:420,bottom:300},floating:[]};
}
export function normalizeWorkflowLayout(value) {
  value=object(value);
  if(value.version!==1)return createWorkflowLayout();
  const result={version:1,enabled:value.enabled===true,groups:{},sizes:{right:clamp(value.sizes?.right,280,900,420),bottom:clamp(value.sizes?.bottom,180,700,300)},floating:[]};
  const seen=new Set();
  for(const name of groups){
    const input=object(value.groups?.[name]);
    const panels=(Array.isArray(input.panels)?input.panels:[]).filter(panel=>{
      if(!WORKFLOW_PANELS.includes(panel)||seen.has(panel))return false;
      seen.add(panel);return true;
    });
    result.groups[name]={panels,active:panels.includes(input.active)?input.active:panels[0]||null};
  }
  for(const item of (Array.isArray(value.floating)?value.floating:[]).slice(0,4)){
    const {panel}=object(item);if(!WORKFLOW_PANELS.includes(panel)||seen.has(panel))continue;
    seen.add(panel);const bounds=object(item.bounds);
    result.floating.push({panel,bounds:{x:clamp(bounds.x,-100000,100000,100),y:clamp(bounds.y,-100000,100000,100),width:clamp(bounds.width,360,3840,760),height:clamp(bounds.height,260,2160,640)}});
  }
  return result;
}
export function removeWorkflowPanel(layout,panel){
  const next=normalizeWorkflowLayout(layout);
  for(const name of groups){const group=next.groups[name];group.panels=group.panels.filter(item=>item!==panel);if(!group.panels.includes(group.active))group.active=group.panels[0]||null;}
  next.floating=next.floating.filter(item=>item.panel!==panel);return next;
}
export function moveWorkflowPanel(layout,panel,group,index){
  if(!WORKFLOW_PANELS.includes(panel)||!groups.includes(group))return normalizeWorkflowLayout(layout);
  const current=normalizeWorkflowLayout(layout),originalIndex=current.groups[group].panels.indexOf(panel);
  if(current.enabled&&originalIndex>=0&&Number.isFinite(index)&&clamp(index,0,current.groups[group].panels.length-1,0)===originalIndex)return current;
  const next=removeWorkflowPanel(layout,panel),target=next.groups[group];
  target.panels.splice(clamp(index,0,target.panels.length,target.panels.length),0,panel);target.active=panel;next.enabled=true;return next;
}
// Drop indices refer to the list after the dragged panel has been removed.
// This keeps moving a tab past its neighbour correct in either direction.
export function workflowDropIndex(layout,panel,group,targetPanel,side='before'){
  if(!groups.includes(group))return undefined;
  const original=normalizeWorkflowLayout(layout).groups[group].panels;
  if(targetPanel===panel)return Math.max(0,original.indexOf(panel));
  const panels=original.filter(item=>item!==panel);
  const index=panels.indexOf(targetPanel);
  return index<0?panels.length:index+(side==='after'?1:0);
}
export function createWorkflowPreset(name){
  const layout=createWorkflowLayout();layout.enabled=true;
  if(name==='research')layout.groups={right:{panels:['browser'],active:'browser'},bottom:{panels:['notes'],active:'notes'}};
  else if(name==='writing')layout.groups={right:{panels:['notes'],active:'notes'},bottom:{panels:['workbench'],active:'workbench'}};
  else if(name==='coding')layout.groups={right:{panels:['browser','workbench'],active:'browser'},bottom:{panels:['terminal'],active:'terminal'}};
  else return layout;
  return layout;
}
export function setWorkflowActive(layout,group,panel){
  const next=normalizeWorkflowLayout(layout);
  if(groups.includes(group)&&next.groups[group].panels.includes(panel))next.groups[group].active=panel;
  return next;
}
export function floatWorkflowPanel(layout,panel,bounds){
  if(!WORKFLOW_PANELS.includes(panel))return normalizeWorkflowLayout(layout);
  const next=removeWorkflowPanel(layout,panel);next.enabled=true;next.floating.push({panel,bounds});return normalizeWorkflowLayout(next);
}
export function normalizeWorkflowPreferences(value){
  value=object(value);const saved=[],names=new Set();
  for(const item of (Array.isArray(value.saved)?value.saved:[]).slice(0,20)){
    if(typeof item?.name!=='string')continue;
    const name=item.name.trim().slice(0,60),key=name.toLocaleLowerCase();if(!name||names.has(key))continue;
    names.add(key);saved.push({name,layout:normalizeWorkflowLayout(item.layout)});
  }
  return {current:normalizeWorkflowLayout(value.current),saved};
}
export function readWorkflowPreferences(storage){
  try{return normalizeWorkflowPreferences(JSON.parse(storage.getItem(WORKFLOW_STORAGE_KEY)||'null'));}
  catch{return normalizeWorkflowPreferences(null);}
}
export function writeWorkflowPreferences(storage,value){
  const normalized=normalizeWorkflowPreferences(value);
  try{storage.setItem(WORKFLOW_STORAGE_KEY,JSON.stringify(normalized));return true;}
  catch{return false;}
}
