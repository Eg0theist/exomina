import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore, htmlText } from '../desktop/archive.mjs';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exomina-archive-providers-'));
  const archive = new ArchiveStore(dir);
  await archive.init();
  t.after(async () => { archive.close(); await rm(dir, { recursive: true, force: true }); });
  return { archive, save: async (name, value) => { const file = path.join(dir, name); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); return file; } };
}

test('Grok exports become one conversation per chat with user and assistant turns', async t => {
  const { archive, save } = await setup(t);
  const file = await save('prod-grok-backend.json', { conversations: [
    { conversation: { id: 'grok-1', title: 'Synthetic trip plan', create_time: '2026-10-01T10:00:00Z', modify_time: '2026-10-01T10:05:00Z' }, responses: [
      { response: { _id: 'r1', sender: 'human', message: 'Plan a synthetic trip.', create_time: { $date: { $numberLong: String(Date.parse('2026-10-01T10:00:00Z')) } } } },
      { response: { _id: 'r2', sender: 'ASSISTANT', message: 'Synthetic itinerary.', create_time: { $date: '2026-10-01T10:01:00Z' } } },
    ] },
  ] });
  const preview = await archive.previewFile(file);
  assert.equal(preview.conversationCount, 1);
  assert.equal(preview.source, 'Grok');
  const result = await archive.commit(preview.token);
  assert.equal(result.added, 1);
  const found = await archive.search('itinerary');
  const record = await archive.read(found.results[0].id);
  assert.equal(record.title, 'Synthetic trip plan');
  assert.match(record.text, /\[user · 2026-10-01T10:00:00\.000Z · message r1\]\nPlan a synthetic trip\./);
  assert.match(record.text, /\[assistant · 2026-10-01T10:01:00\.000Z · message r2\]\nSynthetic itinerary\./);
  const again = await archive.commit((await archive.previewFile(file)).token);
  assert.equal(again.added, 0); assert.equal(again.duplicates, 1);
});

test('Gemini Takeout JSON groups prompts per day and ignores other Google activity', async t => {
  const { archive, save } = await setup(t);
  const file = await save('MyActivity.json', [
    { header: 'Gemini Apps', title: 'Prompted Synthetic question one', time: '2026-10-02T09:00:00.000Z', products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>Synthetic answer &amp; detail</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted Synthetic question two', time: '2026-10-02T11:00:00.000Z', products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>Second answer</p>' }] },
    { header: 'Gemini Apps', title: 'Prompted Next day question', time: '2026-10-03T08:00:00.000Z', products: ['Gemini Apps'] },
    { header: 'YouTube', title: 'Watched something', time: '2026-10-02T10:00:00.000Z', products: ['YouTube'] },
  ]);
  const preview = await archive.previewFile(file);
  assert.equal(preview.conversationCount, 2);
  assert.equal(preview.source, 'Gemini');
  await archive.commit(preview.token);
  const record = await archive.read((await archive.search('Synthetic question one')).results[0].id);
  assert.equal(record.title, 'Gemini activity 2026-10-02');
  assert.match(record.text, /Synthetic question one\n\n\[assistant\]\nSynthetic answer & detail[\s\S]*Synthetic question two/);
  assert.doesNotMatch(record.text, /Watched/);
});

test('Gemini Takeout HTML is read as activity, other HTML is skipped', async t => {
  const { archive, save } = await setup(t);
  const cell = (header, body) => `<div class="outer-cell mdl-cell"><div class="mdl-grid"><div class="header-cell mdl-cell"><p class="mdl-typography--title">${header}<br></p></div><div class="content-cell mdl-cell">${body}</div><div class="content-cell mdl-cell mdl-typography--caption">Products: ${header}</div></div></div>`;
  const html = `<html><body>${cell('Gemini Apps', 'Prompted&nbsp;Synthetic html prompt<br>Oct 4, 2026, 10:00:00 AM<br><p>Synthetic html reply</p>')}${cell('Search', 'Searched for synthetic<br>Oct 4, 2026, 11:00:00 AM')}</body></html>`;
  const preview = await archive.previewFile(await save('MyActivity.html', html));
  assert.equal(preview.conversationCount, 1);
  await archive.commit(preview.token);
  const record = await archive.read((await archive.search('Synthetic html reply')).results[0].id);
  assert.match(record.text, /^\[user · 2026-10-04T[\d:.]+Z\]\nSynthetic html prompt\n\n\[assistant\]\nSynthetic html reply/);
  assert.doesNotMatch(record.text, /Searched/);
  const other = await archive.previewFile(await save('page.html', '<html><body><p>Not an export</p></body></html>'));
  assert.equal(other.documents, 0);
  assert.ok(other.warnings.some(warning => /no Gemini activity/.test(warning)));
});

test('htmlText decodes entities and keeps line structure', () => {
  assert.equal(htmlText('<p>A &lt;b&gt; &#x41;&#66;</p><ul><li>one</li><li>two</li></ul><script>x()</script>'), 'A <b> AB\n• one\n• two');
});
