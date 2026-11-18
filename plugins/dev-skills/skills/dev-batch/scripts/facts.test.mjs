import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { factsQuery, fetchFacts, issueFacts, GithubUnavailable } from './facts.mjs';

const REPO = 'example-org/example-repo';
const LOGIN = 'bot-user';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const base = () => JSON.parse(readFileSync(new URL('./fixtures/facts-base.json', import.meta.url), 'utf8'));
// raw as fetchFacts returns it, after the test has edited the issue node.
const build = (edit = () => {}) => {
  const res = base();
  edit(res.data.repository.issue_41);
  return { repo: REPO, repository: res.data.repository, extra: {} };
};
const facts = (raw, opts = {}) => issueFacts(raw, 41, { repo: REPO, login: LOGIN, rounds: 10, sessionWindows: [], ...opts });
const comment = (body, over = {}) => ({ databaseId: 9, body, authorAssociation: 'OWNER', createdAt: '2026-01-03T00:00:00Z', url: 'https://github.com/example-org/example-repo/issues/41#issuecomment-9', author: { login: LOGIN }, ...over });
const report = (round, phase, verdict, head = SHA1, at = '2026-01-03T00:00:00Z') => ({
  body: `<!-- dev-review-pr: RUN1 round=${round} phase=${phase} -->\nReviewed head: [x](https://github.com/example-org/example-repo/commit/${head})\nBase: [y](https://github.com/example-org/example-repo/commit/${SHA2})\nVerdict: ${verdict}`,
  authorAssociation: 'OWNER', createdAt: at, url: `https://github.com/example-org/example-repo/pull/50#issuecomment-${round}`, author: { login: LOGIN },
});
const pr = (node) => node.closedByPullRequestsReferences.nodes[0];

test('ready verdict at the current revision', () => {
  const f = facts(build());
  assert.equal(f.verdict.state, 'ready');
  assert.equal(f.verdict.revision, 1);
  assert.equal(f.task.action, 'use-current');
});

test('a verdict from an untrusted, non-own login is ignored', () => {
  const f = facts(build((n) => {
    n.comments.nodes[1].author.login = 'stranger';
    n.comments.nodes[1].authorAssociation = 'NONE';
  }));
  assert.equal(f.verdict, null);
});

test('goal line', () => {
  const f = facts(build());
  assert.match(f.goal, /^\/goal Execute from https:\/\/github\.com\/example-org\/example-repo\/issues\/41#issuecomment-1\. /);
  assert.equal(facts(build((n) => { n.body = 'Prose\n/goal outside the region\n'; })).goal, null);
});

test('PR by another login is not the task\'s PR', () => {
  assert.equal(facts(build((n) => { pr(n).author.login = 'someone-else'; })).pr, null);
  assert.equal(facts(build()).pr.number, 50);
});

test('approval-eligible at head, stale after a new push', () => {
  const raw = build((n) => { pr(n).comments.nodes.push(report(1, 'final-review', 'approval-eligible')); });
  assert.equal(facts(raw).pr.evidence.ok, true);
  pr(raw.repository.issue_41).headRefOid = SHA2;
  assert.equal(facts(raw).pr.evidence.ok, false);
});

test('review round from the latest dev-review-pr marker', () => {
  const f = facts(build((n) => {
    pr(n).comments.nodes.push(report(1, 'review', 'continue'), report(2, 'writer', 'continue', SHA1, '2026-01-03T02:00:00Z'));
  }));
  assert.equal(f.pr.round, 2);
  assert.equal(f.pr.phase, 'writer');
  assert.equal(f.pr.reviewEnded, null);
});

test('a blocked reviewer report ends the review', () => {
  const f = facts(build((n) => { pr(n).comments.nodes.push(report(3, 'review', 'blocked')); }));
  assert.equal(f.pr.reviewEnded, 'blocked');
});

test('checks: PENDING pending, SUCCESS and FAILURE done, null none', () => {
  const at = (state) => facts(build((n) => { pr(n).statusCheckRollup = state && { state }; })).pr.checks;
  assert.deepEqual(['PENDING', 'SUCCESS', 'FAILURE', null].map(at), ['pending', 'done', 'done', 'none']);
});

test('owner answer: only an unmarked comment outside every session window counts', () => {
  const question = comment(`<!-- dev-batch:owner issue=41 -->\nWhich one?`, { databaseId: 10, createdAt: '2026-01-02T00:00:00Z' });
  const answer = comment('Take option B.', { databaseId: 11, createdAt: '2026-01-02T05:00:00Z' });
  const raw = build((n) => { n.comments.nodes.push(question, answer); n.comments.totalCount = 4; });
  const f = facts(raw);
  assert.equal(f.ownerQuestion.at, '2026-01-02T00:00:00Z');
  assert.deepEqual(f.ownerAnswer, { at: '2026-01-02T05:00:00Z' });
  const during = facts(raw, { sessionWindows: [{ from: '2026-01-02T04:00:00Z', to: '2026-01-02T06:00:00Z' }] });
  assert.equal(during.ownerAnswer, null);
  const open = facts(raw, { sessionWindows: [{ from: '2026-01-02T04:00:00Z', to: null }] });
  assert.equal(open.ownerAnswer, null);
});

test('lastActivity is the newest of issue comments, PR comments, reviews and the head commit', () => {
  assert.equal(facts(build()).lastActivity, '2026-01-02T09:00:00Z');
  const f = facts(build((n) => { pr(n).reviews.nodes.push({ state: 'COMMENTED', submittedAt: '2026-01-05T00:00:00Z', authorAssociation: 'OWNER', author: { login: 'r' }, commit: { oid: SHA1 } }); }));
  assert.equal(f.lastActivity, '2026-01-05T00:00:00Z');
  assert.equal(f.pr.lastActivity, '2026-01-05T00:00:00Z');
});

test('factsQuery aliases every issue and carries owner and name as variables', () => {
  const { query, variables } = factsQuery(REPO, [41, 42]);
  assert.match(query, /issue_41: issue\(number: 41\)/);
  assert.match(query, /issue_42: issue\(number: 42\)/);
  assert.match(query, /committedDate/);
  assert.deepEqual(variables, { owner: 'example-org', name: 'example-repo' });
});

test('fetchFacts passes variables with -f, paginates an overflowing comment list, and throws on a gh failure', () => {
  const calls = [];
  const overflow = base();
  overflow.data.repository.issue_41.comments.totalCount = 101;
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'graphql') return { code: 0, stdout: JSON.stringify(overflow), stderr: '' };
    return { code: 0, stdout: JSON.stringify([[{ id: 7, user: { login: LOGIN }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00Z', body: 'x', html_url: 'u' }]]), stderr: '' };
  };
  const raw = fetchFacts({ repo: REPO, issues: [41], gh });
  assert.deepEqual(calls[0].slice(-4), ['-f', 'owner=example-org', '-f', 'name=example-repo']);
  assert.deepEqual(calls[1], ['api', '--paginate', '--slurp', `repos/${REPO}/issues/41/comments`]);
  assert.equal(raw.extra[41][0].id, 7);
  assert.throws(() => fetchFacts({ repo: REPO, issues: [41], gh: () => ({ code: 1, stdout: '', stderr: 'rate limit' }) }), GithubUnavailable);
  assert.throws(() => fetchFacts({ repo: REPO, issues: [41], gh: () => ({ code: 0, stdout: '{"errors":[{"message":"boom"}]}', stderr: '' }) }), GithubUnavailable);
});
