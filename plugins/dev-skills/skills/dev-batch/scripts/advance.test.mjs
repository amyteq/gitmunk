import assert from 'node:assert/strict';
import test from 'node:test';
import { advance, dispatchable, dispatchOrder, layers } from './advance.mjs';

const row = (n, issue, over = {}) => ({ n, issue, title: `Task ${issue}`, deps: [], batch: 1, status: 'queued', pr: null, head: null, session: null, next: '', ...over });
const tasks = (map) => Object.entries(map).map(([issue, deps]) => ({ issue: Number(issue), deps }));

test('layers: B1 has no deps in the batch, deps outside the batch are met', () => {
  assert.deepEqual(Object.fromEntries(layers(tasks({ 41: [], 42: [41], 43: [], 44: [42, 43] })).batches), { 41: 1, 42: 2, 43: 1, 44: 3 });
  assert.deepEqual([...layers(tasks({ 5: [99] })).batches], [[5, 1]]);
});

test('a cycle is named', () => {
  assert.deepEqual(layers(tasks({ 1: [2], 2: [1] })), { cycle: [1, 2] });
  assert.deepEqual(layers(tasks({ 1: [2], 2: [3], 3: [2], 4: [1] })), { cycle: [2, 3] });
});

test('batch is priority, not a barrier', () => {
  const rows = [row(1, 41, { status: 'reviewing', pr: 5 }), row(2, 42, { deps: [41], batch: 2, status: 'waiting' }), row(3, 43)];
  const by = new Map(rows.map((r) => [r.issue, r]));
  assert.equal(dispatchable(rows[1], by, new Set([41])), true);
  assert.equal(dispatchable(rows[1], by, new Set()), false);
  assert.equal(dispatchable(rows[0], by, new Set()), false); // already in review
});

test('order: (B1, row 3) comes before (B2, row 1)', () => {
  const rows = [row(1, 41, { batch: 2 }), row(2, 42, { batch: 1 }), row(3, 43, { batch: 1 })];
  assert.deepEqual(dispatchOrder(rows).map((r) => r.n), [2, 3, 1]);
});

test('order: issue priority first, unlabelled ranks as P2, then Batch and row', () => {
  const rows = [row(1, 41), row(2, 42, { batch: 3, priority: 0 }), row(3, 43, { priority: 3 }), row(4, 44, { batch: 2, priority: 1 }),
    row(5, 45, { priority: 2 }), row(6, 46, { priority: null })];
  assert.deepEqual(dispatchOrder(rows).map((r) => r.n), [2, 4, 1, 5, 6, 3]);
});

test('dispatchable: a dep outside the batch is met, a merged row is met, an unmerged row is not', () => {
  const rows = [row(1, 41, { status: 'merged' }), row(2, 42, { status: 'reviewing' }), row(3, 43, { deps: [99] }), row(4, 44, { deps: [41] }), row(5, 45, { deps: [42] })];
  const by = new Map(rows.map((r) => [r.issue, r]));
  assert.equal(dispatchable(rows[2], by, new Set()), true); // (a) no row for 99
  assert.equal(dispatchable(rows[3], by, new Set()), true); // (b) row merged
  assert.equal(dispatchable(rows[4], by, new Set()), false); // (c) row reviewing
});

// ---- The stage state machine (§9–§12) ----

const T = (h, m = 0) => `2026-11-18T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const URL = 'https://github.com/example-org/example-repo/issues/41#issuecomment-9';
const DECISION = `[decision on #41](${URL})`;
const QUESTION = { ownerQuestion: { url: URL, at: T(10, 30) } };
const verdict = (state) => ({ task: { action: 'use-current', revision: 2 }, verdict: { revision: 2, state, at: T(10, 30) } });
const GOAL = '/goal Execute from https://github.com/example-org/example-repo/issues/41#issuecomment-1.';
const READY = { ...verdict('ready'), goal: GOAL };
const prFacts = (over = {}) => ({ ...READY, pr: { number: 55, state: 'OPEN', merged: false, head: `9b0e7d3${'a'.repeat(33)}`, checks: 'done',
  evidence: { ok: false }, round: null, phase: null, reviewEnded: null, lastActivity: T(11), ...over } });
const APPROVED = prFacts({ evidence: { ok: true } });
const MERGED = prFacts({ state: 'MERGED', merged: true, evidence: { ok: true } });
const ses = (name, stage, state, over = {}) => ({ name, stage, state, startedAt: T(10), endedAt: null, attempt: 1, ...over });
const launch = (stage, attempt = 1) => ({ type: 'launch', stage, attempt });
const stop = (session) => ({ type: 'stop', session });
const event = (kind, judgment) => ({ type: 'event', kind, judgment });
const LOCK = { type: 'lock' };
const UNLOCK = { type: 'unlock' };
const at = (status, next = '') => ({ status, next });

// [name, input, expected]. Input defaults: issue #41, merge=auto, rounds=10, authorized, lock free, now 12:00.
// Expected `next` defaults to '' and `actions` to []; an event's free-text detail is checked apart.
const cases = [
  // queued
  ['queued without a current task → refine', { row: at('queued') }, { status: 'refining', actions: [launch('refine')] }],
  ['queued with a current task and a ready verdict → implement, no refine (§9 already-refined)',
    { row: at('queued'), facts: READY }, { status: 'implementing', actions: [launch('implement')] }],
  // refine
  ['refine working → wait', { row: at('refining'), sessions: [ses('er-i41r', 'refine', 'working')] }, { status: 'refining' }],
  ['refine done, verdict ready → stop it, implement', { row: at('refining'), facts: READY, sessions: [ses('er-i41r', 'refine', 'done')] },
    { status: 'implementing', actions: [stop('er-i41r'), launch('implement')] }],
  ['refine done, verdict owner → 👤, next is the question link', { row: at('refining'), facts: { ...verdict('owner'), ...QUESTION }, sessions: [ses('er-i41r', 'refine', 'done')] },
    { status: 'owner', next: DECISION, actions: [stop('er-i41r'), event('owner-question', false)] }],
  ['refine done, verdict not-ready → ⛔, judgment', { row: at('refining'), facts: verdict('not-ready'), sessions: [ses('er-i41r', 'refine', 'done')] },
    { status: 'blocked', next: 'refine: not ready', actions: [stop('er-i41r'), event('refine-not-ready', true)] }],
  ['queued, ready verdict but no /goal line → ⛔, judgment, no implement launch', { row: at('queued'), facts: verdict('ready') },
    { status: 'blocked', next: 'ready verdict without a /goal line', actions: [event('stage-failed', true)] }],
  ['refine done, ready verdict but no /goal line → stop it, ⛔, judgment', { row: at('refining'), facts: verdict('ready'), sessions: [ses('er-i41r', 'refine', 'done')] },
    { status: 'blocked', next: 'ready verdict without a /goal line', actions: [stop('er-i41r'), event('stage-failed', true)] }],
  ['a limited implement session whose /goal line is gone → ⛔, no relaunch', { row: at('implementing'), facts: verdict('ready'), sessions: [ses('er-i41a', 'implement', 'limited')] },
    { status: 'blocked', next: 'ready verdict without a /goal line', actions: [event('stage-failed', true)] }],
  ['… raised once', { row: at('blocked', 'ready verdict without a /goal line'), facts: verdict('ready') }, { status: 'blocked', next: 'ready verdict without a /goal line' }],
  // implement
  ['implement: open PR by the login and the session done → stop it, review',
    { row: at('implementing'), facts: prFacts(), sessions: [ses('er-i41r', 'refine', 'stopped'), ses('er-i41a', 'implement', 'done')] },
    { status: 'reviewing', pr: 55, head: '9b0e7d3', actions: [stop('er-i41a'), launch('review')] }],
  ['implement: open PR while the session still works → wait', { row: at('implementing'), facts: prFacts(), sessions: [ses('er-i41a', 'implement', 'working')] },
    { status: 'implementing' }],
  // review
  ['review working → next shows the round', { row: at('reviewing'), facts: prFacts({ round: 2 }), sessions: [ses('er-pr55', 'review', 'working')] },
    { status: 'reviewing', next: 'round 2 of 10' }],
  ['review: approval-eligible at head, checks done, merge=auto, lock free → lock, merge',
    { row: at('reviewing'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'done')] },
    { status: 'merging', actions: [stop('er-pr55'), LOCK, launch('merge')] }],
  ['review: approval-eligible, checks pending → wait for the checks', { row: at('reviewing'), facts: prFacts({ evidence: { ok: true }, checks: 'pending' }), sessions: [ses('er-pr55', 'review', 'done')] },
    { status: 'reviewing', next: 'waiting for checks to finish', actions: [stop('er-pr55')] }],
  ['review: approval-eligible, merge=off → 👤 waiting for merge authorization', { row: at('reviewing'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'done')], settings: { merge: 'off' } },
    { status: 'owner', next: 'waiting for merge authorization', actions: [stop('er-pr55')] }],
  ['review: approval-eligible, another row holds the merge lock → wait, no event', { row: at('reviewing'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'done')], mergeLock: 'held' },
    { status: 'reviewing', next: 'waiting for the merge lock', actions: [stop('er-pr55')] }],
  ['waiting for the merge lock, lock free now → lock, merge', { row: at('reviewing', 'waiting for the merge lock'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'stopped')] },
    { status: 'merging', actions: [LOCK, launch('merge')] }],
  ['review ended blocked → ⛔, judgment', { row: at('reviewing'), facts: prFacts({ reviewEnded: 'blocked' }), sessions: [ses('er-pr55', 'review', 'done')] },
    { status: 'blocked', next: 'review ended blocked', actions: [event('review-blocked', true)] }],
  ['review ended budget-exhausted → ⛔, judgment', { row: at('reviewing'), facts: prFacts({ reviewEnded: 'budget-exhausted' }), sessions: [ses('er-pr55', 'review', 'done')] },
    { status: 'blocked', next: 'review ended budget-exhausted', actions: [event('review-budget-exhausted', true)] }],
  // a new head after approval (§9)
  ['a new head after approval → back to review, attempts start over', { row: at('reviewing', 'waiting for checks to finish'), facts: prFacts(), sessions: [ses('er-pr552', 'review', 'stopped', { attempt: 2 })] },
    { status: 'reviewing', actions: [launch('review')] }],
  ['a new head while merging → unlock, back to review', { row: at('merging'), facts: prFacts(), sessions: [ses('er-pr55', 'review', 'stopped'), ses('er-pr55m', 'merge', 'done')], mergeLock: 'mine' },
    { status: 'reviewing', actions: [UNLOCK, launch('review')] }],
  // merge
  ['merge working → wait, keep the lock', { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'working')], mergeLock: 'mine' }, { status: 'merging' }],
  ['merging without a session, lock already held by this row → launch, no second lock', { row: at('merging'), facts: APPROVED, mergeLock: 'mine' },
    { status: 'merging', actions: [launch('merge')] }],
  ['merged → ✅, unlock, stop the merge session', { row: at('merging'), facts: MERGED, sessions: [ses('er-pr55', 'review', 'stopped'), ses('er-pr55m', 'merge', 'done')], mergeLock: 'mine' },
    { status: 'merged', actions: [stop('er-pr55m'), UNLOCK] }],
  ['merge session blocked → ⛔, judgment, the lock stays with the live session', { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'blocked')], mergeLock: 'mine' },
    { status: 'blocked', next: 'er-pr55m needs input', actions: [event('session-blocked', true)] }],
  ['merge session limited → relaunch the merge, keep the lock', { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'limited')], mergeLock: 'mine' },
    { status: 'merging', actions: [launch('merge')] }],
  ['merge session limited, not authorized → no relaunch, the lock stays with the live session',
    { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'limited')], mergeLock: 'mine', authorized: false },
    { status: 'owner', next: 'waiting for the owner\'s authorization', actions: [event('authorization-missing', false)] }],
  ['merge session limited, merge=off since → no replacement, 👤 waiting for merge authorization (C24)',
    { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'limited')], mergeLock: 'mine', settings: { merge: 'off' } },
    { status: 'owner', next: 'waiting for merge authorization' }],
  ['merged while dev-merge still closes out → ✅, unlock, the working session is not stopped', { row: at('merging'), facts: MERGED, sessions: [ses('er-pr55m', 'merge', 'working')], mergeLock: 'mine' },
    { status: 'merged', actions: [UNLOCK] }],
  ['merged while dev-merge still closes out, lock free → no lock taken', { row: at('merging'), facts: MERGED, sessions: [ses('er-pr55m', 'merge', 'working')] },
    { status: 'merged' }],
  ['merged, merge session unknown → ✅, unlock, no stop', { row: at('merging'), facts: MERGED, sessions: [ses('er-pr55m', 'merge', 'unknown')], mergeLock: 'mine' },
    { status: 'merged', actions: [UNLOCK] }],
  ['dev-merge stops (session ended, PR open) → stays 🔀, unlock, judgment, no retry', { row: at('merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'done')], mergeLock: 'mine' },
    { status: 'merging', next: 'merge stopped: er-pr55m ended without merging', actions: [UNLOCK, event('merge-stopped', true)] }],
  ['… and the next tick raises nothing and launches nothing', { row: at('merging', 'merge stopped: er-pr55m ended without merging'), facts: APPROVED, sessions: [ses('er-pr55m', 'merge', 'stopped')] },
    { status: 'merging', next: 'merge stopped: er-pr55m ended without merging' }],
  // attempts, stall and session states
  ['a session done without its fact, attempt 1 → relaunch as attempt 2', { row: at('implementing'), facts: READY, sessions: [ses('er-i41a', 'implement', 'done')] },
    { status: 'implementing', actions: [launch('implement', 2)] }],
  ['attempt 2 done without its fact → ⛔, stage-failed', { row: at('implementing'), facts: READY, sessions: [ses('er-i41a', 'implement', 'failed'), ses('er-i41a2', 'implement', 'done', { attempt: 2 })] },
    { status: 'blocked', next: 'implement failed 2 attempts (er-i41a2)', actions: [event('stage-failed', true)] }],
  ['4 h without GitHub progress while working → ⛔, stall', { row: at('implementing'), facts: { ...READY, lastActivity: T(7, 59) }, sessions: [ses('er-i41a', 'implement', 'working', { startedAt: T(7) })] },
    { status: 'blocked', next: 'stalled: no GitHub progress for 4 h (er-i41a)', actions: [event('stall', true)] }],
  ['under 4 h since the last progress → wait', { row: at('implementing'), facts: { ...READY, lastActivity: T(8, 1) }, sessions: [ses('er-i41a', 'implement', 'working', { startedAt: T(7) })] },
    { status: 'implementing' }],
  ['issue activity from before the session started does not start the stall clock',
    { row: at('implementing'), facts: { ...READY, lastActivity: '2026-11-10T00:00:00Z' }, sessions: [ses('er-i41a', 'implement', 'working', { startedAt: T(11) })] }, { status: 'implementing' }],
  ['session blocked (needs input) → ⛔, judgment', { row: at('implementing'), facts: READY, sessions: [ses('er-i41a', 'implement', 'blocked')] },
    { status: 'blocked', next: 'er-i41a needs input', actions: [event('session-blocked', true)] }],
  ['session limited → relaunch the stage, attempt not counted (§12)', { row: at('implementing'), facts: READY, sessions: [ses('er-i41a', 'implement', 'failed'), ses('er-i41a2', 'implement', 'limited', { attempt: 2 })] },
    { status: 'implementing', actions: [launch('implement', 2)] }],
  ['session unknown → no launch, no stop, status kept (Review Focus 3)', { row: at('implementing'), facts: READY, sessions: [ses('er-i41r', 'refine', 'done'), ses('er-i41a', 'implement', 'unknown')] },
    { status: 'implementing' }],
  ['queued, the stage session unknown → stays queued', { row: at('queued'), facts: READY, sessions: [ses('er-i41a', 'implement', 'unknown')] }, { status: 'queued' }],
  ['⛔ stays until the coordinator decides', { row: at('blocked', 'implement failed 2 attempts (er-i41a2)'), facts: READY, sessions: [ses('er-i41a2', 'implement', 'done', { attempt: 2 })] },
    { status: 'blocked', next: 'implement failed 2 attempts (er-i41a2)' }],
  // authority (§11)
  ['not authorized → no launch; 👤 waiting for the owner\'s authorization', { row: at('queued'), facts: READY, authorized: false },
    { status: 'owner', next: 'waiting for the owner\'s authorization', actions: [event('authorization-missing', false)] }],
  ['not authorized → no merge and no lock either', { row: at('reviewing'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'done')], authorized: false },
    { status: 'owner', next: 'waiting for the owner\'s authorization', actions: [stop('er-pr55'), event('authorization-missing', false)] }],
  ['not authorized → a running session goes on', { row: at('implementing'), facts: READY, sessions: [ses('er-i41a', 'implement', 'working')], authorized: false },
    { status: 'implementing' }],
  ['authorization restored → the waiting row launches', { row: at('owner', 'waiting for the owner\'s authorization'), facts: READY },
    { status: 'implementing', actions: [launch('implement')] }],
  ['merge=auto granted → the 👤 merge row merges', { row: at('owner', 'waiting for merge authorization'), facts: APPROVED, sessions: [ses('er-pr55', 'review', 'stopped')] },
    { status: 'merging', actions: [LOCK, launch('merge')] }],
  ['merge=off and the owner merged by hand → ✅', { row: at('owner', 'waiting for merge authorization'), facts: MERGED, settings: { merge: 'off' } }, { status: 'merged' }],
  ['a worker posts an owner question and ends → 👤 with the link, and its idle session is stopped (I4)', { row: at('implementing'), facts: { ...READY, ownerQuestion: { url: URL, at: T(11) } }, sessions: [ses('er-i41a', 'implement', 'done')] },
    { status: 'owner', next: DECISION, actions: [stop('er-i41a'), event('owner-question', false)] }],
  ['an owner reply on a 👤 row → judgment', { row: at('owner', DECISION), facts: { ...READY, ...QUESTION, ownerAnswer: { at: T(11) } } },
    { status: 'owner', next: `owner replied: ${DECISION}`, actions: [event('owner-reply', true)] }],
  ['… raised once', { row: at('owner', `owner replied: ${DECISION}`), facts: { ...READY, ...QUESTION, ownerAnswer: { at: T(11) } } },
    { status: 'owner', next: `owner replied: ${DECISION}` }],
  ['a 👤 question row without a reply waits', { row: at('owner', DECISION), facts: { ...verdict('owner'), ...QUESTION } }, { status: 'owner', next: DECISION }],
  // answered (👤/⛔ → 🆕 by the owner)
  ['answered → re-checks the facts and launches only the missing stage', { row: at('queued'), facts: prFacts(), sessions: [ses('er-i41r', 'refine', 'stopped'), ses('er-i41a', 'implement', 'stopped')] },
    { status: 'reviewing', actions: [launch('review')] }],
  ['answered while the verdict still says owner → refine again with the answer', { row: at('queued'), facts: { ...verdict('owner'), ...QUESTION }, sessions: [ses('er-i41r', 'refine', 'stopped')] },
    { status: 'refining', actions: [launch('refine')] }],
  ['answered while the stage session still works → adopt it, no second session', { row: at('queued'), facts: READY, sessions: [ses('er-i41a', 'implement', 'working', { startedAt: T(11) })] },
    { status: 'implementing' }],
  // left alone
  ['⏸️ hold is left alone', { row: at('hold'), facts: READY }, { status: 'hold' }],
  ['⏭️ removed is left alone', { row: at('removed'), facts: READY, sessions: [ses('er-i41a', 'implement', 'done')] }, { status: 'removed' }],
];

for (const [name, input, expected] of cases) {
  test(`advance: ${name}`, () => {
    const got = advance({
      row: row(1, 41, input.row),
      facts: { task: { action: 'publish-revision-1' }, goal: null, verdict: null, ownerQuestion: null, ownerAnswer: null, pr: null, lastActivity: T(11), ...input.facts },
      sessions: input.sessions ?? [],
      settings: { merge: 'auto', rounds: 10, ...input.settings },
      authorized: input.authorized ?? true,
      mergeLock: input.mergeLock ?? 'free',
      now: T(12),
    });
    const want = { next: '', actions: [], ...expected };
    for (const a of got.actions) if (a.type === 'event') assert.ok(typeof a.detail === 'string' && a.detail.includes('#41'), `event detail: ${a.detail}`);
    const actions = got.actions.map(({ detail, ...a }) => a);
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, k === 'actions' ? actions : got[k]])), want);
  });
}
