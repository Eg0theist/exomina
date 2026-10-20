import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';

// Modules in desktop/ that the renderer imports run in the browser too: Node built-ins
// compile with Vite but crash at runtime, leaving a blank window.
test('desktop modules shared with the renderer import no Node built-ins', async()=>{
  const shared=new Set();
  for(const file of (await readdir('src')).filter(name=>/\.(jsx?|mjs)$/.test(name)))
    for(const match of (await readFile(`src/${file}`,'utf8')).matchAll(/from '\.\.\/desktop\/([^']+)'/g))shared.add(match[1]);
  assert.ok(shared.size>3);
  for(const file of shared)assert.doesNotMatch(await readFile(`desktop/${file}`,'utf8'),/from 'node:|require\('node:/,file);
});
