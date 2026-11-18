import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createComment, discussionCommentNode, factsQuery, fetchFacts, issueFacts, readSource, sourceKind, sourceUrl, writeSource, GithubUnavailable } from './facts.mjs';

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
const facts = (raw, opts = {}) => issueFacts(raw, 41, { repo: REPO, login: LOGIN, sessions: [], ...opts });
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

test('I3: the /goal line counts only from a trusted author or a last editor who is the login or trusted', () => {
  const untrusted = (editor, more = () => {}) => build((n) => { Object.assign(n, { authorAssociation: 'NONE', editor: editor && { login: editor } }); more(n); });
  assert.equal(facts(untrusted(null)).goal, null); // the author wrote the line themselves
  assert.equal(facts(untrusted('stranger')).goal, null); // edited after the refine session wrote it
  assert.match(facts(untrusted(LOGIN)).goal, /^\/goal Execute from /);
  const member = (n) => { n.comments.nodes.push(comment('Looks good.', { databaseId: 12, author: { login: 'maintainer' }, authorAssociation: 'MEMBER' })); n.comments.totalCount = 3; };
  assert.match(facts(untrusted('maintainer', member)).goal, /^\/goal Execute from /);
});

test('I3: the /goal line must name the current task comment', () => {
  const goal = (url) => facts(build((n) => { n.body = n.body.replace('/goal Execute from https://github.com/example-org/example-repo/issues/41#issuecomment-1.', `/goal Execute from ${url}.`); })).goal;
  assert.equal(goal('https://github.com/example-org/example-repo/issues/41#issuecomment-12'), null);
  assert.equal(goal('https://github.com/example-org/example-repo/issues/40#issuecomment-1'), null);
  assert.match(goal('https://github.com/example-org/example-repo/issues/41#issuecomment-1'), /^\/goal /);
  assert.equal(facts(build((n) => { n.comments.nodes.splice(0, 1); n.comments.totalCount = 1; })).goal, null); // no current task comment
});

test('PR by another login is not the task\'s PR', () => {
  assert.equal(facts(build((n) => { pr(n).author.login = 'someone-else'; })).pr, null);
  assert.equal(facts(build()).pr.number, 50);
});

// ---- PR linkage (C1): the task's own PR, never one that only mentions the issue ----

const LAUNCHED = [{ stage: 'refine', startedAt: '2026-01-01T09:00:00Z', endedAt: '2026-01-01T09:30:00Z' }, { stage: 'implement', startedAt: '2026-01-02T00:00:00Z', endedAt: null }];
const prNode = (number, over = {}) => ({ ...pr(base().data.repository.issue_41), number, ...over });
const xref = (source, willCloseTarget = false) => ({ willCloseTarget, source });

test('C1: a PR that only mentions the issue is not its PR', () => {
  // An old merged PR by the same login that mentions #41: no PR, so the row never turns merged unworked.
  const old = facts(build((n) => {
    n.closedByPullRequestsReferences.nodes = [];
    n.timelineItems.nodes = [xref(prNode(30, { state: 'MERGED', merged: true, createdAt: '2025-12-01T00:00:00Z', mergedAt: '2025-12-02T00:00:00Z' }))];
  }), { sessions: LAUNCHED });
  assert.equal(old.pr, null);
  // An open sibling PR that mentions #41 never replaces #41's own closing PR #50.
  const sibling = facts(build((n) => { n.timelineItems.nodes = [xref(prNode(57, { createdAt: '2026-01-02T10:00:00Z' }))]; }), { sessions: LAUNCHED });
  assert.equal(sibling.pr.number, 50);
  // A PR into another repository is not the task's PR.
  assert.equal(facts(build((n) => { pr(n).baseRepository.nameWithOwner = 'other-org/example-repo'; })).pr, null);
});

test('C1: a cross-referenced PR counts when it will close the issue, or with no closing PR when it came after the implement session started', () => {
  const only = (ref) => build((n) => { n.closedByPullRequestsReferences.nodes = []; n.timelineItems.nodes = [ref]; });
  assert.equal(facts(only(xref(prNode(60), true))).pr.number, 60); // open, and merging it closes #41
  assert.equal(facts(only(xref(prNode(61, { createdAt: '2026-01-02T01:00:00Z' }))), { sessions: LAUNCHED }).pr.number, 61);
  assert.equal(facts(only(xref(prNode(62, { createdAt: '2026-01-01T23:00:00Z' }))), { sessions: LAUNCHED }).pr, null); // before the implement session
  assert.equal(facts(only(xref(prNode(63, { createdAt: '2026-01-02T01:00:00Z' })))).pr, null); // no implement session at all
});

test('C1: a closing PR merged before the row\'s first launch is never taken; the row\'s PR is kept unless closed unmerged', () => {
  const merged = (mergedAt) => build((n) => { Object.assign(pr(n), { state: 'MERGED', merged: true, mergedAt }); });
  assert.equal(facts(merged('2025-12-31T00:00:00Z'), { sessions: LAUNCHED }).pr, null);
  assert.equal(facts(merged('2026-01-03T00:00:00Z')).pr, null); // never launched: any merge came before its first launch
  assert.equal(facts(merged('2026-01-03T00:00:00Z'), { sessions: LAUNCHED }).pr.merged, true);
  // The row already names #50: a newer closing PR does not replace it, and an old merge of #50 is still #50's.
  const newer = build((n) => { n.closedByPullRequestsReferences.nodes.push(prNode(70)); });
  assert.equal(facts(newer, { sessions: LAUNCHED }).pr.number, 70);
  assert.equal(facts(newer, { sessions: LAUNCHED, pr: 50 }).pr.number, 50);
  assert.equal(facts(merged('2025-12-31T00:00:00Z'), { sessions: LAUNCHED, pr: 50 }).pr.number, 50);
  // …unless #50 was closed unmerged.
  const closed = build((n) => { pr(n).state = 'CLOSED'; n.closedByPullRequestsReferences.nodes.push(prNode(70)); });
  assert.equal(facts(closed, { sessions: LAUNCHED, pr: 50 }).pr.number, 70);
  // A mention-only PR the row took while no closing PR existed gives way once the issue's own closing PR appears.
  const later = build((n) => { n.timelineItems.nodes = [xref(prNode(57, { createdAt: '2026-01-02T01:00:00Z' }))]; });
  assert.equal(facts(later, { sessions: LAUNCHED, pr: 57 }).pr.number, 50);
});

test('NB1: a closed issue keeps its own merged closing PR, whenever it merged; otherwise it has no PR', () => {
  const closedBy = (over = {}) => build((n) => {
    Object.assign(n, { state: 'CLOSED', stateReason: 'COMPLETED' });
    Object.assign(pr(n), { state: 'MERGED', merged: true, mergedAt: '2025-12-31T00:00:00Z', ...over });
  });
  const hand = facts(closedBy()); // never launched: the owner merged it by hand
  assert.deepEqual([hand.pr?.number, hand.pr?.merged, hand.closedAs], [50, true, 'completed']);
  assert.equal(facts(closedBy(), { sessions: LAUNCHED }).pr?.number, 50); // merged before the first launch
  assert.equal(facts(closedBy({ author: { login: 'someone-else' } })).pr, null); // closed by another login's PR
  assert.equal(facts(closedBy({ baseRepository: { nameWithOwner: 'other-org/example-repo' } })).pr, null);
  const notPlanned = facts(build((n) => { Object.assign(n, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }); n.closedByPullRequestsReferences.nodes = []; }));
  assert.deepEqual([notPlanned.pr, notPlanned.closedAs], [null, 'not planned']);
  // The launch-time floor stays for cross-references, closed issue or not.
  const mention = build((n) => {
    Object.assign(n, { state: 'CLOSED', stateReason: 'COMPLETED' });
    n.closedByPullRequestsReferences.nodes = [];
    n.timelineItems.nodes = [xref(prNode(30, { state: 'MERGED', merged: true, createdAt: '2025-12-01T00:00:00Z', mergedAt: '2025-12-02T00:00:00Z' }))];
  });
  assert.equal(facts(mention).pr, null);
  // An open issue: a never-launched row still takes no merged PR.
  assert.deepEqual([facts(build((n) => { Object.assign(pr(n), { state: 'MERGED', merged: true, mergedAt: '2026-01-03T00:00:00Z' }); })).pr, facts(build()).closedAs], [null, null]);
});

test('NB1 follow-up: a closed issue prefers its merged closing PR over a kept or newer open one', () => {
  const closed = (fn) => build((n) => { Object.assign(n, { state: 'CLOSED', stateReason: 'COMPLETED' }); fn(n); });
  // A: the row reviews open #60 (kept); the owner merges #61 by hand, which closes the issue.
  const a = closed((n) => { n.closedByPullRequestsReferences.nodes = [prNode(60), prNode(61, { state: 'MERGED', merged: true, mergedAt: '2026-01-03T00:00:00Z' })]; });
  assert.deepEqual([facts(a, { sessions: LAUNCHED, pr: 60 }).pr?.number, facts(a, { sessions: LAUNCHED, pr: 60 }).pr?.merged], [61, true]);
  // B: a row never launched, with merged #50 and a newer open #55 of ours.
  const b = closed((n) => { Object.assign(pr(n), { state: 'MERGED', merged: true, mergedAt: '2025-12-31T00:00:00Z' }); n.closedByPullRequestsReferences.nodes.push(prNode(55)); });
  assert.deepEqual([facts(b).pr?.number, facts(b).pr?.merged], [50, true]);
});

test('NB1 follow-up: only an issue closed as completed (or with no reason) keeps an old merged closing PR', () => {
  const reclosed = (stateReason) => build((n) => {
    Object.assign(n, { state: 'CLOSED', stateReason });
    Object.assign(pr(n), { state: 'MERGED', merged: true, mergedAt: '2025-12-31T00:00:00Z' });
  });
  for (const reason of ['NOT_PLANNED', 'DUPLICATE']) assert.equal(facts(reclosed(reason)).pr, null, reason);
  assert.deepEqual([facts(reclosed('NOT_PLANNED')).closedAs, facts(reclosed(null)).pr?.number, facts(reclosed(null)).closedAs], ['not planned', 50, 'closed']);
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
  const during = facts(raw, { sessions: [{ stage: 'implement', startedAt: '2026-01-02T04:00:00Z', endedAt: '2026-01-02T06:00:00Z' }] });
  assert.equal(during.ownerAnswer, null);
  const open = facts(raw, { sessions: [{ stage: 'implement', startedAt: '2026-01-02T04:00:00Z', endedAt: null }] });
  assert.equal(open.ownerAnswer, null);
  // I4: a session that left `working` before the answer (idle, not stopped) no longer runs.
  const idle = facts(raw, { sessions: [{ stage: 'implement', startedAt: '2026-01-02T04:00:00Z', endedAt: null, idleAt: '2026-01-02T04:30:00Z' }] });
  assert.deepEqual(idle.ownerAnswer, { at: '2026-01-02T05:00:00Z' });
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
  assert.match(query, /baseRepository \{ nameWithOwner \}/);
  assert.match(query, /willCloseTarget/);
  assert.match(query, /\{ body state stateReason /); // NB1
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

// ---- The ledger's source (R8): issue body, discussion body or issue comment ----

const BODY = 'Intro `x` $(rm -rf /) "quoted"\n<!-- dev-batch:ledger v=1 -->\n…\n<!-- /dev-batch:ledger -->\n';
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
// A gh stub that records each call, and the file content of every `body=@<file>` field at call time.
function recorder(reply) {
  const calls = [];
  const gh = (args) => {
    const field = args.find((a) => a.startsWith('body=@'));
    const file = field?.slice('body=@'.length);
    calls.push({ args, file, content: file ? readFileSync(file, 'utf8') : null });
    return reply(args);
  };
  return { gh, calls };
}

test('readSource reads an issue body, an issue comment and a discussion, with the author and association', () => {
  const issue = recorder(() => ok({ body: 'issue text', user: { login: 'someone' }, author_association: 'NONE' }));
  assert.deepEqual(readSource({ repo: REPO, src: { kind: 'issue', number: 40 }, gh: issue.gh }), { body: 'issue text', author: 'someone', association: 'NONE' });
  assert.deepEqual(issue.calls[0].args, ['api', `repos/${REPO}/issues/40`]);

  const comment = recorder(() => ok({ body: 'comment text', user: { login: LOGIN }, author_association: 'OWNER' }));
  assert.deepEqual(readSource({ repo: REPO, src: { kind: 'comment', id: 77, parent: { kind: 'issue', number: 40 } }, gh: comment.gh }),
    { body: 'comment text', author: LOGIN, association: 'OWNER' });
  assert.deepEqual(comment.calls[0].args, ['api', `repos/${REPO}/issues/comments/77`]);

  const disc = recorder(() => ok({ data: { repository: { discussion: { id: 'D_1', body: 'discussion text', authorAssociation: 'MEMBER', author: { login: 'm' } } } } }));
  assert.deepEqual(readSource({ repo: REPO, src: { kind: 'discussion', number: 9 }, gh: disc.gh }), { body: 'discussion text', id: 'D_1', author: 'm', association: 'MEMBER' });
  assert.deepEqual(disc.calls[0].args.slice(-6), ['-f', 'owner=example-org', '-f', 'name=example-repo', '-F', 'number=9']);
});

// ---- Discussion comments, new comments and source kinds (Task 13) ----

const DC = { kind: 'comment', id: 456, parent: { kind: 'discussion', number: 9 }, nodeId: 'DC_1' };

test('a discussion comment is read and written through GraphQL by its node id', () => {
  const read = recorder(() => ok({ data: { node: { body: 'dc text', authorAssociation: 'COLLABORATOR', author: { login: 'c' } } } }));
  assert.deepEqual(readSource({ repo: REPO, src: DC, gh: read.gh }), { body: 'dc text', author: 'c', association: 'COLLABORATOR' });
  assert.match(read.calls[0].args.find((a) => a.startsWith('query=')), /node\(id: \$id\) \{ \.\.\. on DiscussionComment/);
  assert.ok(read.calls[0].args.includes('id=DC_1'));

  const write = recorder(() => ok({ data: { updateDiscussionComment: { comment: { id: 'DC_1' } } } }));
  writeSource({ repo: REPO, src: DC, body: BODY, gh: write.gh });
  assert.equal(write.calls.length, 1);
  assert.match(write.calls[0].args.find((a) => a.startsWith('query=')), /updateDiscussionComment\(input: \{ commentId: \$id, body: \$body \}\)/);
  assert.ok(write.calls[0].args.includes('id=DC_1'));
  assert.equal(write.calls[0].content, BODY);
  assert.ok(!write.calls[0].args.some((a) => a.includes('Intro')));
});

test('createComment posts a new issue or discussion comment through a file and returns it as a source', () => {
  const issue = recorder(() => ok({ id: 900, html_url: `https://github.com/${REPO}/issues/40#issuecomment-900` }));
  assert.deepEqual(createComment({ repo: REPO, parent: { kind: 'issue', number: 40 }, body: BODY, gh: issue.gh }),
    { kind: 'comment', id: 900, parent: { kind: 'issue', number: 40 } });
  assert.deepEqual(issue.calls[0].args.slice(0, 5), ['api', '-X', 'POST', `repos/${REPO}/issues/40/comments`, '-F']);
  assert.equal(issue.calls[0].content, BODY);
  assert.ok(!issue.calls[0].args.some((a) => a.includes('Intro')));

  const disc = recorder((args) => (args.some((a) => a.includes('addDiscussionComment'))
    ? ok({ data: { addDiscussionComment: { comment: { id: 'DC_9', databaseId: 901 } } } })
    : ok({ data: { repository: { discussion: { id: 'D_1', body: 'x' } } } })));
  assert.deepEqual(createComment({ repo: REPO, parent: { kind: 'discussion', number: 9 }, body: BODY, gh: disc.gh }),
    { kind: 'comment', id: 901, parent: { kind: 'discussion', number: 9 }, nodeId: 'DC_9' });
  const add = disc.calls.at(-1);
  assert.ok(add.args.includes('id=D_1'));
  assert.equal(add.content, BODY);

  assert.throws(() => createComment({ repo: REPO, parent: { kind: 'issue', number: 40 }, body: BODY, gh: () => ok({ id: '../x' }) }), GithubUnavailable);
});

test('sourceKind tells an issue, a discussion and a pull request apart, tolerating the other lookup\'s NOT_FOUND', () => {
  const reply = (repository) => () => ({ code: 1, stdout: JSON.stringify({ data: { repository }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }), stderr: 'gh: Could not resolve' });
  assert.equal(sourceKind({ repo: REPO, number: 40, gh: reply({ issueOrPullRequest: { __typename: 'Issue' }, discussion: null }) }), 'issue');
  assert.equal(sourceKind({ repo: REPO, number: 9, gh: reply({ issueOrPullRequest: null, discussion: { id: 'D_1' } }) }), 'discussion');
  assert.equal(sourceKind({ repo: REPO, number: 5, gh: reply({ issueOrPullRequest: { __typename: 'PullRequest' }, discussion: null }) }), 'pull-request');
  assert.equal(sourceKind({ repo: REPO, number: 6, gh: reply({ issueOrPullRequest: null, discussion: null }) }), null);
  assert.throws(() => sourceKind({ repo: REPO, number: 7, gh: () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }) }), GithubUnavailable);
  assert.throws(() => sourceKind({ repo: REPO, number: 7, gh: () => ok({ data: null, errors: [{ type: 'RATE_LIMITED' }] }) }), GithubUnavailable);
});

test('discussionCommentNode pages the discussion\'s comments for the database id', () => {
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [{ id: 'DC_a', databaseId: 1 }] },
    { pageInfo: { hasNextPage: false, endCursor: 'C2' }, nodes: [{ id: 'DC_b', databaseId: 456 }] },
  ];
  const r = recorder((args) => ok({ data: { repository: { discussion: { comments: pages[args.includes('after=C1') ? 1 : 0] } } } }));
  assert.equal(discussionCommentNode({ repo: REPO, number: 9, id: 456, gh: r.gh }), 'DC_b');
  assert.equal(r.calls.length, 2);
  assert.equal(discussionCommentNode({ repo: REPO, number: 9, id: 999, gh: r.gh }), null);
});

test('sourceUrl links every kind of source', () => {
  assert.equal(sourceUrl(REPO, { kind: 'issue', number: 40 }), `https://github.com/${REPO}/issues/40`);
  assert.equal(sourceUrl(REPO, { kind: 'discussion', number: 9 }), `https://github.com/${REPO}/discussions/9`);
  assert.equal(sourceUrl(REPO, { kind: 'comment', id: 77, parent: { kind: 'issue', number: 40 } }), `https://github.com/${REPO}/issues/40#issuecomment-77`);
  assert.equal(sourceUrl(REPO, DC), `https://github.com/${REPO}/discussions/9#discussioncomment-456`);
});

test('writeSource passes the body through a temporary file, never as argv text', () => {
  const issue = recorder(() => ok({}));
  writeSource({ repo: REPO, src: { kind: 'issue', number: 40 }, body: BODY, gh: issue.gh });
  assert.deepEqual(issue.calls[0].args.slice(0, 5), ['api', '-X', 'PATCH', `repos/${REPO}/issues/40`, '-F']);
  assert.equal(issue.calls[0].content, BODY);
  assert.ok(!issue.calls[0].args.some((a) => a.includes('Intro')));
  assert.equal(existsSync(issue.calls[0].file), false); // removed after the call

  const comment = recorder(() => ok({}));
  writeSource({ repo: REPO, src: { kind: 'comment', id: 77 }, body: BODY, gh: comment.gh });
  assert.equal(comment.calls[0].args[3], `repos/${REPO}/issues/comments/77`);
  assert.equal(comment.calls[0].content, BODY);
});

test('writeSource updates a discussion with updateDiscussion and its node id', () => {
  const disc = recorder((args) => (args.some((a) => a.includes('updateDiscussion')) ? ok({ data: { updateDiscussion: { discussion: { id: 'D_1' } } } })
    : ok({ data: { repository: { discussion: { id: 'D_1', body: 'old' } } } })));
  writeSource({ repo: REPO, src: { kind: 'discussion', number: 9 }, body: BODY, gh: disc.gh });
  const write = disc.calls.at(-1);
  assert.match(write.args.find((a) => a.startsWith('query=')), /updateDiscussion\(input: \{ discussionId: \$id, body: \$body \}\)/);
  assert.ok(write.args.includes('id=D_1'));
  assert.equal(write.content, BODY);
  assert.ok(!write.args.some((a) => a.includes('Intro')));
});

test('a gh failure or a GraphQL error reading or writing the source throws GithubUnavailable', () => {
  const down = () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
  const errors = () => ok({ errors: [{ message: 'boom' }] });
  assert.throws(() => readSource({ repo: REPO, src: { kind: 'issue', number: 40 }, gh: down }), GithubUnavailable);
  assert.throws(() => readSource({ repo: REPO, src: { kind: 'discussion', number: 9 }, gh: errors }), GithubUnavailable);
  assert.throws(() => writeSource({ repo: REPO, src: { kind: 'issue', number: 40 }, body: BODY, gh: down }), GithubUnavailable);
  assert.throws(() => writeSource({ repo: REPO, src: { kind: 'discussion', number: 9 }, body: BODY, gh: errors }), GithubUnavailable);
});
