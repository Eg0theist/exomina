import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from '../desktop/store.mjs';
import { THEMES, THEME_PROFILE } from '../desktop/themes.mjs';
import { THEMES as STANDARD_THEMES } from '../desktop/theme-catalog-standard.mjs';

async function stagedBeta(t) {
  const parent = path.resolve(tmpdir());
  const fixture = await mkdtemp(path.join(parent, 'exomina-theme-profile-'));
  t.after(async () => {
    assert.ok(path.resolve(fixture).startsWith(parent + path.sep));
    await rm(fixture, { recursive: true, force: true });
  });
  const desktop = path.join(fixture, 'desktop');
  await mkdir(desktop);
  for (const name of ['themes.mjs', 'theme-catalog-standard.mjs', 'companion-design.mjs', 'ui-zoom.mjs']) await copyFile(new URL('../desktop/' + name, import.meta.url), path.join(desktop, name));
  await writeFile(path.join(desktop, 'theme-catalog.mjs'), "export { THEMES, THEME_PROFILE } from './theme-catalog-standard.mjs';\n");
  // No full catalog or artwork exists in this fixture. Both host and renderer
  // import the same staged module, so a broken staging selector fails here.
  return { beta: await import(pathToFileURL(path.join(desktop, 'themes.mjs')).href), fixture };
}

test('compact staging works without personal catalogs and sanitizes imported appearance', async t => {
  const { beta } = await stagedBeta(t);
  assert.equal(beta.THEME_PROFILE, 'beta');
  assert.equal(beta.THEMES.length, 6);
  assert.ok(beta.THEMES.some(theme => theme.scheme === 'light'));
  assert.ok(beta.THEMES.some(theme => theme.scheme === 'dark'));
  assert.ok(beta.THEMES.every(theme => !theme.artwork && !theme.effect));
  const imported = beta.normalizeAppearance({ theme: 'cyberpunk-judy', darkTheme: 'erebus-flame', lightTheme: 'sakura', hiddenThemes: ['cyberpunk-johnny', 'graphite'], readingFont: 'serif', textSize: 'large', borderless: false });
  assert.equal(imported.theme, 'verdigris');
  assert.equal(imported.darkTheme, 'verdigris');
  assert.equal(imported.lightTheme, 'paper');
  assert.deepEqual(imported.hiddenThemes, ['graphite']);
  assert.equal(imported.readingFont, 'serif');
  assert.equal(imported.textSize, 'large');
  assert.equal(imported.borderless, false);
  assert.throws(() => beta.validateAppearance({ theme: 'cyberpunk-judy' }, imported), /theme/);
  assert.equal(beta.resolveTheme({ theme: 'system', lightTheme: 'daylight', darkTheme: 'midnight' }, false).id, 'daylight');
  assert.equal(beta.resolveTheme({ theme: 'system', lightTheme: 'daylight', darkTheme: 'midnight' }, true).id, 'midnight');
});

test('compact appearance persists across store restart and personal palettes keep their identity', async t => {
  const { beta, fixture } = await stagedBeta(t);
  const dataDir = path.join(fixture, 'synthetic-data');
  const store = new Store(dataDir);
  await store.init();
  const appearance = beta.validateAppearance({ theme: 'graphite', darkTheme: 'midnight', lightTheme: 'daylight', hiddenThemes: ['contrast'], readingFont: 'serif', textSize: 'large', chatWidth: 'wide', glow: true, motion: 'reduced', borderless: false }, {});
  store.state.settings.appearance = appearance;
  await store.save();
  const restarted = new Store(dataDir);
  await restarted.init();
  assert.deepEqual(beta.normalizeAppearance(restarted.state.settings.appearance), appearance);
  for (const standard of STANDARD_THEMES) assert.equal(THEMES.find(theme => theme.id === standard.id), standard, standard.id);
  if (THEME_PROFILE === 'personal') {
    assert.ok(THEMES.some(theme => theme.id === 'erebus-flame' && theme.artwork));
    assert.ok(THEMES.some(theme => theme.id === 'cyberpunk-judy' && theme.artwork));
  }
});
