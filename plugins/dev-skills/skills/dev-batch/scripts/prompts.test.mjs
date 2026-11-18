import assert from 'node:assert/strict';
import test from 'node:test';
import { appendedScope, coordinatorName, nextFreeName, sessionName, stagePrompt } from './prompts.mjs';

const abbr = 'er';
const settings = { rounds: 10, reviewer: 'codex', writer: 'claude', reviewer_model: 'gpt-x', reviewer_effort: null, writer_model: null, writer_effort: 'high' };

test('names', () => {
  assert.equal(sessionName({ abbr, stage: 'refine', issue: 41 }), 'er-i41r');
  assert.equal(sessionName({ abbr, stage: 'implement', issue: 41 }), 'er-i41a');
  assert.equal(sessionName({ abbr, stage: 'review', pr: 52 }), 'er-pr52');
  assert.equal(sessionName({ abbr, stage: 'merge', pr: 52 }), 'er-pr52m');
  assert.equal(sessionName({ abbr, stage: 'merge', pr: 55, attempt: 2 }), 'er-pr55m2');
  assert.equal(coordinatorName({ abbr, src: { kind: 'issue', number: 40 }, k: 1 }), 'er-i40c');
  assert.equal(coordinatorName({ abbr, src: { kind: 'discussion', number: 40 }, k: 2 }), 'er-d40c2');
  assert.equal(coordinatorName({ abbr, src: { kind: 'comment', id: 9, parent: { kind: 'discussion', number: 7 } } }), 'er-d7c');
  assert.equal(nextFreeName('er-pr55m', new Set(['er-pr55m'])), 'er-pr55m2');
  assert.equal(nextFreeName('er-pr55m', new Set()), 'er-pr55m');
});

test('review prompt', () => {
  assert.equal(stagePrompt({ stage: 'review', pr: 55, settings }), '/dev-review-pr pr=55 10 codex claude');
});

test('merge prompt', () => {
  const p = stagePrompt({ stage: 'merge', pr: 55, issue: 42, authorization: 'merge it', ledgerUrl: 'https://example.test/l' });
  assert.ok(p.startsWith('/dev-merge pr=55 issues=42 cleanup=own -- Squash merge PR #55 under the owner authorization quoted here: "merge it" (https://example.test/l)'));
  assert.ok(p.includes('Leave the dev-batch ledger region between its markers unchanged'));
});

test('refine prompt and scope', () => {
  assert.ok(stagePrompt({ stage: 'refine', issue: 41 }).startsWith('/dev-refine-issue 41\n'));
  const s = appendedScope({ stage: 'refine', issue: 41, settings, authorization: 'go' });
  assert.ok(s.includes('exactly one verdict comment whose first line is <!-- dev-batch:verdict issue=41 revision=<R> state=ready|owner|not-ready -->'));
  assert.ok(s.includes('<!-- dev-batch:owner issue=41 -->') && s.includes('"go"') && s.includes('default in use until the owner changes it'));
});

test('review scope carries models; extra is appended', () => {
  const s = appendedScope({ stage: 'review', issue: 41, settings, authorization: 'go', extra: 'EXTRA' });
  assert.ok(s.includes('reviewer codex: model gpt-x') && s.includes('writer claude: effort high') && s.endsWith('EXTRA'));
  assert.ok(!appendedScope({ stage: 'implement', issue: 41, settings, authorization: 'go' }).includes('verdict'));
});

test('implement prompt is the issue\'s /goal line verbatim', () => {
  assert.equal(stagePrompt({ stage: 'implement', goal: '/goal do it  now' }), '/goal do it  now');
  assert.throws(() => stagePrompt({ stage: 'implement', goal: 'do it' }));
  assert.throws(() => stagePrompt({ stage: 'implement', goal: null }));
});
