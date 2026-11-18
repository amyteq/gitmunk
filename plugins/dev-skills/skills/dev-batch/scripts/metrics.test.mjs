import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { batchSummary, sessionRecord, summarizeTranscript } from './metrics.mjs';

const read = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8').split('\n');
const main = read('transcript-main.jsonl');

test('duplicate message ids count once with the field maxima', () => {
  const s = summarizeTranscript(main, []);
  assert.equal(s.requests, 2);
  assert.deepEqual(s.tokens, { input: 30, output: 55, cacheWrite: 100, cacheRead: 4000 });
  assert.equal(s.peakContext, 20 + 3000);
  assert.deepEqual(s.models, ['claude-opus-x']);
  assert.equal(s.activeSeconds, 60); // gap between the two requests; the synthetic and truncated lines add nothing
  assert.equal(s.startedAt, '2026-01-01T10:00:00Z');
});

test('subagent usage is added', () => {
  const s = summarizeTranscript(main, [read('transcript-sub.jsonl')]);
  assert.equal(s.requests, 3);
  assert.equal(s.tokens.input, 37);
  assert.equal(s.tokens.cacheRead, 4500);
});

test('compactions and goal checks are read', () => {
  const s = summarizeTranscript(main, []);
  assert.deepEqual(s.compactions, [{ at: '2026-01-01T10:01:30Z', trigger: 'auto', pre: 300000, post: 20000 }]);
  assert.deepEqual(s.goal, { met: 1, notMet: 1 });
  assert.equal(s.costUsd, 2.5);
  assert.equal(s.rateLimits, 1);
  assert.equal(s.apiErrors, 0);
  assert.equal(s.denials, 1);
});

test('no cost-state -> costUsd null', () => {
  assert.equal(summarizeTranscript(read('transcript-sub.jsonl'), []).costUsd, null);
});

test('sessionRecord carries the session, row and settings fields', () => {
  const r = sessionRecord({ session: { name: 'x-i1a', stage: 'implement', id: 'sid', account: 'A1' }, row: { issue: 1, pr: 2 }, settings: { effort: 'xhigh', autocompact: '300k' }, summary: summarizeTranscript(main, []), outcome: 'fact reached' });
  assert.equal(r.task, 1); assert.equal(r.pr, 2); assert.equal(r.effort, 'xhigh'); assert.equal(r.tokens.output, 55); assert.equal(r.outcome, 'fact reached');
});

test('batch summary: mean and median per stage; cost per merged PR', () => {
  const ev = (at, type, task, stage) => ({ at: `2026-01-01T${at}Z`, type, task, stage });
  const events = [
    ev('10:00:00', 'launch', 'i1', 'refine'), ev('10:10:00', 'stage-done', 'i1', 'refine'),
    ev('10:00:00', 'launch', 'i2', 'refine'), ev('10:30:00', 'stage-done', 'i2', 'refine'),
    ev('10:00:00', 'launch', 'i3', 'refine'), ev('11:00:00', 'stage-done', 'i3', 'refine'),
    ev('12:00:00', 'launch', 'i1', 'merge'), ev('12:10:00', 'stage-done', 'i1', 'merge'),
    ev('12:00:00', 'launch', 'i2', 'merge'), ev('12:20:00', 'stage-done', 'i2', 'merge'),
  ];
  const rec = (stage, cost, goal = { met: 0, notMet: 0 }) => ({ stage, costUsd: cost, goal, compactions: [], tokens: { cacheRead: 10 } });
  const s = batchSummary(events, [rec('implement', 10, { met: 1, notMet: 2 }), rec('review', 5), rec('implement', 3)]);
  assert.deepEqual(s.stages.refine, { mean: 2000, median: 1800 });
  assert.deepEqual(s.stages.merge, { mean: 900, median: 900 });
  assert.equal(s.costPerMergedPr, 9);
  assert.equal(s.measures.implementSessionsGoalMet, 1);
  assert.equal(s.measures.refineToLastMerge.mean, (2 * 3600 + 10 * 60 + 2 * 3600 + 20 * 60) / 2);
});
