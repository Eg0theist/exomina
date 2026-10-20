import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyEncryptedStorage,preparePrivateTemporaryStorage} from '../cloud/storage-guard.mjs';
test('production cloud refuses ordinary volumes and missing mount evidence',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-storage-'));t.after(()=>rm(dir,{recursive:true,force:true}));const run=async command=>({stdout:JSON.stringify(command==='findmnt'?{filesystems:[{source:'/dev/sda',fstype:'ext4',options:'rw'}]}:{blockdevices:[{name:'sda',type:'disk'}]})});await assert.rejects(()=>verifyEncryptedStorage(dir,{platform:'linux',run}),/not on a verified/);await assert.rejects(()=>verifyEncryptedStorage(dir,{platform:'win32',run}),/requires Linux/);});
test('encrypted mapping evidence must include a crypt ancestor or gocryptfs mount',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'exomina-storage-'));t.after(()=>rm(dir,{recursive:true,force:true}));const run=async command=>({stdout:JSON.stringify(command==='findmnt'?{filesystems:[{source:'/dev/mapper/private',fstype:'ext4',options:'rw,nosuid'}]}:{blockdevices:[{name:'lvm',type:'lvm',children:[{name:'private',type:'crypt'}]}]})});assert.equal((await verifyEncryptedStorage(dir,{platform:'linux',run})).mechanism,'LUKS');});

test('a plaintext sibling behind an LVM volume must fail even when another branch is encrypted', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async command => ({ stdout: JSON.stringify(command === 'findmnt' ? { filesystems: [{ source: '/dev/mapper/private', fstype: 'ext4', options: 'rw' }] } : {
    blockdevices: [{ name: 'mixed-lvm', type: 'lvm', children: [{ name: 'protected', type: 'crypt', children: [{ name: 'sda', type: 'disk' }] }, { name: 'sdb', type: 'disk' }] }],
  }) });
  await assert.rejects(() => verifyEncryptedStorage(dir, { platform: 'linux', run }), /not on a verified/);
});

test('all backing branches and top-level devices must cross encryption; empty or malformed evidence fails closed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const check = blockdevices => verifyEncryptedStorage(dir, { platform: 'linux', run: async command => ({ stdout: JSON.stringify(command === 'findmnt' ? { filesystems: [{ source: '/dev/mapper/private', fstype: 'ext4', options: 'rw' }] } : { blockdevices }) }) });
  const crypt = { name: 'protected', type: 'crypt', children: [{ name: 'sda', type: 'disk' }] };
  assert.equal((await check([{ type: 'lvm', children: [crypt, { type: 'lvm', children: [crypt] }] }])).protected, true);
  assert.equal((await check([{ type: 'crypt', children: [{ type: 'raid1', children: [{ type: 'disk' }, { type: 'disk' }] }] }])).protected, true, 'encryption above all storage branches is sufficient');
  for (const evidence of [[], null, [null], [{ type: 'lvm', children: [] }], [{ type: 'lvm', children: 'invalid' }], [crypt, { type: 'disk' }], [{ type: 'lvm', children: [{ type: 'lvm', children: [crypt, { type: 'part', children: [{ type: 'disk' }] }] }] }]]) {
    await assert.rejects(check(evidence), /not on a verified/);
  }
});

test('read-only and generic FUSE mounts fail while the explicitly supported writable encrypted FUSE mount passes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const check = mount => verifyEncryptedStorage(dir, { platform: 'linux', run: async command => { assert.equal(command, 'findmnt'); return { stdout: JSON.stringify({ filesystems: [mount] }) }; } });
  await assert.rejects(check({ source: 'gocryptfs', fstype: 'fuse.gocryptfs', options: 'ro' }), /writable/);
  await assert.rejects(check({ source: 'unknown', fstype: 'fuse', options: 'rw' }), /not on a verified/);
  assert.equal((await check({ source: 'gocryptfs', fstype: 'fuse.gocryptfs', options: 'rw,nosuid,nodev' })).mechanism, 'gocryptfs');
});

test('startup temporary paths change only after both private storage and its temporary subdirectory are verified', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await realpath(dir), env = { TEMP: 'old-temp', TMP: 'old-tmp', TMPDIR: 'old-tmpdir' }, calls = [];
  const result = await preparePrivateTemporaryStorage(root, { env, verify: async target => { calls.push(target); assert.equal(env.TEMP, 'old-temp'); return { protected: true, dataDir: await realpath(target), mechanism: 'synthetic-test' }; } });
  assert.deepEqual(calls, [root, path.join(root, 'runtime-tmp')]);
  assert.equal((await stat(result.tempDir)).isDirectory(), true);
  assert.deepEqual(env, { TEMP: result.tempDir, TMP: result.tempDir, TMPDIR: result.tempDir });
  const unchanged = { TEMP: 'old-temp', TMP: 'old-tmp', TMPDIR: 'old-tmpdir' };
  await assert.rejects(preparePrivateTemporaryStorage(root, { env: unchanged, verify: async target => { if (target !== root) throw Error('Synthetic nested plaintext mount'); return { protected: true, dataDir: root }; } }), /plaintext mount/);
  assert.deepEqual(unchanged, { TEMP: 'old-temp', TMP: 'old-tmp', TMPDIR: 'old-tmpdir' });
});
