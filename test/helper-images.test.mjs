import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readHelperImages } from '../desktop/helper-images.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lscAAAAASUVORK5CYII=';
test('helper image loading reads validated workspace pixels and accessible chat assets',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-helper-images-'));assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'icon.png'),Buffer.from(png,'base64'));
  const asset={mimeType:'image/png',dataBase64:png,bytes:Buffer.from(png,'base64').length};
  const images=await readHelperImages({image_paths:['icon.png'],image_ids:['a'.repeat(64)]},{assets:{get:async()=>asset},canReadAsset:()=>true,resolvePath:async value=>path.join(root,value)});
  assert.equal(images.length,2);assert.equal(images[1].dataBase64,png);assert.equal(images[1].mimeType,'image/png');
});
test('inaccessible images and invalid containers never reach helpers',async t=>{
  let reads=0;await assert.rejects(readHelperImages({image_ids:['a'.repeat(64)]},{assets:{get:async()=>{reads++;}},canReadAsset:()=>false}),/not available/);assert.equal(reads,0);
  const root=await mkdtemp(path.join(os.tmpdir(),'exomina-helper-images-'));assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'fake.png'),'<svg>not raster pixels</svg>');
  await assert.rejects(readHelperImages({image_paths:['fake.png']},{resolvePath:async()=>path.join(root,'fake.png')}),/Only PNG/);
});
