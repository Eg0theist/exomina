import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONTEXT_SNAPSHOTS, recordContextMetrics, contextMetricsView, reportedCacheRate, refinementMetrics } from '../desktop/context-metrics.mjs';

test('host measurements count final UTF-8 bytes without retaining content or inferred tokens', () => {
  const message = {}, prompt = 'Instructions\n雪😀\nCurrent request';
  const value = recordContextMetrics(message, { prompt, provider: 'claude', lane: 'tools', resumedSession: true, treeViewBytes: 7,
    promptBlocks: [{ text: 'Instructions\n', cache: true }, { text: '雪😀\nCurrent request' }], capturedAt: '2026-10-22T12:00:00.000Z' });
  assert.equal(value.snapshots[0].promptBytes, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(value.snapshots[0].cacheMarkedBytes, Buffer.byteLength('Instructions\n', 'utf8'));
  assert.equal(value.snapshots[0].cacheMarkedBlocks, 1);
  assert.equal(value.snapshots[0].resumedSession, true);
  assert.equal(value.snapshots[0].treeViewBytes, 7);
  assert.doesNotMatch(JSON.stringify(value), /Instructions|Current request|token|cost|hash|saved/);
  assert.equal(value, message.contextMetrics);
});

test('unreported cache hints and mismatched blocks remain unknown, explicit no markers is zero', () => {
  const message = {};
  assert.equal(recordContextMetrics(message, { prompt: 'abc' }).snapshots.at(-1).cacheMarkedBytes, null);
  assert.equal(recordContextMetrics(message, { prompt: 'abc', promptBlocks: [{ text: 'other', cache: true }] }).snapshots.at(-1).cacheMarkedBlocks, null);
  assert.equal(recordContextMetrics(message, { prompt: 'abc', promptBlocks: [{ text: 'abc' }] }).snapshots.at(-1).cacheMarkedBytes, 0);
  assert.equal(recordContextMetrics(message, { prompt: null }), null);
});

test('attempt history stays bounded across provider switches while preserving actual counts', () => {
  const message = {};
  for (let index = 0; index < 40; index++) recordContextMetrics(message, { prompt: 'attempt' + index, provider: index % 2 ? 'codex' : 'claude', lane: 'tools' });
  assert.equal(message.contextMetrics.requests, 40);
  assert.equal(message.contextMetrics.snapshots.length, MAX_CONTEXT_SNAPSHOTS);
  assert.equal(message.contextMetrics.omitted, 40 - MAX_CONTEXT_SNAPSHOTS);
  assert.equal(message.contextMetrics.snapshots[0].sequence, 25);
  assert.equal(message.contextMetrics.snapshots.at(-1).provider, 'codex');
});

test('diagnostic projection drops added payloads and malformed numeric fields', () => {
  const message = {};
  recordContextMetrics(message, { prompt: 'safe', provider: 'codex' });
  message.contextMetrics.secret = 'private'; message.contextMetrics.snapshots[0].prompt = 'private';
  assert.doesNotMatch(JSON.stringify(contextMetricsView(message.contextMetrics)), /private|secret/);
  message.contextMetrics.snapshots[0].promptBytes = Infinity;
  assert.equal(contextMetricsView(message.contextMetrics), null);
  assert.equal(contextMetricsView({ format: 1, snapshots: [] }), null);
});

test('cache read fractions use reported latest counters and reject absent or inconsistent data', () => {
  assert.equal(reportedCacheRate({ inputTokens: 100, cachedInputTokens: 75 }), 0.75);
  assert.equal(reportedCacheRate({ inputTokens: 100, cachedInputTokens: 0 }), 0);
  for (const usage of [null, {}, { inputTokens: 0, cachedInputTokens: 0 }, { inputTokens: 20 }, { inputTokens: null, cachedInputTokens: 2 },
    { inputTokens: 1, cachedInputTokens: 2 }, { inputTokens: -1, cachedInputTokens: 0 }, { inputTokens: 1.5, cachedInputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: 1 }]) assert.equal(reportedCacheRate(usage), null);
});

test('refinement counts separate recorded states and deduplicate receipt outcomes', () => {
  const receipt = { id: 'one', status: 'completed' }, failed = { id: 'two', status: 'failed' };
  const result = refinementMetrics([{ status: 'proposed', baselineEvidence: [receipt] }, { status: 'compared', baselineEvidence: [receipt], candidateEvidence: [failed], probeEvidence: [failed] },
    { status: 'adopted' }, { status: 'rejected' }, { status: 'retired' }, { status: 'untrusted', baselineEvidence: [{ id: 'ignored', status: 'failed' }] }]);
  assert.deepEqual(result, { recorded: 5, open: 1, compared: 1, adopted: 1, rejected: 1, retired: 1, evidence: 2, failedEvidence: 1 });
  assert.equal(refinementMetrics(null).recorded, 0);
});
