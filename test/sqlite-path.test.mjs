import test from 'node:test';
import assert from 'node:assert/strict';
import {sqlitePath} from '../desktop/sqlite-path.mjs';

test('SQLite native filenames preserve memory/temporary databases and Unix paths',()=>{
 for(const platform of ['win32','linux','darwin'])for(const special of [':memory:',''])assert.equal(sqlitePath(special,platform),special);
 for(const platform of ['linux','darwin'])for(const file of ['/tmp/notes.sqlite','relative/database.sqlite'])assert.equal(sqlitePath(file,platform),file);
});

test('Windows SQLite filenames use equivalent extended drive and UNC paths',()=>{
 assert.equal(sqlitePath('C:\\Library\\memory\\notes.sqlite','win32'),'\\\\?\\C:\\Library\\memory\\notes.sqlite');
 assert.equal(sqlitePath('\\\\server\\share\\notes.sqlite','win32'),'\\\\?\\UNC\\server\\share\\notes.sqlite');
 const extended='\\\\?\\C:\\Library\\notes.sqlite';assert.equal(sqlitePath(extended,'win32'),extended);
});
