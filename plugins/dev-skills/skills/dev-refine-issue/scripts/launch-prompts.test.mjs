// Fixtures A and B show the launch-prompt form of SKILL.md: the /goal completion condition names only the ACs
// shown at the PR head, review and owner ACs are handed on with their stage, and a named owner gate ends the goal
// once its question is posted. Run with `npm test` from the plugin root; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { issueFacts } from '../../dev-batch/scripts/facts.mjs';
import { stagePrompt } from '../../dev-batch/scripts/prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REFINEMENT = join(here, 'check-refinement.mjs');
const PUBLICATION = join(here, '..', '..', '..', 'scripts', 'check-publication.mjs');
const REPO = 'example-org/example-repo';
const LOGIN = 'bot-user';

const fixture = (name, issue, comment) => {
  const paths = { body: join(here, 'fixtures', `${name}-issue-body.md`), task: join(here, 'fixtures', `${name}-task-comment.md`) };
  return {
    name, issue, comment, paths, body: readFileSync(paths.body, 'utf8'), task: readFileSync(paths.task, 'utf8'),
    permalink: `https://github.com/${REPO}/issues/${issue}#issuecomment-${comment}`,
  };
};
const A = fixture('a', 101, 9101);
const B = fixture('b', 102, 9102);

// The only line of the first fenced block after the line that starts with `label`.
function prompt(body, label) {
  const lines = body.split('\n');
  const from = lines.findIndex((line) => line.startsWith(label));
  const open = lines.findIndex((line, i) => i > from && line.startsWith('```'));
  assert.ok(from >= 0 && open > from, `no fenced block under ${label}`);
  assert.equal(lines[open + 2], '```', `the block under ${label} holds one line`);
  return lines[open + 1];
}
const goalOf = (f) => prompt(f.body, '**Goal prompt**');
const plainOf = (f) => prompt(f.body, '**Plain-language prompt**');

// The fixed parts of either prompt: the PR-head part, the stop part and the handed-on part.
function parts(text) {
  const m = /Continue until (.+?) holds? at its head, or, (at .+?, until its question is posted on issue #\d+)\. Handed on, not goal conditions: (.+)\.$/.exec(text);
  assert.ok(m, `no fixed parts in: ${text}`);
  return { atHead: m[1], stop: m[2], handedOn: m[3] };
}
const ids = (text) => text.match(/\bAC-\d+\b/g) ?? [];

// [id, stage] for every AC in the task comment's operative block, from its `Shown at:` ending.
function stages(task) {
  const block = task.split('<!-- acs:begin -->')[1].split('<!-- acs:end -->')[0];
  return [...block.matchAll(/^- \*\*(AC-\d+)\*\*.*$/gm)].map(([line, id]) => [id, /Shown at: (PR head|review|owner)\.$/.exec(line)?.[1]]);
}
const atStage = (f, pick) => stages(f.task).filter(([, stage]) => pick(stage)).map(([id]) => id);

test('AC-1 (b): fixture A names its PR-head AC in the completion condition and its review and owner ACs only as handed on', () => {
  assert.deepEqual(stages(A.task), [['AC-1', 'PR head'], ['AC-2', 'review'], ['AC-3', 'owner']]);
  const { atHead, stop, handedOn } = parts(goalOf(A));
  assert.deepEqual(ids(atHead), atStage(A, (s) => s === 'PR head'));
  assert.deepEqual(ids(stop), []);
  assert.deepEqual(ids(handedOn), atStage(A, (s) => s !== 'PR head'));
  assert.equal(handedOn, 'AC-2 (review), AC-3 (owner)');
});

test('AC-1 (c): fixture A\'s plain-language prompt has the same completion condition and handed-on part', () => {
  assert.deepEqual(parts(plainOf(A)), parts(goalOf(A)));
  assert.ok(plainOf(A).startsWith(`Execute from ${A.permalink}. `));
});

test('AC-2 (b): fixture B\'s goal ends once owner gate G1\'s question is posted on the issue, in both prompts', () => {
  assert.ok(B.task.includes('Owner gate G1:'), 'the task comment names the gate');
  const goal = parts(goalOf(B));
  assert.equal(goal.stop, 'at owner gate G1 or another stop condition, until its question is posted on issue #102');
  assert.deepEqual(ids(goal.atHead), atStage(B, (s) => s === 'PR head'));
  assert.deepEqual(ids(goal.handedOn), atStage(B, (s) => s !== 'PR head'));
  assert.deepEqual(parts(plainOf(B)), goal);
  // A fixture without a named gate keeps only the generic stop.
  assert.equal(parts(goalOf(A)).stop, 'at a stop condition, until its question is posted on issue #101');
});

test('AC-3 (a): each fixture is a body with this skill\'s AUTO region and its task comment, on example-org/example-repo, with no unfilled slot', () => {
  for (const f of [A, B]) {
    assert.match(f.body, /^<!-- AUTO:BEGIN -->\n<!-- dev-refine-issue:body -->$/m);
    for (const text of [f.body, f.task]) {
      for (const [, repo] of text.matchAll(/github\.com\/([^/\s]+\/[^/\s#)]+)/g)) assert.equal(repo, REPO);
      assert.doesNotMatch(text, /<(?!!--)/, `${f.name}: a template slot is left`);
    }
  }
});

test('AC-3 (b): acs, outgoing and the publication check exit 0 on each fixture', () => {
  const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
  for (const f of [A, B]) {
    const runs = [
      node(REFINEMENT, 'acs', '--issue-body', f.paths.body, '--task', f.paths.task),
      node(REFINEMENT, 'outgoing', '--body', f.paths.task, '--repo', REPO, '--issue', String(f.issue), '--revision', '1'),
      node(PUBLICATION, '--body-file', f.paths.body),
      node(PUBLICATION, '--body-file', f.paths.task),
    ];
    for (const run of runs) assert.equal(run.status, 0, `${f.name}: ${run.stdout}${run.stderr}`);
  }
});

test('AC-4 (a): dev-batch\'s issueFacts reads each fixture\'s /goal line verbatim, and the implement stage launches it', () => {
  for (const f of [A, B]) {
    const node = {
      authorAssociation: 'OWNER', editor: null, body: f.body, labels: { nodes: [] },
      comments: { totalCount: 1, nodes: [{ databaseId: f.comment, body: f.task, authorAssociation: 'OWNER', createdAt: '2026-01-01T10:00:00Z', url: f.permalink, author: { login: LOGIN } }] },
      closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] },
    };
    const facts = issueFacts({ repo: REPO, repository: { [`issue_${f.issue}`]: node }, extra: {} }, f.issue, { repo: REPO, login: LOGIN });
    assert.equal(facts.task.action, 'use-current');
    assert.equal(facts.task.commentId, f.comment);
    assert.equal(facts.goal, goalOf(f));
    assert.ok(facts.goal.startsWith(`/goal Execute from ${f.permalink}. `));
    assert.equal(stagePrompt({ stage: 'implement', goal: facts.goal }), facts.goal);
  }
});
