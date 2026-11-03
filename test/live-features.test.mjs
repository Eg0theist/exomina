import test from 'node:test';
import assert from 'node:assert/strict';
import {FEATURES,featureDisabled,toolEnabled,normalizeDisabledFeatures,normalizeDisabledTools,assertFeature} from '../desktop/features.mjs';
import {TUTORIALS} from '../src/tutorial-catalog.mjs';

test('feature revocation blocks stale tools and preserves unrelated capabilities',()=>{
 const settings={disabledFeatures:['files','analysis','extensions'],disabledTools:['audio_inspect'],browserEnabled:true,desktopEnabled:true};
 for(const name of ['workspace_write','analysis_native','ghidra_edit','extension_add','external_fixture_echo_a123','audio_inspect','humanizer']){assert.equal(featureDisabled(name,settings),true);assert.throws(()=>assertFeature(name,settings),/turned off/);}
 for(const name of ['workspace_read','workspace_list'])assert.equal(featureDisabled(name,settings),true);
 for(const name of ['browser_open','external_cua_click_123','memory_note','ask_user_question','outcome_verify'])assert.equal(featureDisabled(name,settings),false);
 settings.disabledFeatures=[];settings.disabledTools=[];assert.equal(featureDisabled('workspace_write',settings),false);assert.equal(toolEnabled('browser_open',{browserEnabled:false}),false);
});
test('malformed feature and tool changes cannot disable essential approvals or inject fields',()=>{
 assert.deepEqual(normalizeDisabledFeatures(['files','files']),['files']);
 for(const value of [['unknown'],['__proto__'],{},null])assert.throws(()=>normalizeDisabledFeatures(value));
 for(const value of [['request_permission'],['outcome_verify'],['memory_note'],['workspace_read\nmalicious'],{},null])assert.throws(()=>normalizeDisabledTools(value));
 assert.deepEqual(normalizeDisabledTools(['workspace_read','workspace_read']),['workspace_read']);
 assert.equal(new Set(FEATURES.map(feature=>feature.id)).size,FEATURES.length);
});
test('guides preserve IDs, begin with first conversation and have valid destinations',()=>{
 assert.equal(TUTORIALS[0].id,'first-chat');assert.equal(new Set(TUTORIALS.map(guide=>guide.id)).size,TUTORIALS.length);
 for(const id of ['first-chat','good-habits','voice','models-usage','files-tools','memory-style','projects-prompts','scheduled-work','github','appearance-quick','backup-restore','work-plans','phone-access','features-tools'])assert(TUTORIALS.some(guide=>guide.id===id));
 for(const guide of TUTORIALS)for(const step of guide.steps){assert(['chat','connections','tools','settings','workbench','memory','tutorials'].includes(step.page));assert(step.target);assert(step.text.length<650);if(step.page==='settings')assert(step.section);}
 const text=TUTORIALS.flatMap(guide=>guide.steps).map(step=>step.text).join('\n');assert.doesNotMatch(text,/Realtime ChatGPT|Usage & resets|Projects & prompts|Style beside Send|audio stays on this PC.*OpenAI/i);
});
