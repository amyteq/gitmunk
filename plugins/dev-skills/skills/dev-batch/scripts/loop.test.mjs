import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveSettings } from './config.mjs';
import { takeLease } from './events.mjs';
import { findRegion, parseLedger, renderLedger } from './ledger.mjs';
import { reconcile, run, tick } from './loop.mjs';
import { tempDir } from './test-helpers.mjs';

const REPO = 'example-org/example-repo';
const LOGIN = 'bot-user';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const T = (h, m = 0) => Date.parse(`2026-11-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const AUTH = "Owner authorization (2026-11-19 09:00 UTC, coordinator session `er-i40c`, owner's invocation `/dev-batch init src=40`): for every task in this ledger, refine, implement, review and merge.";
const FIXTURE = readFileSync(new URL('./fixtures/facts-base.json', import.meta.url), 'utf8');
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const row = (n, issue, over = {}) => ({ n, issue, title: `Task ${issue}`, deps: [], batch: 1, status: 'queued', pr: null, head: null, session: null, next: '', ...over });

// The issue as GitHub's facts query returns it: plain, or refined (task comment + verdict), with an optional PR.
function issueNode(n, { refined = false, verdict = 'ready', pr = null } = {}) {
  const node = JSON.parse(FIXTURE.replaceAll('issues/41', `issues/${n}`).replaceAll('issue=41', `issue=${n}`)).data.repository.issue_41;
  if (!refined) Object.assign(node, { body: 'Plain issue.', comments: { totalCount: 0, nodes: [] } });
  node.comments.nodes[1] &&= { ...node.comments.nodes[1], body: node.comments.nodes[1].body.replace('state=ready', `state=${verdict}`) };
  node.closedByPullRequestsReferences.nodes = pr ? [{
    number: pr.number, state: pr.merged ? 'MERGED' : 'OPEN', merged: !!pr.merged, headRefOid: HEAD, author: { login: LOGIN },
    commits: { nodes: [{ commit: { committedDate: '2026-11-19T10:00:00Z' } }] }, statusCheckRollup: { state: 'SUCCESS' }, reviews: { nodes: [] },
    comments: { nodes: pr.approved ? [{
      body: `<!-- dev-review-pr: RUN1 round=1 phase=final-review -->\nReviewed head: [x](https://github.com/${REPO}/commit/${HEAD})\nBase: [y](https://github.com/${REPO}/commit/${BASE})\nVerdict: approval-eligible`,
      authorAssociation: 'OWNER', createdAt: '2026-11-19T10:00:00Z', url: `https://github.com/${REPO}/pull/${pr.number}#issuecomment-1`, author: { login: LOGIN },
    }] : [] },
  }] : [];
  return node;
}

// A batch on issue #40 with its state directory, a stub `gh` (source body + facts) and a stub `claude` (agents per account).
function world({ rows, accounts = ['A1'], cap = 4 }) {
  const root = tempDir();
  const dir = join(root, 'state', 'example-org', 'example-repo', 'i40');
  mkdirSync(dir, { recursive: true });
  const accts = accounts.map((alias) => {
    const d = join(root, alias);
    mkdirSync(d);
    writeFileSync(join(d, 'dev-batch-usage.json'), JSON.stringify({ at: 0, five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 10 } }));
    return { alias, dir: d };
  });
  const settings = { ...resolveSettings({ cap: String(cap) }, { HOME: root }).values, accounts: accts, abbr: 'er', repo: REPO, src: { kind: 'issue', number: 40 }, login: LOGIN, authorization: AUTH };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  const region = renderLedger({ header: { coordinator: 'er-i40c', alias: 'A1', loop: 'running', cap, merge: 'auto', changed: '2026-11-19 09:00 UTC', waiting: 0 }, authorization: AUTH, rows, log: [] });
  writeFileSync(join(dir, 'ledger.last.md'), region);
  let ids = 0;
  const w = {
    dir, accts, lock: join(dirname(dir), 'merge.lock'), body: `Intro text.\n\n${region}\n\nOutro text.\n`, issues: {},
    agents: Object.fromEntries(accts.map((a) => [a.dir, []])), records: [], logs: {},
    ghDown: false, writeFails: false, launchFails: false, unreadable: new Set(), reads: 0, onRead: null, edits: [], claudeCalls: [],
  };
  w.gh = (args) => {
    if (w.ghDown) return { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    if (args[1] === 'graphql') {
      const issues = [...args.find((a) => a.startsWith('query=')).matchAll(/issue_(\d+): issue/g)].map((m) => Number(m[1]));
      return ok({ data: { repository: Object.fromEntries(issues.map((n) => [`issue_${n}`, issueNode(n, w.issues[n])])) } });
    }
    if (args[2] === 'PATCH') {
      if (w.writeFails) return { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
      w.body = readFileSync(args.at(-1).slice('body=@'.length), 'utf8');
      w.edits.push(w.body);
      return ok({});
    }
    if (args[1] === `repos/${REPO}/issues/40`) { w.reads++; w.onRead?.(w.reads); return ok({ body: w.body }); }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  w.claude = (cmd, args, { env }) => {
    const cfg = env.CLAUDE_CONFIG_DIR;
    const list = w.agents[cfg];
    w.claudeCalls.push({ cfg, args });
    if (args[0] === 'agents') return w.unreadable.has(cfg) ? { code: 1, stdout: '', stderr: 'not logged in' } : ok(list);
    if (args[0] === 'auth') return ok({ loggedIn: true });
    if (args[0] === 'logs') return { code: 0, stdout: w.logs[args[1]] ?? '', stderr: '' };
    if (args[0] === 'stop') { const a = list.find((x) => x.id === args[1]); if (a) a.state = 'stopped'; return { code: a ? 0 : 1, stdout: '', stderr: '' }; }
    if (args[0] === '--bg') {
      if (w.launchFails) return { code: 1, stdout: '', stderr: 'launch failed' };
      const id = (0xa0000000 + ++ids).toString(16);
      list.push({ id, sessionId: `session-${id}`, name: args[args.indexOf('--name') + 1], state: 'working', cwd: '/w', startedAt: '' });
      return { code: 0, stdout: `Started background session ${id}\n`, stderr: '' };
    }
    throw new Error(`unexpected claude ${args.join(' ')}`);
  };
  const acct = (alias) => accts.find((a) => a.alias === alias);
  // An agent listed by `claude agents`; `record` also puts it in the batch's sessions.json.
  w.agent = (name, { alias = 'A1', state = 'done', record = true, stage, issue, pr = null } = {}) => {
    const id = (0xb0000000 + ++ids).toString(16);
    w.agents[acct(alias).dir].push({ id, sessionId: `session-${id}`, name, state, cwd: '/w', startedAt: '' });
    if (record) {
      w.records.push({ name, stage, issue, pr, attempt: 1, account: alias, id, sessionId: `session-${id}`, startedAt: new Date(T(10)).toISOString(), endedAt: null, state });
      writeFileSync(join(dir, 'sessions.json'), JSON.stringify(w.records));
    }
    return id;
  };
  w.set = (name, state) => { Object.values(w.agents).flat().find((a) => a.name === name).state = state; };
  w.ctx = (now) => ({ dir, settings: JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), gh: w.gh, claude: w.claude, now, host: 'test-host', pid: process.pid });
  w.tick = (now) => tick(w.ctx(now));
  w.ledger = () => { const r = findRegion(w.body); return parseLedger(w.body.slice(r.start, r.end)).ledger; };
  w.status = () => Object.fromEntries(w.ledger().rows.map((r) => [r.issue, r.status]));
  w.sessions = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
  w.events = () => lines(join(dir, 'events.jsonl'));
  w.pending = () => (existsSync(join(dir, 'pending')) ? readdirSync(join(dir, 'pending')).sort().map((n) => JSON.parse(readFileSync(join(dir, 'pending', n), 'utf8'))) : []);
  w.launches = () => w.claudeCalls.filter((c) => c.args[0] === '--bg');
  w.loop = () => JSON.parse(readFileSync(join(dir, 'loop.json'), 'utf8'));
  return w;
}

test('two dependent issues run to merge', () => {
  const w = world({ rows: [row(1, 41), row(2, 42, { deps: [41], batch: 2 })] });
  let r = w.tick(T(10));
  assert.deepEqual(r.launched, ['er-i41r']);
  assert.deepEqual(w.status(), { 41: 'refining', 42: 'waiting' });

  w.issues[41] = { refined: true };
  w.set('er-i41r', 'done');
  r = w.tick(T(10, 5));
  assert.deepEqual([r.stopped, r.launched], [['er-i41r'], ['er-i41a']]);
  assert.deepEqual(w.status(), { 41: 'implementing', 42: 'waiting' });
  assert.match(w.launches().at(-1).args.at(-1), /^\/goal Execute from https:\/\/github\.com\/example-org\/example-repo\/issues\/41#issuecomment-1\./);

  w.issues[41].pr = { number: 50 };
  w.set('er-i41a', 'done');
  r = w.tick(T(10, 10));
  assert.deepEqual([r.stopped, r.launched], [['er-i41a'], ['er-pr50']]);
  assert.deepEqual([w.status()[41], w.ledger().rows[0].pr], ['reviewing', 50]);

  w.issues[41].pr.approved = true;
  w.set('er-pr50', 'done');
  r = w.tick(T(10, 15));
  assert.deepEqual([r.stopped, r.launched], [['er-pr50'], ['er-pr50m']]);
  assert.equal(w.status()[41], 'merging');
  assert.deepEqual((({ key, issue }) => ({ key, issue }))(JSON.parse(readFileSync(w.lock, 'utf8'))), { key: 'i40', issue: 41 });
  const merge = w.launches().at(-1).args;
  assert.ok(!merge.includes('--autocompact'));
  assert.ok(merge.at(-1).startsWith('/dev-merge pr=50 issues=41 cleanup=own -- ') && merge.at(-1).includes(AUTH));

  w.issues[41].pr.merged = true;
  w.set('er-pr50m', 'done');
  r = w.tick(T(10, 20));
  assert.deepEqual([r.stopped, r.launched], [['er-pr50m'], ['er-i42r']]);
  assert.deepEqual(w.status(), { 41: 'merged', 42: 'refining' });
  assert.equal(existsSync(w.lock), false);
  assert.deepEqual(w.events().filter((e) => e.type === 'stage-done').map((e) => `${e.task} ${e.stage}`), ['41 refine', '41 implement', '41 review', '41 merge']);
  assert.deepEqual(lines(join(w.dir, 'metrics.jsonl')).map((m) => `${m.name} ${m.outcome}`), ['er-i41r fact reached', 'er-i41a fact reached', 'er-pr50 fact reached', 'er-pr50m fact reached']);
});

test('no write when nothing changed', () => {
  const w = world({ rows: [row(1, 41)] });
  assert.equal(w.tick(T(10)).wrote, true);
  const again = w.tick(T(10, 5));
  assert.deepEqual([again.wrote, again.launched], [false, []]);
  assert.equal(w.edits.length, 1);
});

test('concurrent body edit survives (Review Focus 2)', () => {
  const w = world({ rows: [row(1, 41)] });
  w.onRead = (n) => { if (n === 2) w.body = w.body.replace('Outro text.', 'Outro text.\nAn owner line added mid-tick.'); };
  w.tick(T(10));
  assert.equal(w.edits.length, 1);
  const { start, end } = findRegion(w.body);
  assert.equal(w.body.slice(0, start), 'Intro text.\n\n');
  assert.equal(w.body.slice(end), '\n\nOutro text.\nAn owner line added mid-tick.\n');
  assert.equal(w.status()[41], 'refining');
});

test('an unreadable account (Review Focus 3)', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' }), row(2, 43)], accounts: ['A1', 'A2'] });
  w.issues[41] = { refined: true };
  w.agent('er-i41a', { alias: 'A2', state: 'done', stage: 'implement', issue: 41 });
  w.unreadable.add(w.accts[1].dir);
  for (const at of [T(10), T(10, 5)]) {
    const r = w.tick(at);
    assert.deepEqual(r.stopped, []);
    assert.ok(!r.launched.some((n) => n.startsWith('er-i41')));
  }
  assert.deepEqual(w.launches().map((c) => [c.args[c.args.indexOf('--name') + 1], c.cfg]), [['er-i43r', w.accts[0].dir]]);
  assert.equal(w.sessions().find((s) => s.name === 'er-i41a').state, 'unknown');
  assert.deepEqual(w.status(), { 41: 'implementing', 43: 'refining' });
  assert.deepEqual(w.events().filter((e) => e.type === 'account-unreadable').map((e) => e.account), ['A2']); // once, not every tick
});

test('github unavailable (Review Focus 5)', () => {
  const w = world({ rows: [row(1, 41)] });
  w.ghDown = true;
  for (const [i, at] of [T(10), T(10, 5), T(10, 10)].entries()) {
    const r = w.tick(at);
    assert.deepEqual([r.wrote, r.launched, r.events.map((e) => e.type)], [false, [], ['github-unavailable']]);
    assert.equal(w.events().length, i + 1);
    assert.equal(w.pending().length, i === 2 ? 1 : 0); // only the third in a row is a judgment
  }
  assert.deepEqual([w.claudeCalls.length, w.edits.length], [0, 0]);
  w.ghDown = false;
  assert.deepEqual(w.tick(T(10, 15)).launched, ['er-i41r']);
  assert.equal(w.loop().githubFailures, 0);
});

test('adopt, don\'t relaunch (Review Focus 4)', () => {
  const w = world({ rows: [row(1, 41)] });
  w.issues[41] = { refined: true };
  w.agent('er-i41a', { state: 'working', record: false }); // launched before a restart lost the record
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, w.launches().length], [[], 0]);
  assert.deepEqual(w.sessions().map((s) => [s.name, s.stage, s.issue, s.account, s.state]), [['er-i41a', 'implement', 41, 'A1', 'working']]);
  assert.deepEqual([w.status()[41], w.ledger().rows[0].session], ['implementing', 'er-i41a']);
});

test('cap and one merge at a time', () => {
  const a = world({ rows: [row(1, 41), row(2, 43)], cap: 1 });
  assert.deepEqual(a.tick(T(10)).launched, ['er-i41r']);
  assert.deepEqual(a.tick(T(10, 5)).launched, []);
  assert.deepEqual(a.status(), { 41: 'refining', 43: 'queued' });

  const b = world({ rows: [row(1, 41, { status: 'reviewing', pr: 50, session: 'er-pr50' }), row(2, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  b.issues[41] = { refined: true, pr: { number: 50, approved: true } };
  b.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  b.agent('er-pr50', { stage: 'review', issue: 41, pr: 50 });
  b.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(b.tick(T(10)).launched, ['er-pr50m']);
  assert.deepEqual(b.ledger().rows.map((r) => [r.status, r.next]), [['merging', ''], ['reviewing', 'waiting for the merge lock']]);
  b.issues[41].pr.merged = true;
  b.set('er-pr50m', 'done');
  assert.deepEqual(b.tick(T(10, 5)).launched, ['er-pr51m']);
  assert.equal(JSON.parse(readFileSync(b.lock, 'utf8')).issue, 43);
  assert.deepEqual(b.status(), { 41: 'merged', 43: 'merging' });
});

test('three failed launches pause the batch', () => {
  const w = world({ rows: [row(1, 41), row(2, 43), row(3, 44)] });
  w.launchFails = true;
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, w.launches().length], [[], 3]);
  assert.deepEqual(w.pending().map((e) => e.type), ['batch-paused']);
  assert.equal(JSON.parse(readFileSync(join(w.dir, 'settings.json'), 'utf8')).paused, true);
  assert.equal(w.ledger().header.loop, 'paused');
  assert.deepEqual(w.status(), { 41: 'queued', 43: 'queued', 44: 'queued' });
  w.launchFails = false;
  assert.deepEqual(w.tick(T(10, 5)).launched, []);
  assert.equal(w.launches().length, 3);
});

test('a usage-limited session moves to the other account', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' })], accounts: ['A1', 'A2'] });
  w.issues[41] = { refined: true };
  const id = w.agent('er-i41a', { alias: 'A1', state: 'blocked', stage: 'implement', issue: 41 });
  w.logs[id] = "Working…\nYou've hit your session limit · resets 4pm (UTC)\n";
  const r = w.tick(T(12));
  assert.deepEqual([r.launched, r.stopped], [['er-i41a2'], ['er-i41a']]);
  assert.equal(w.launches()[0].cfg, w.accts[1].dir);
  assert.equal(w.loop().cooling.A1, T(16));
  assert.deepEqual(w.sessions().map((s) => [s.name, s.account, s.attempt, s.state]), [['er-i41a', 'A1', 1, 'stopped'], ['er-i41a2', 'A2', 1, 'working']]);
  assert.deepEqual(w.events().filter((e) => e.type === 'limit').map((e) => e.session), ['er-i41a']);
  assert.equal(lines(join(w.dir, 'metrics.jsonl'))[0].outcome, 'retried');
  assert.equal(w.ledger().rows[0].session, 'er-i41a2');
});

test('owner revokes the authorization line', () => {
  const w = world({ rows: [row(1, 41), row(2, 43)], cap: 1 });
  assert.deepEqual(w.tick(T(10)).launched, ['er-i41r']);
  w.body = w.body.replace(`${AUTH}\n`, '');
  w.issues[41] = { refined: true };
  w.set('er-i41r', 'done');
  const r = w.tick(T(10, 5));
  assert.deepEqual([r.launched, r.stopped], [[], ['er-i41r']]);
  assert.deepEqual(w.ledger().rows.map((x) => [x.status, x.next]), [['owner', "waiting for the owner's authorization"], ['owner', "waiting for the owner's authorization"]]);
  assert.ok(!w.body.includes('Owner authorization')); // the loop never writes a revoked line back
  w.body = w.body.replace('Roll call:', `${AUTH}\nRoll call:`); // restored
  assert.deepEqual(w.tick(T(10, 10)).launched, ['er-i41a']);
});

test('owner edits: order, hold and a deleted row', () => {
  const w = world({ rows: [row(1, 41), row(2, 43), row(3, 44), row(4, 45)], cap: 1 });
  const { start, end } = findRegion(w.body);
  const edited = w.ledger();
  edited.rows = [edited.rows[3], edited.rows[0], { ...edited.rows[2], status: 'hold' }]; // #45 to the top, #44 held, #43 deleted
  w.body = w.body.slice(0, start) + renderLedger(edited, { eol: '\n' }).replace('| 1 | #45', '|  1 | #45 ') + w.body.slice(end);
  assert.deepEqual(w.tick(T(10)).launched, ['er-i45r']);
  assert.deepEqual(w.ledger().rows.map((r) => [r.n, r.issue, r.status]), [[1, 45, 'refining'], [2, 43, 'removed'], [3, 41, 'queued'], [4, 44, 'hold']]);
  assert.deepEqual(w.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail.split(' ')[0]).sort(), ['deleted', 'hold', 'order']);
});

test('a hand-edited CRLF table with an unknown emoji keeps the row and is rewritten once', () => {
  const w = world({ rows: [row(1, 41, { status: 'refining', session: 'er-i41r' })] });
  w.agent('er-i41r', { state: 'working', stage: 'refine', issue: 41 });
  w.body = w.body.replace('| 🔍 |', '| 🟣 |').replaceAll('\n', '\r\n');
  const r = w.tick(T(10));
  assert.deepEqual(r.events.filter((e) => e.type === 'ledger-unreadable-row').map((e) => e.detail), ['row 1: unknown status 🟣']);
  assert.equal(r.wrote, true);
  assert.equal(w.status()[41], 'refining');
  assert.ok(!/(?<!\r)\n/.test(w.body)); // still CRLF throughout
  assert.equal(w.tick(T(10, 5)).wrote, false);
});

test('a failed ledger write does not raise the same judgment twice', () => {
  const w = world({ rows: [row(1, 41, { status: 'refining', session: 'er-i41r' })] });
  w.issues[41] = { refined: true, verdict: 'not-ready' };
  w.agent('er-i41r', { stage: 'refine', issue: 41 });
  w.writeFails = true;
  assert.equal(w.tick(T(10)).wrote, false);
  w.writeFails = false;
  assert.equal(w.tick(T(10, 5)).wrote, true);
  assert.deepEqual(w.pending().map((e) => e.type), ['refine-not-ready']);
  assert.deepEqual(w.ledger().rows.map((r) => [r.status, r.next]), [['blocked', 'refine: not ready']]);
});

test('reconcile for takeover adopts listed sessions and keeps unlisted ones unknown', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' }), row(2, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  rmSync(join(w.dir, 'ledger.last.md')); // another machine: nothing local
  w.issues[41] = { refined: true };
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr51', { state: 'done', record: false });
  const r = reconcile(w.ctx(T(11)));
  assert.deepEqual([r.adopted, r.unknown], [['er-pr51'], ['er-i41a']]);
  assert.deepEqual([r.stopped, r.launched], [['er-pr51'], ['er-pr51m']]); // an approval with no merge gets a merge
  assert.deepEqual(w.status(), { 41: 'implementing', 43: 'merging' }); // nothing relaunched over the unknown session
  assert.deepEqual(w.pending().map((e) => [e.type, e.session]), [['session-unknown', 'er-i41a']]);
});

test('run ticks, wakes early when a session leaves working, and ends the complete batch', async () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'removed' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true } };
  w.agent('er-pr50m', { state: 'working', stage: 'merge', issue: 41, pr: 50 });
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); w.issues[41].pr.merged = true; w.set('er-pr50m', 'done'); };
  const ctx = { dir: w.dir, gh: w.gh, claude: w.claude, host: 'test-host', pid: process.pid, clock: () => T(10, sleeps.length), sleep };
  assert.deepEqual(await run(ctx), { complete: true });
  assert.deepEqual(sleeps, [15_000]); // the first 15 s check saw er-pr50m leave working
  assert.deepEqual(w.status(), { 41: 'merged', 43: 'removed' });
  assert.equal(w.ledger().header.loop, 'stopped');
  assert.match(w.ledger().log.at(-1).event, /^batch complete: 1 PRs merged/);
  assert.equal(JSON.parse(readFileSync(join(w.dir, 'summary.json'), 'utf8')).measures.mergedPrs, 1);
  assert.deepEqual(w.pending().map((e) => e.type), ['batch-complete']);
  assert.equal(existsSync(join(w.dir, 'lease.json')), false); // released
  assert.equal(existsSync(w.lock), false);
});

test('run refuses while the lease holder is alive', async () => {
  const w = world({ rows: [row(1, 41)] });
  takeLease(w.dir, { pid: process.pid, host: 'test-host' });
  const r = await run({ dir: w.dir, gh: w.gh, claude: w.claude, host: 'test-host', pid: 1, clock: () => T(10), sleep: async () => {} });
  assert.equal(r.held.pid, process.pid);
  assert.equal(w.reads, 0);
});
