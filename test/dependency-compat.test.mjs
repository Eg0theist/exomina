import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {prepareDependencyCompatibility} from '../scripts/prepare-dependency-compat.mjs';

test('patched minimatch preserves actual packaging directory filters through the legacy caller',async t=>{
 const root=path.resolve(import.meta.dirname,'..');
 await prepareDependencyCompatibility(root);
 await prepareDependencyCompatibility(root);
 const require=createRequire(import.meta.url),compare=require('dir-compare');
 assert.equal(require('minimatch/package.json').version,'11.0.4');
 const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-filter-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=path.join(dir,'a'),b=path.join(dir,'b');await mkdir(a);await mkdir(b);
 await writeFile(path.join(a,'keep.txt'),'same');await writeFile(path.join(b,'keep.txt'),'same');
 await writeFile(path.join(a,'skip.bin'),'different');await writeFile(path.join(b,'skip.bin'),'bytes');
 const options={compareContent:true,includeFilter:'*.txt'};
 assert.equal(compare.compareSync(a,b,options).same,true);
 await writeFile(path.join(b,'keep.txt'),'changed');
 assert.equal((await compare.compare(a,b,options)).same,false);
});
