import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../desktop/store.mjs';
import {THEMES,normalizeAppearance,validateAppearance,resolveTheme,paletteContrastReport} from '../desktop/themes.mjs';
import {PALETTE_TOKENS} from '../desktop/palette-contrast.mjs';

const base=THEMES.find(theme=>theme.id==='verdigris');
const palette={baseTheme:base.id,colors:{accent:'#bceacf'}};

test('runtime palette contrast follows the actual semantic token expressions',()=>{
 const css=readFileSync(new URL('../src/refresh.css',import.meta.url),'utf8');
 const tokens=Object.fromEntries([...css.match(/:root\{([^}]*)\}/)[1].matchAll(/--([\w-]+):([^;]+);/g)].map(match=>[match[1],match[2].trim()]));
 for(const[key,expression]of Object.entries(PALETTE_TOKENS))assert.equal(expression,tokens[key],key);
 for(const theme of THEMES)assert.equal(paletteContrastReport(theme).passed,true,theme.id);
});

test('valid palette applies without mutating the base and survives unrelated preferences',()=>{
 const original=JSON.stringify(base);
 const saved=validateAppearance({theme:base.id,customPalette:palette,motion:'reduced'},{textSize:'large'});
 const reloaded=normalizeAppearance(JSON.parse(JSON.stringify(saved)));
 assert.deepEqual(reloaded.customPalette,palette);
 const resolved=resolveTheme(reloaded);
 assert.equal(resolved.colors.accent,palette.colors.accent);
 assert.equal(resolved.colors.ground,base.colors.ground);
 assert.equal(resolved.scheme,base.scheme);
 assert.equal(saved.motion,'reduced');assert.equal(saved.textSize,'large');
 assert.equal(JSON.stringify(base),original);
 assert.deepEqual(validateAppearance({textSize:'small'},saved).customPalette,palette);
});

test('base theme changes clear the override and reset explicitly restores the base',()=>{
 const saved=validateAppearance({customPalette:palette},{});
 const changed=validateAppearance({theme:'paper'},saved);
 assert.equal(changed.customPalette,null);assert.equal(resolveTheme(changed).id,'paper');
 assert.equal(validateAppearance({theme:'system'},saved).customPalette,null);
 assert.equal(validateAppearance({customPalette:null},saved).customPalette,null);
 assert.equal(normalizeAppearance({theme:'paper',customPalette:palette}).customPalette,null);
 assert.throws(()=>validateAppearance({theme:'paper',customPalette:palette},saved),/palette/i);
});

test('palette rejects executable, unknown, oversized and unreadable values',()=>{
 for(const colors of [{css:'body{}'},{accent:'url(https://example.invalid/x)'},{ground:'#ffffff',ink:'#ffffff'},{accent:'#123'},{shadow:'#000000'},{accent:'#BCEACF'},{accent:'x'.repeat(100000)},{}]){
  const value={baseTheme:base.id,colors};
  assert.equal(normalizeAppearance({customPalette:value}).customPalette,null);
  assert.throws(()=>validateAppearance({customPalette:value},{}),/palette/i);
 }
 assert.throws(()=>validateAppearance({customPalette:{...palette,script:'x'}},{}),/palette/i);
 assert.throws(()=>validateAppearance({customPalette:palette,textColor:base.colors.ground},{}),/contrast/);
 const saved=validateAppearance({customPalette:palette},{});
 assert.throws(()=>validateAppearance({textColor:base.colors.ground},saved),/contrast/,'bad text override cannot silently drop the custom palette');
 assert.equal(paletteContrastReport({...base,colors:{...base.colors,accent:base.colors.ground}}).passed,false);
});

test('cached palette checks remain bound to all colours and return independent objects',()=>{
 const input={baseTheme:base.id,colors:{accent:'#bceacf'}};
 const first=validateAppearance({customPalette:input},{});
 input.colors.accent=base.colors.ground;
 assert.throws(()=>validateAppearance({customPalette:input},{}),/contrast/);
 assert.equal(first.customPalette.colors.accent,'#bceacf');
 const second=normalizeAppearance(first);second.customPalette.colors.accent=base.colors.ground;
 assert.equal(normalizeAppearance(second).customPalette,null);
 assert.equal(normalizeAppearance(first).customPalette.colors.accent,'#bceacf');
 assert.throws(()=>validateAppearance({textColor:base.colors.ground},first),/contrast/);
});

test('custom palette persists across a real isolated store reopen',async t=>{
 const parent=path.resolve(tmpdir()),folder=await mkdtemp(path.join(parent,'exomina-custom-palette-'));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(folder)),parent);await rm(folder,{recursive:true,force:true});});
 const store=new Store(folder);await store.init();
 store.state.settings.appearance=validateAppearance({customPalette:palette,motion:'reduced'},store.state.settings.appearance);await store.save();
 const reopened=new Store(folder);await reopened.init();
 assert.deepEqual(reopened.state.settings.appearance.customPalette,palette);
 assert.equal(resolveTheme(reopened.state.settings.appearance).colors.accent,palette.colors.accent);
 assert.equal(reopened.state.settings.appearance.motion,'reduced');
});
