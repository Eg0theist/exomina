import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=name=>readFile(new URL('../desktop/'+name,import.meta.url),'utf8');

// Windows applies a hidden start state to the first window a program shows, so a hidden reopen leaves Exomina only in the tray.
test('the updater reopens Exomina without a hidden start state',async()=>{
 const launcher=await read('update-launcher.cjs'),runner=await read('update-runner.ps1');
 const open=/async function open\(target\)\{[\s\S]*?\n  \}/.exec(launcher)?.[0]||'';
 assert.match(open,/spawn\(target,\[\],\{[^}]*windowsHide:false/);
 const reopen=/function Open-UpdatedProgram[\s\S]*?\n\}/.exec(runner)?.[0]||'';
 assert.match(reopen,/Start-Process/);assert.doesNotMatch(reopen,/-WindowStyle\s+Hidden/i);
});

test('the main window is shown again if the first show was swallowed by a hidden or minimized start',async()=>{
 const main=await read('main.mjs');
 assert.match(main,/window\.show\(\);\s*\n\s*\/\/[^\n]*\n\s*if\(!window\.isVisible\(\)\|\|window\.isMinimized\(\)\)\{window\.show\(\);if\(window\.isMinimized\(\)\)window\.restore\(\);window\.focus\(\);\}/);
});
