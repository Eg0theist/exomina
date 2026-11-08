import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const base = path.resolve(process.argv[2] || '../Workspace/daily-proof-20261108/workflow/model');
const oracle = JSON.parse(await readFile(path.join(base, 'oracle.json'), 'utf8'));
const parse = answer => typeof answer === 'string' ? JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : answer;
export function score(expected, raw) {
  let answer;
  try { answer = parse(raw); } catch (error) { return { passed: false, checks: { validJSON: false }, error: error.message }; }
  const checks = { validJSON: !!answer && typeof answer === 'object' && !Array.isArray(answer),
    correctCaseAndClient: answer?.caseId === expected.caseId && answer.client === expected.client,
    correctPeriodAndAsOf: answer?.period === expected.period && answer.asOf === expected.asOf,
    exactOriginalSourceReferences: Array.isArray(answer?.sources) && JSON.stringify([...answer.sources].sort((a, b) => String(a.noteId).localeCompare(String(b.noteId)))) === JSON.stringify([...expected.sources].sort((a, b) => a.noteId.localeCompare(b.noteId))),
    missingRevenueAbstention: answer?.metrics?.revenueEUR === null && Array.isArray(answer.unknowns) && answer.unknowns.some(text => /revenue/i.test(String(text))),
    summaryPresent: typeof answer?.summary === 'string' && answer.summary.length >= 40 && /revenue/i.test(answer.summary) && /unknown|unavailable|not (?:available|provided|established)/i.test(answer.summary) };
  for (const [metric, value] of Object.entries(expected.metrics).filter(([key]) => key !== 'revenueEUR')) checks[metric + 'Correct'] = typeof answer?.metrics?.[metric] === 'number' && Number.isFinite(answer.metrics[metric]) && Math.abs(answer.metrics[metric] - value) < 0.000001;
  return { passed: Object.values(checks).every(Boolean), checks, answer };
}
if (process.argv.includes('--self-test')) {
  const expected = oracle.cases[0], valid = { ...expected, summary: 'Reviewed monthly counts and derived rates. Revenue is unknown.', unknowns: ['revenueEUR'] };
  assert.equal(score(expected, valid).passed, true);
  for (const mutate of [value => { value.metrics.leads++; }, value => { value.metrics.revenueEUR = 0; }, value => { value.sources[0].sha256 = '0'.repeat(64); }, value => { value.client = 'AnotherClient'; }, value => { value.metrics.conversionPercent *= 100; }]) {
    const wrong = structuredClone(valid); mutate(wrong); assert.equal(score(expected, wrong).passed, false);
  }
  console.log(JSON.stringify({ scorerGuardChecks: 6, passed: true, scope: 'Scorer behavior only; no model answers were scored.' }));
} else {
  const answers = JSON.parse(await readFile(path.join(base, 'answers.json'), 'utf8'));
  if (!Array.isArray(answers.answers)) throw Error('answers.json needs {answers:[{caseId,answer}]} with raw model answers.');
  const results = oracle.cases.map(expected => ({ caseId: expected.caseId, ...score(expected, answers.answers.find(item => item.caseId === expected.caseId)?.answer) }));
  const report = { at: new Date().toISOString(), passed: results.every(item => item.passed), cases: results,
    configuration: answers.configuration || null,
    limits: ['Two synthetic client reports, one inference per input. No baseline or generalized performance claim.',
      'Deterministic checks cover calculations, scope, exact source references and missing-revenue abstention. Free prose requires separate human or independent semantic review.',
      'Model text alone does not authorize sending, attest to receipt, or certify the report for other clients.'] };
  await writeFile(path.join(base, 'score.json'), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
