// Tests for dev-reply's helper (#78): the invocation, mention detection, the unanswered-mention scan and
// the reply routes. Run with `npm test` from the plugin root. Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mentions, replyMention, resolveArgs, scan } from './check-reply.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-reply.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'check-reply-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REPO = 'example-org/example-repo';
const BASE = `https://github.com/${REPO}`;
const ME = 'example-owner';
const NOW = '2026-01-10T12:00:00Z';
const args = (text) => resolveArgs({ repo: REPO, text, now: NOW });
const cli = (command, input) => {
  const path = join(scratch, `${command}.json`);
  writeFileSync(path, JSON.stringify(input));
  return spawnSync(process.execPath, [CLI, command, '--input', path], { encoding: 'utf8' });
};

// ── Invocation ──

test('no target scans the repository; a number, an issue, PR or discussion URL names one thread', () => {
  const none = args('');
  assert.equal(none.action, 'proceed');
  assert.equal(none.target, null);
  assert.deepEqual(none.since, { value: '5d', source: 'default' });
  assert.equal(none.cutoff, '2026-01-05T12:00:00.000Z');
  assert.equal(args('since=36h').cutoff, '2026-01-09T00:00:00.000Z');
  assert.deepEqual(args('#12').target, { number: 12, kind: 'any', source: 'argument' });
  assert.deepEqual(args(`${BASE}/discussions/7`).target, { number: 7, kind: 'discussion', source: 'argument' });
});

test('a comment URL narrows the run to that comment, without the ignored-fragment warning', () => {
  const issue = args(`${BASE}/issues/12#issuecomment-345`);
  assert.deepEqual(issue.target, { number: 12, kind: 'issue-or-pr', comment: 345, commentKind: 'issue-comment', source: 'argument' });
  assert.deepEqual(issue.warnings, []);
  assert.equal(args(`${BASE}/pull/12#discussion_r678`).target.commentKind, 'review-comment');
  assert.equal(args(`${BASE}/discussions/7#discussioncomment-9`).target.commentKind, 'discussion-comment');
  assert.equal(args(`${BASE}/issues/12#discussion_r678`).reason, 'bad-target');
  assert.match(args(`${BASE}/issues/12#top`).warnings[0], /ignored the URL fragment/);
});

test('another repository\'s target and two targets stop', () => {
  assert.equal(args('https://github.com/other-org/other-repo/issues/3').reason, 'bad-target');
  assert.equal(args('#1 #2').reason, 'ambiguous-target');
});

test('cc= takes #N, N and URLs of any repository, comma-separated or repeated, without duplicates', () => {
  const result = args(`cc=#3,4 cc=https://github.com/other-org/tracker/discussions/5 cc=${BASE}/issues/3 #12`);
  assert.deepEqual(result.cc, [
    { repo: REPO, number: 3, kind: 'any', here: true },
    { repo: REPO, number: 4, kind: 'any', here: true },
    { repo: 'other-org/tracker', number: 5, kind: 'discussion', here: false },
  ]);
  assert.equal(result.target.number, 12);
  assert.equal(args('cc=nowhere').reason, 'bad-cc');
});

test('since= takes Nd or Nh; a bad or repeated value warns and keeps 5d', () => {
  assert.deepEqual(args('since=12h').since, { value: '12h', source: 'argument' });
  for (const text of ['since=5', 'since=1w', 'since=2d since=3d']) {
    const result = args(text);
    assert.deepEqual(result.since, { value: '5d', source: 'default' }, text);
    assert.match(result.warnings[0], /since=/);
  }
});

test('dry-run is a flag, and the first other word starts the verbatim notes', () => {
  const result = args('dry-run #12 only the CI question, cc=#3 stays a note');
  assert.equal(result.dryRun, true);
  assert.equal(result.notes, 'only the CI question, cc=#3 stays a note');
  assert.deepEqual(result.cc, []);
});

// ── Mentions ──

test('a direct mention counts; code, quotes, links, emails, paths, teams and longer logins do not', () => {
  for (const body of [`@${ME} can you check?`, `Thanks (@${ME}).`, `cc @EXAMPLE-OWNER`, `- [ ] @${ME}: decide`, `<code>x</code> then @${ME}`, `<b>@${ME}</b>`]) {
    assert.equal(mentions(body, ME), true, body);
  }
  for (const body of [`\`@${ME}\``, `\`\`\`\n@${ME}\n\`\`\``, `> @${ME} wrote this earlier`, `[@${ME}](https://example.com)`,
    `mail ${ME}@example.com`, `see a@${ME}`, `path/@${ME}`, `@${ME}/reviewers`, `@${ME}-bot`, `@${ME}x`, '', null,
    `run <code>@${ME}</code> here`, `see <a href="https://example.com">the @${ME} page</a>`, `<CODE class="x">**@${ME}**</CODE>`]) {
    assert.equal(mentions(body, ME), false, String(body));
  }
});

test('a reply names a person with @login and keeps bots and agent triggers in a code span', () => {
  assert.equal(replyMention('alice', false), '@alice');
  assert.equal(replyMention('ci-helper', true), '`@ci-helper`');
  assert.equal(replyMention('github-actions[bot]', false), '`@github-actions[bot]`');
  assert.equal(replyMention('Claude-Smith', false), '`@Claude-Smith`');
  assert.equal(replyMention('codex', false), '`@codex`');
  assert.equal(replyMention('claudette', false), '@claudette');
});

// ── Scan ──

const user = (login, type = 'User') => ({ login, type });
const issue = (over = {}) => ({ number: 12, id: 1200, title: 'Example', html_url: `${BASE}/issues/12`, created_at: '2026-01-01T00:00:00Z', body: '', user: user('alice'), ...over });
const comment = (id, login, created, body, type) => ({ id, html_url: `${BASE}/issues/12#issuecomment-${id}`, created_at: created, body, user: user(login, type) });
const CUTOFF = { '5d': '2026-01-05T12:00:00.000Z', '36h': '2026-01-09T00:00:00.000Z', '7d': '2026-01-03T12:00:00.000Z' };
const run = (threads, { since = '5d', ...over } = {}) => scan({ login: ME, cutoff: CUTOFF[since], threads, ...over });

test('an unanswered mention in the window is a topic; an answered, old or self-written one is not', () => {
  const thread = {
    issue: issue(),
    comments: [[
      comment(1, 'alice', '2026-01-04T00:00:00Z', `@${ME} too old`),
      comment(2, 'bob', '2026-01-08T00:00:00Z', `@${ME} answered below`),
      comment(3, ME, '2026-01-08T01:00:00Z', 'Answer.'),
      comment(4, ME, '2026-01-09T00:00:00Z', `@${ME} note to self`),
      comment(5, 'carol', '2026-01-09T02:00:00Z', `@${ME} what about the default?`),
      comment(6, 'carol', '2026-01-09T03:00:00Z', `@${ME} and the name?`),
      comment(7, 'dave', '2026-01-09T04:00:00Z', 'No mention here.'),
    ]],
  };
  const { topics } = run([thread]);
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0].groups, [{
    route: { kind: 'issue-comment', number: 12 }, sender: 'carol', bot: false, mention: '@carol',
    comments: [5, 6].map((id) => ({ place: 'comment', id, url: `${BASE}/issues/12#issuecomment-${id}`, createdAt: `2026-01-09T0${id - 3}:00:00Z` })),
  }]);
  assert.deepEqual(run([thread], { since: '36h' }).topics[0].groups[0].comments.map((c) => c.id), [5, 6]);
  const old = { issue: issue(), comments: [[comment(1, 'alice', '2026-01-04T00:00:00Z', `@${ME} still open`)]] };
  assert.deepEqual(run([old]).topics, []);
  assert.deepEqual(run([old], { since: '7d' }).topics[0].groups[0].comments.map((c) => c.id), [1]);
  // A wider window reaches comment 1, but the conversation's later comment 3 answers it.
  assert.deepEqual(run([thread], { since: '7d' }).topics[0].groups.flatMap((g) => g.comments.map((c) => c.id)), [5, 6]);
});

test('a mention in the body, a review or a bot comment is found, and the bot is mentioned in code', () => {
  const thread = {
    issue: issue({ pull_request: {}, created_at: '2026-01-09T00:00:00Z', body: `@${ME} please review` }),
    comments: [[comment(7, 'helper[bot]', '2026-01-09T05:00:00Z', `@${ME} the build failed`, 'Bot')]],
    reviews: [[{ id: 70, html_url: `${BASE}/pull/12#pullrequestreview-70`, submitted_at: '2026-01-09T06:00:00Z', body: `@${ME} one question`, user: user('bob') },
      { id: 71, html_url: '', submitted_at: null, body: `@${ME} pending`, user: user('bob') }]],
  };
  const [topic] = run([thread]).topics;
  assert.equal(topic.kind, 'pr');
  assert.deepEqual(topic.groups.map((g) => [g.sender, g.mention, g.comments.map((c) => c.place)]),
    [['alice', '@alice', ['body']], ['helper[bot]', '`@helper[bot]`', ['comment']], ['bob', '@bob', ['review']]]);
});

test('review comments reply in their own review thread, which only a reply there answers', () => {
  const rc = (id, login, created, body, inReplyTo) => ({ id, in_reply_to_id: inReplyTo, html_url: `${BASE}/pull/12#discussion_r${id}`, created_at: created, body, user: user(login) });
  const thread = {
    issue: issue({ pull_request: {} }),
    comments: [[comment(9, ME, '2026-01-09T09:00:00Z', 'A conversation comment does not answer a review thread.')]],
    reviewComments: [[rc(80, 'bob', '2026-01-09T00:00:00Z', `@${ME} rename this?`), rc(81, 'bob', '2026-01-09T01:00:00Z', `@${ME} ping`, 80),
      rc(90, 'bob', '2026-01-09T00:00:00Z', `@${ME} and this?`), rc(91, ME, '2026-01-09T02:00:00Z', 'Done.', 90)]],
  };
  const [topic] = run([thread]).topics;
  assert.deepEqual(topic.groups.map((g) => [g.route, g.comments.map((c) => c.id)]),
    [[{ kind: 'review-reply', number: 12, commentId: 80 }, [80, 81]]]);
});

test('discussion mentions reply in their comment thread; the body is answered by any later top-level comment', () => {
  const node = (id, login, created, body, replies = []) => ({ id: `DC_${id}`, databaseId: id, url: `${BASE}/discussions/7#discussioncomment-${id}`, createdAt: created, body, author: { login, __typename: 'User' }, replies: { nodes: replies } });
  const discussion = (comments, body = `@${ME} which option?`) => ({ discussion: {
    id: 'D_7', number: 7, title: 'Options', url: `${BASE}/discussions/7`, createdAt: '2026-01-08T00:00:00Z', body, author: { login: 'alice', __typename: 'User' },
    comments: { nodes: comments } } });
  const open = run([discussion([
    node(1, 'bob', '2026-01-09T00:00:00Z', `@${ME} and the date?`, [node(2, 'alice', '2026-01-09T01:00:00Z', `@${ME} +1`)]),
    node(3, 'dave', '2026-01-09T00:00:00Z', `@${ME} answered`, [node(4, ME, '2026-01-09T04:00:00Z', 'Yes.')]),
  ])]).topics[0];
  assert.deepEqual(open.groups.map((g) => [g.sender, g.route, g.comments.map((c) => c.place)]), [
    ['alice', { kind: 'discussion-comment', discussionId: 'D_7' }, ['body']],
    ['bob', { kind: 'discussion-reply', discussionId: 'D_7', replyToId: 'DC_1' }, ['discussion-comment']],
    ['alice', { kind: 'discussion-reply', discussionId: 'D_7', replyToId: 'DC_1' }, ['discussion-reply']],
  ]);
  const named = run([discussion([node(1, 'bob', '2026-01-09T00:00:00Z', 'x', [node(2, 'carol', '2026-01-09T01:00:00Z', `@${ME} this one`)])])],
    { comment: { id: 2, kind: 'discussion-comment' } }).topics[0];
  assert.deepEqual(named.groups.map((g) => [g.sender, g.route.replyToId, g.comments[0].place]), [['carol', 'DC_1', 'discussion-reply']]);
  const answered = run([discussion([node(5, ME, '2026-01-09T00:00:00Z', 'My answer.')])]);
  assert.deepEqual(answered.topics, []);
});

test('a named comment narrows the scan under the same rules, and says why it was not taken', () => {
  const thread = { issue: issue(), comments: [[
    comment(1, 'alice', '2025-06-01T00:00:00Z', `@${ME} old`),
    comment(2, 'bob', '2026-01-09T00:00:00Z', `@${ME} other`),
    comment(3, 'carol', '2026-01-09T01:00:00Z', 'no mention'),
    comment(4, 'dave', '2026-01-09T02:00:00Z', `@${ME} answered`),
    comment(5, ME, '2026-01-09T03:00:00Z', `@${ME} mine, and the answer to 4`),
    comment(6, 'erin', '2026-01-09T04:00:00Z', `@${ME} open`),
  ]] };
  const named = (id, kind = 'issue-comment') => run([thread], { comment: { id, kind } });
  assert.deepEqual(named(6), { topics: [{ number: 12, kind: 'issue', title: 'Example', url: `${BASE}/issues/12`, mentions: 1, groups: [{
    route: { kind: 'issue-comment', number: 12 }, sender: 'erin', bot: false, mention: '@erin',
    comments: [{ place: 'comment', id: 6, url: `${BASE}/issues/12#issuecomment-6`, createdAt: '2026-01-09T04:00:00Z' }] }] }] });
  for (const [id, reason] of [[1, 'before-cutoff'], [3, 'no-mention'], [4, 'answered'], [5, 'own-text'], [9, 'not-found']]) {
    assert.deepEqual(named(id), { topics: [], named: reason }, `comment ${id}`);
  }
  assert.deepEqual(named(6, 'review-comment'), { topics: [], named: 'not-found' });
  assert.equal(run([thread]).named, undefined);
});

test('an approval without a body answers nothing; a review with text answers the conversation', () => {
  const review = (id, submitted, body, state = 'APPROVED') => ({ id, html_url: `${BASE}/pull/12#pullrequestreview-${id}`, submitted_at: submitted, state, body, user: user(ME) });
  const thread = (reviews) => ({ issue: issue({ pull_request: {} }), comments: [[comment(1, 'alice', '2026-01-09T00:00:00Z', `@${ME} ok to merge?`)]], reviews: [reviews] });
  assert.equal(run([thread([review(70, '2026-01-09T01:00:00Z', ''), review(71, '2026-01-09T02:00:00Z', null), review(72, '2026-01-09T03:00:00Z', ' \n')])]).topics.length, 1);
  assert.deepEqual(run([thread([review(73, '2026-01-09T01:00:00Z', 'Yes, merging.')])]).topics, []);
});

// ── CLI ──

test('the CLI exits 0 to proceed, 1 to stop and 2 when the check did not run', () => {
  const ok = cli('args', { repo: REPO, text: '#12 cc=#3', now: NOW });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).target.number, 12);
  assert.equal(cli('args', { repo: REPO, text: '#1 #2', now: NOW }).status, 1);
  assert.equal(cli('args', { repo: REPO }).status, 2);
  assert.equal(cli('args', { repo: REPO, text: '', now: NOW, extra: 1 }).status, 2);
  assert.equal(cli('scan', { login: ME, cutoff: 'soon', threads: [] }).status, 2);
  const scanned = cli('scan', { login: ME, cutoff: CUTOFF['5d'], threads: [{ issue: issue({ created_at: '2026-01-09T00:00:00Z', body: `@${ME} hi` }) }] });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(JSON.parse(scanned.stdout).topics[0].groups[0].sender, 'alice');
});
