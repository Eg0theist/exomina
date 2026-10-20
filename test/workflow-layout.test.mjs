import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowLayout,createWorkflowPreset,workflowDropIndex,normalizeWorkflowLayout,moveWorkflowPanel,removeWorkflowPanel,setWorkflowActive,floatWorkflowPanel,normalizeWorkflowPreferences,readWorkflowPreferences,writeWorkflowPreferences,WORKFLOW_STORAGE_KEY} from '../src/workflow-layout.js';

test('corrupt and future workflow records recover a usable simple default',()=>{
  for(const value of [null,[],{version:2,enabled:true},'broken'])assert.deepEqual(normalizeWorkflowLayout(value),createWorkflowLayout());
  assert.deepEqual(readWorkflowPreferences({getItem:()=>'{broken'}),{current:createWorkflowLayout(),saved:[]});
  assert.deepEqual(readWorkflowPreferences({getItem(){throw Error('disabled')}}),{current:createWorkflowLayout(),saved:[]});
});
test('layout normalization deduplicates panels and repairs selection and unsafe geometry',()=>{
  const value=normalizeWorkflowLayout({version:1,enabled:true,groups:{right:{panels:['browser','browser','untrusted','notes'],active:'missing'},bottom:{panels:['notes','terminal'],active:'terminal'}},sizes:{right:Infinity,bottom:-10},floating:[{panel:'browser'},{panel:'workbench',bounds:{x:1e9,y:-1e9,width:0,height:1e9}}]});
  assert.deepEqual(value.groups,{right:{panels:['browser','notes'],active:'browser'},bottom:{panels:['terminal'],active:'terminal'}});
  assert.deepEqual(value.sizes,{right:420,bottom:180});assert.deepEqual(value.floating,[{panel:'workbench',bounds:{x:100000,y:-100000,width:360,height:2160}}]);
  assert.deepEqual(normalizeWorkflowLayout(value),value);
});
test('tab moves preserve all other panels and repair active tabs without mutating input',()=>{
  const before=createWorkflowLayout(),snapshot=structuredClone(before);
  const next=moveWorkflowPanel(before,'browser','bottom',1);
  assert.deepEqual(before,snapshot);assert.deepEqual(next.groups.right,{panels:['notes'],active:'notes'});
  assert.deepEqual(next.groups.bottom,{panels:['terminal','browser','workbench'],active:'browser'});assert.equal(next.enabled,true);
  const reordered=moveWorkflowPanel(next,'workbench','bottom',0);assert.deepEqual(reordered.groups.bottom.panels,['workbench','terminal','browser']);
  assert.deepEqual(moveWorkflowPanel(before,'invented','right'),before);assert.deepEqual(moveWorkflowPanel(before,'browser','invented'),before);
  assert.equal(setWorkflowActive(next,'bottom','terminal').groups.bottom.active,'terminal');assert.equal(setWorkflowActive(next,'bottom','notes').groups.bottom.active,'browser');
});
test('floating and redocking give each panel exactly one owner and preserve bounds',()=>{
  const floating=floatWorkflowPanel(createWorkflowLayout(),'browser',{x:200,y:100,width:800,height:700});
  assert.deepEqual(floating.groups.right.panels,['notes']);assert.equal(floating.floating[0].bounds.width,800);
  const docked=moveWorkflowPanel(floating,'browser','bottom',0);assert.deepEqual(docked.floating,[]);assert.equal(docked.groups.bottom.panels[0],'browser');
  assert.deepEqual(removeWorkflowPanel(docked,'browser').groups.bottom.panels,['terminal','workbench']);
});

test('dropping before or after a tab works forward, backward and across groups',()=>{
  const layout=moveWorkflowPanel(createWorkflowLayout(),'notes','bottom',1);
  const drop=(panel,target,side)=>moveWorkflowPanel(layout,panel,'bottom',workflowDropIndex(layout,panel,'bottom',target,side));
  assert.deepEqual(layout.groups.bottom.panels,['terminal','notes','workbench']);
  assert.deepEqual(drop('terminal','notes','after').groups.bottom.panels,['notes','terminal','workbench']);
  assert.deepEqual(drop('workbench','notes','before').groups.bottom.panels,['terminal','workbench','notes']);
  assert.deepEqual(drop('browser','notes','after').groups.bottom.panels,['terminal','notes','browser','workbench']);
  assert.deepEqual(drop('terminal','terminal','before'),layout);
  assert.equal(workflowDropIndex(layout,'notes','invented','terminal'),undefined);
});

test('starter layouts contain only visual panel arrangement and remain editable',()=>{
  const research=createWorkflowPreset('research'),writing=createWorkflowPreset('writing'),coding=createWorkflowPreset('coding');
  assert.deepEqual(research.groups,{right:{panels:['browser'],active:'browser'},bottom:{panels:['notes'],active:'notes'}});
  assert.deepEqual(writing.groups.right.panels,['notes']);assert.deepEqual(writing.groups.bottom.panels,['workbench']);
  assert.deepEqual(coding.groups.bottom.panels,['terminal']);
  for(const layout of [research,writing,coding]){assert.equal(layout.enabled,true);assert.deepEqual(normalizeWorkflowLayout(layout),layout);assert.deepEqual(layout.floating,[]);}
  assert.deepEqual(moveWorkflowPanel(research,'terminal','right').groups.right.panels,['browser','terminal']);
});
test('saved visual layouts round trip without retaining content or unexpected fields',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const input={current:{...createWorkflowLayout(),draft:'private draft',messages:[{content:'private'}]},saved:[{name:' Research ',layout:moveWorkflowPanel(createWorkflowLayout(),'notes','bottom',0)},{name:'research',layout:createWorkflowLayout()},{name:'',layout:createWorkflowLayout()}],secret:'discard'};
  assert.equal(writeWorkflowPreferences(storage,input),true);const restored=readWorkflowPreferences(storage);assert.equal(restored.saved.length,1);assert.equal(restored.saved[0].name,'Research');
  assert.deepEqual(restored,normalizeWorkflowPreferences(input));assert.doesNotMatch(values.get(WORKFLOW_STORAGE_KEY),/private|secret|messages|draft/);
  assert.equal(writeWorkflowPreferences({setItem(){throw Error('full')}},input),false);
});
