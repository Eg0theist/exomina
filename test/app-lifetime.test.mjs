import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ensureWindowsAppIndependence,INDEPENDENT_APP_ENV} from '../desktop/app-lifetime.mjs';

test('normal startup never creates a helper or replacement process on any platform',async()=>{
  for (const platform of ['win32','linux','darwin']) for (const packaged of [true,false]) {
    const env={SystemRoot:'C:\\Windows',EXOMINA_DATA_DIR:'C:\\synthetic-profile'};
    const before={...env};
    const result=await ensureWindowsAppIndependence({platform,packaged,env,exePath:'C:\\Exomina\\Exomina.exe',spawnImpl:()=>assert.fail('Startup must not launch a process')});
    assert.deepEqual(result,{handedOff:false,status:'not-required'});
    assert.deepEqual(env,before);
  }
});

test('legacy relay markers cannot cause a second launch or select another data root',async()=>{
  const env={[INDEPENDENT_APP_ENV]:'11111111-2222-3333-4444-555555555555',EXOMINA_DATA_DIR:'C:\\synthetic-profile',EXOMINA_ACCOUNTS_DIR:'C:\\synthetic-accounts'};
  const result=await ensureWindowsAppIndependence({env,spawnImpl:()=>assert.fail('No legacy relay')});
  assert.equal(result.handedOff,false);
  assert.equal(INDEPENDENT_APP_ENV in env,false);
  assert.equal(env.EXOMINA_DATA_DIR,'C:\\synthetic-profile');
  assert.equal(env.EXOMINA_ACCOUNTS_DIR,'C:\\synthetic-accounts');
});

test('retired compatibility helper contains no native process creation or resume routine',async()=>{
  const script=await readFile(new URL('../desktop/app-lifetime.ps1',import.meta.url),'utf8');
  assert.doesNotMatch(script,/DllImport|CreateProcess|ResumeThread|TerminateProcess|Start-Process|Add-Type/);
  assert.match(script,/relay was retired/);
});
