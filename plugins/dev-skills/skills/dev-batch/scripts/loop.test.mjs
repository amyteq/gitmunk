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
const AUTH = "Owner authorization (2026-11-19 09:00 UTC, coordinator session `er-i40c`, owner's invocation `/dev-batch init src=40`): for every task in this ledger, refine, implement, review, and squash merge each approval-eligible PR.";
const FIXTURE = readFileSync(new URL('./fixtures/facts-base.json', import.meta.url), 'utf8');
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const row = (n, issue, over = {}) => ({ n, issue, title: `Task ${issue}`, deps: [], batch: 1, status: 'queued', pr: null, head: null, session: null, next: '', ...over });

// The issue as GitHub's facts query returns it: plain, or refined (task comment + verdict), with an optional PR.
function issueNode(n, { refined = false, verdict = 'ready', pr = null, mention = null, comments = [], closed = null, labels = null } = {}) {
  const node = JSON.parse(FIXTURE.replaceAll('issues/41', `issues/${n}`).replaceAll('issue=41', `issue=${n}`)).data.repository.issue_41;
  if (!refined) Object.assign(node, { body: 'Plain issue.', comments: { totalCount: 0, nodes: [] } });
  node.comments.nodes[1] &&= { ...node.comments.nodes[1], body: node.comments.nodes[1].body.replace('state=ready', `state=${verdict}`) };
  node.comments.nodes.push(...comments);
  node.comments.totalCount = node.comments.nodes.length;
  const prNode = (p) => ({
    number: p.number, state: p.merged ? 'MERGED' : 'OPEN', merged: !!p.merged, headRefOid: HEAD, author: { login: LOGIN },
    createdAt: p.createdAt ?? '2026-11-19T10:05:00Z', mergedAt: p.merged ? (p.mergedAt ?? '2026-11-19T10:19:00Z') : null, baseRepository: { nameWithOwner: REPO },
    commits: { nodes: [{ commit: { committedDate: '2026-11-19T10:00:00Z' } }] }, statusCheckRollup: { state: 'SUCCESS' }, reviews: { nodes: [] },
    comments: { nodes: p.approved ? [{
      body: `<!-- dev-review-pr: RUN1 round=1 phase=final-review -->\nReviewed head: [x](https://github.com/${REPO}/commit/${HEAD})\nBase: [y](https://github.com/${REPO}/commit/${BASE})\nVerdict: approval-eligible`,
      authorAssociation: 'OWNER', createdAt: '2026-11-19T10:00:00Z', url: `https://github.com/${REPO}/pull/${p.number}#issuecomment-1`, author: { login: LOGIN },
    }] : [] },
  });
  node.closedByPullRequestsReferences.nodes = pr ? [prNode(pr)] : [];
  node.timelineItems.nodes = mention ? [{ willCloseTarget: false, source: prNode(mention) }] : []; // a PR that only mentions #n
  if (closed) Object.assign(node, { state: 'CLOSED', stateReason: closed });
  if (labels) node.labels = { nodes: labels.map((name) => ({ name })) };
  return node;
}

// A batch on issue #40 with its state directory, a stub `gh` (source body + facts) and a stub `claude` (agents per account).
function world({ rows, accounts = ['A1'], cap = 4, root = tempDir(), key = 'i40' }) {
  const dir = join(root, 'state', 'example-org', 'example-repo', key);
  mkdirSync(dir, { recursive: true });
  const accts = accounts.map((alias) => {
    const d = join(root, alias);
    mkdirSync(d);
    writeFileSync(join(d, 'dev-batch-usage.json'), JSON.stringify({ at: 0, five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 10 } }));
    return { alias, dir: d };
  });
  const settings = { ...resolveSettings({ cap: String(cap) }, { HOME: root }).values, accounts: accts, abbr: 'er', repo: REPO, src: { kind: 'issue', number: 40 }, login: LOGIN, authorization: AUTH, cwd: '/w' };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  const region = renderLedger({ header: { coordinator: 'er-i40c', alias: 'A1', loop: 'running', cap, merge: 'auto', changed: '2026-11-19 09:00 UTC', waiting: 0 }, authorization: AUTH, rows, log: [] });
  writeFileSync(join(dir, 'ledger.last.md'), region);
  let ids = 0;
  const w = {
    root, dir, accts, lock: join(dirname(dir), 'merge.lock'), body: `Intro text.\n\n${region}\n\nOutro text.\n`, issues: {},
    agents: Object.fromEntries(accts.map((a) => [a.dir, []])), records: [], logs: {},
    ghDown: false, writeFails: false, launchFails: false, stopFails: false, hideLaunches: false, unreadable: new Set(), reads: 0, onRead: null, edits: [], claudeCalls: [],
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
    if (args[0] === 'stop') { if (w.stopFails) return { code: 1, stdout: '', stderr: 'stop failed' }; const a = list.find((x) => x.id === args[1]); if (a) a.state = 'stopped'; return { code: a ? 0 : 1, stdout: '', stderr: '' }; }
    if (args[0] === '--bg') {
      w.onLaunch?.(args[args.indexOf('--name') + 1]);
      if (w.launchFails) return { code: 1, stdout: '', stderr: 'launch failed' };
      const id = (0xa0000000 + ++ids).toString(16);
      if (!w.hideLaunches) list.push({ id, sessionId: `session-${id}`, name: args[args.indexOf('--name') + 1], state: 'working', cwd: '/w', startedAt: '' });
      return { code: 0, stdout: `Started background session ${id}\n`, stderr: '' };
    }
    throw new Error(`unexpected claude ${args.join(' ')}`);
  };
  const acct = (alias) => accts.find((a) => a.alias === alias);
  // An agent listed by `claude agents`; `record` also puts it in the batch's sessions.json.
  w.agent = (name, { alias = 'A1', state = 'done', record = true, stage, issue, pr = null, cwd = '/w' } = {}) => {
    const id = (0xb0000000 + ++ids).toString(16);
    w.agents[acct(alias).dir].push({ id, sessionId: `session-${id}`, name, state, cwd, startedAt: '' });
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
  // The owner edits the region in the body: `fn` changes the parsed ledger, which is rendered back in place.
  w.edit = (fn) => { const { start, end } = findRegion(w.body); const l = w.ledger(); fn(l); w.body = w.body.slice(0, start) + renderLedger(l, { eol: '\n' }) + w.body.slice(end); };
  w.status = () => Object.fromEntries(w.ledger().rows.map((r) => [r.issue, r.status]));
  w.sessions = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
  w.events = () => lines(join(dir, 'events.jsonl'));
  w.pending = () => (existsSync(join(dir, 'pending')) ? readdirSync(join(dir, 'pending')).sort().map((n) => JSON.parse(readFileSync(join(dir, 'pending', n), 'utf8'))) : []);
  w.launches = () => w.claudeCalls.filter((c) => c.args[0] === '--bg');
  w.loop = () => JSON.parse(readFileSync(join(dir, 'loop.json'), 'utf8'));
  // Runs the loop; `clock(sleeps)` gives the time, and the run ends (`lost`) once `stopAt(sleeps)` drops the lease.
  w.run = async ({ clock = () => T(10), stopAt = () => false, onSleep = () => {} } = {}) => {
    const waits = [];
    const ticks = [];
    const r = await run({ dir, gh: w.gh, claude: w.claude, host: 'test-host', pid: process.pid, clock: () => clock(waits.length), log: (x) => ticks.push(x),
      sleep: async (ms) => { waits.push(ms); onSleep(waits.length); if (stopAt(waits.length)) rmSync(join(dir, 'lease.json')); } });
    return { r, waits, ticks };
  };
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

test('a merged PR that only mentions the issue never marks its row merged (C1)', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' })] });
  w.issues[41] = { refined: true, mention: { number: 30, merged: true, createdAt: '2026-11-18T08:00:00Z', mergedAt: '2026-11-18T09:00:00Z' } };
  w.agent('er-i41a', { stage: 'implement', issue: 41 });
  const r = w.tick(T(11));
  assert.deepEqual([w.status()[41], w.ledger().rows[0].pr], ['implementing', null]);
  assert.deepEqual(r.launched, ['er-i41a2']); // the session ended without its PR: the stage is retried, not marked done
});

test('a never-launched row whose issue our merged PR closed turns merged without a launch, and its dependent dispatches (NB1)', () => {
  const w = world({ rows: [row(1, 41), row(2, 42, { deps: [41], batch: 2 })] });
  w.issues[41] = { closed: 'COMPLETED', pr: { number: 50, merged: true, mergedAt: '2026-11-18T09:00:00Z' } };
  const r = w.tick(T(10));
  assert.deepEqual([w.status(), w.ledger().rows[0].pr], [{ 41: 'merged', 42: 'refining' }, 50]);
  assert.deepEqual(r.launched, ['er-i42r']);
});

test('a closed issue without a merged PR of ours raises issue-closed once and launches nothing (NB1)', () => {
  const w = world({ rows: [row(1, 41)] });
  w.issues[41] = { refined: true, closed: 'NOT_PLANNED' };
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, w.status()[41]], [[], 'blocked']);
  assert.deepEqual(w.pending().map((e) => [e.type, e.task]), [['issue-closed', 41]]);
  assert.deepEqual(w.tick(T(10, 5)).launched, []);
  assert.equal(w.pending().length, 1);
});

test('no write when nothing changed', () => {
  const w = world({ rows: [row(1, 41)] });
  assert.equal(w.tick(T(10)).wrote, true);
  const again = w.tick(T(10, 5));
  assert.deepEqual([again.wrote, again.launched], [false, []]);
  assert.equal(w.edits.length, 1);
  assert.equal(w.events().filter((e) => e.type === 'ledger-write').length, 1); // I10: one event per write of the region
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

test('an owner edit inside the region during the tick is applied next tick, not overwritten', () => {
  const w = world({ rows: [row(1, 41), row(2, 43)], cap: 1 });
  w.onRead = (n) => { if (n === 2) w.edit((l) => { l.rows[1].status = 'hold'; }); }; // the owner holds #43 between the tick's two reads
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, r.wrote, w.edits.length], [['er-i41r'], false, 0]);
  assert.equal(w.status()[43], 'hold');
  assert.ok(existsSync(join(w.dir, 'ledger.next.md')));
  const again = w.tick(T(10, 5));
  assert.deepEqual([again.launched, again.wrote], [[], true]);
  assert.deepEqual(w.status(), { 41: 'refining', 43: 'hold' });
  assert.equal(w.ledger().rows[0].session, 'er-i41r');
  assert.deepEqual(w.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail), ['hold #43']);
});

test('an owner edit seen at read 1 and reverted before read 2 ends as the owner left it', () => {
  const w = world({ rows: [row(1, 41, { status: 'refining', session: 'er-i41r' }), row(2, 43)], cap: 1 });
  w.agent('er-i41r', { state: 'working', stage: 'refine', issue: 41 });
  w.edit((l) => { l.rows[1].status = 'hold'; });
  w.onRead = (n) => { if (n === 2) w.edit((l) => { l.rows[1].status = 'queued'; }); };
  assert.equal(w.tick(T(9)).wrote, false);
  // Same minute and no Log line: the result renders exactly as ledger.last.md, and is still written to clear the saved decisions.
  assert.equal(w.tick(T(9)).wrote, true);
  assert.equal(existsSync(join(w.dir, 'ledger.next.md')), false);
  w.tick(T(9, 5));
  assert.deepEqual(w.status(), { 41: 'refining', 43: 'queued' });
  assert.deepEqual(w.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail), ['hold #43', 'release #43']);
});

test('an owner edit seen at read 1 is applied once across a skipped write', () => {
  const skipped = world({ rows: [row(1, 41, { status: 'blocked', next: 'refine: not ready' }), row(2, 43)], cap: 1 });
  skipped.edit((l) => { l.rows[0].status = 'queued'; }); // the owner answers #41 before the tick
  skipped.onRead = (n) => { if (n === 2) skipped.edit((l) => { l.rows[1].status = 'hold'; }); };
  skipped.tick(T(10));
  assert.equal(skipped.tick(T(10, 5)).wrote, true);
  assert.deepEqual(skipped.status(), { 41: 'refining', 43: 'hold' });
  assert.deepEqual(skipped.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail), ['answered #41', 'hold #43']);
  assert.deepEqual(skipped.pending().map((e) => e.type), ['owner-reply']);
});

test('an owner edit seen before a failed write is applied once', () => {
  const failed = world({ rows: [row(1, 41, { status: 'blocked', next: 'refine: not ready' })] });
  failed.edit((l) => { l.rows[0].status = 'queued'; });
  failed.writeFails = true;
  failed.tick(T(10));
  failed.writeFails = false;
  assert.equal(failed.tick(T(10, 5)).wrote, true);
  assert.equal(failed.status()[41], 'refining');
  assert.deepEqual(failed.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail), ['answered #41']);
  assert.deepEqual(failed.pending().map((e) => e.type), ['owner-reply']);
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
    assert.deepEqual([r.wrote, r.launched, r.githubDown, r.events.map((e) => e.type)], [false, [], true, ['github-unavailable']]);
    assert.equal(w.events().length, i + 1);
    assert.equal(w.pending().length, i === 2 ? 1 : 0); // only the third in a row is a judgment
  }
  assert.deepEqual([w.claudeCalls.length, w.edits.length], [0, 0]);
  w.ghDown = false;
  assert.deepEqual(w.tick(T(10, 15)).launched, ['er-i41r']);
  assert.equal(w.loop().githubFailures, 0);

  // A failing write counts the same: the reads succeed, and the third failed tick in a row is the judgment.
  const v = world({ rows: [row(1, 41)] });
  v.writeFails = true;
  for (const [i, at] of [T(10), T(10, 5), T(10, 10)].entries()) {
    const r = v.tick(at);
    assert.deepEqual([r.wrote, r.githubDown, r.events.at(-1).type], [false, true, 'github-unavailable']);
    assert.equal(v.pending().length, i === 2 ? 1 : 0);
  }
  assert.equal(v.launches().length, 1); // launched once; only the write is retried
});

test('while GitHub is down, run waits the full interval and wakes early only for a settings change', async () => {
  const w = world({ rows: [row(1, 41, { status: 'refining', session: 'er-i41r' })] });
  w.agent('er-i41r', { state: 'working', stage: 'refine', issue: 41 });
  w.ghDown = true;
  const settings = join(w.dir, 'settings.json');
  const { r, waits, ticks } = await w.run({
    onSleep: (n) => {
      if (n === 1) w.set('er-i41r', 'done'); // would wake a healthy loop at the first check
      if (n === 21) writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), cap: 3 }));
    },
    stopAt: (n) => n === 21,
  });
  assert.deepEqual(r, { lost: true });
  assert.deepEqual([ticks.length, waits.length], [2, 21]); // 20 checks of 15 s, then the settings change wakes it at once
  assert.ok(ticks.every((t) => t.githubDown));
  assert.equal(w.pending().length, 0); // two failures in ten minutes: no judgment yet
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

test('two rows ready to merge: the lock goes to the higher priority, then the lower Batch, not the first row (Q1)', () => {
  for (const [first, labels41, labels43] of [[{}, ['P3'], ['P0']], [{ batch: 2 }, null, null]]) {
    const w = world({ rows: [row(1, 41, { status: 'reviewing', pr: 50, session: 'er-pr50', ...first }), row(2, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
    w.issues[41] = { refined: true, labels: labels41, pr: { number: 50, approved: true } };
    w.issues[43] = { refined: true, labels: labels43, pr: { number: 51, approved: true } };
    w.agent('er-pr50', { stage: 'review', issue: 41, pr: 50 });
    w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
    assert.deepEqual(w.tick(T(10)).launched, ['er-pr51m']);
    assert.deepEqual(w.ledger().rows.map((r) => [r.status, r.next]), [['reviewing', 'waiting for the merge lock'], ['merging', '']]);
  }
});

test('a removed priority label ranks P2 for the merge lock, not the rank the ledger last showed (Q1)', () => {
  const w = world({ rows: [row(1, 41, { status: 'reviewing', pr: 50, session: 'er-pr50', priority: 0 }), row(2, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true } }; // its P0 label was removed since the last tick
  w.issues[43] = { refined: true, labels: ['P1'], pr: { number: 51, approved: true } };
  w.agent('er-pr50', { stage: 'review', issue: 41, pr: 50 });
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10)).launched, ['er-pr51m']);
  assert.deepEqual(w.ledger().rows.map((r) => [r.issue, r.priority, r.next]), [[41, undefined, 'waiting for the merge lock'], [43, 1, '']]);
});

test('a removed row whose merge session still runs keeps the merge lock until the session ends (R9)', () => {
  const w = world({ rows: [row(1, 41, { status: 'removed', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  writeFileSync(w.lock, JSON.stringify({ key: 'i40', issue: 41, at: '2026-11-19T10:00:00.000Z' }));
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr50m', { state: 'working', stage: 'merge', issue: 41, pr: 50 });
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10)).launched, []);
  assert.equal(JSON.parse(readFileSync(w.lock, 'utf8')).issue, 41);
  w.set('er-pr50m', 'done');
  assert.deepEqual(w.tick(T(10, 5)).launched, ['er-pr51m']);
});

test('another batch\'s merge lock stays held while its merge session runs, even with its loop stopped (R9)', () => {
  const w = world({ rows: [row(1, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  const other = join(dirname(w.dir), 'i99'); // stopped: no lease
  mkdirSync(other);
  const id = w.agent('er-pr70m', { state: 'working', record: false });
  writeFileSync(join(other, 'settings.json'), JSON.stringify({ accounts: w.accts }));
  writeFileSync(join(other, 'sessions.json'), JSON.stringify([{ name: 'er-pr70m', stage: 'merge', issue: 7, pr: 70, account: 'A1', id, state: 'working' }]));
  writeFileSync(w.lock, JSON.stringify({ key: 'i99', issue: 7, at: '2026-11-19T10:00:00.000Z' }));
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10)).launched, []);
  assert.equal(JSON.parse(readFileSync(w.lock, 'utf8')).key, 'i99');
  w.set('er-pr70m', 'done');
  assert.deepEqual(w.tick(T(10, 5)).launched, ['er-pr51m']);
  assert.equal(JSON.parse(readFileSync(w.lock, 'utf8')).key, 'i40');
});

test('a merge session is recorded before it launches; another batch\'s recorded one keeps the lock until its account shows it ended (R9)', () => {
  const w = world({ rows: [row(1, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  const other = join(dirname(w.dir), 'i99'); // stopped right after launching er-pr70m: recorded, not yet listed
  mkdirSync(other);
  writeFileSync(join(other, 'settings.json'), JSON.stringify({ accounts: w.accts }));
  writeFileSync(join(other, 'sessions.json'), JSON.stringify([{ name: 'er-pr70m', stage: 'merge', issue: 7, pr: 70, account: 'A1', id: null,
    startedAt: new Date(T(10)).toISOString(), state: 'working' }]));
  writeFileSync(w.lock, JSON.stringify({ key: 'i99', issue: 7, at: '2026-11-19T10:00:00.000Z' }));
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10, 1)).launched, []); // still registering
  w.agent('er-pr70m', { state: 'working', record: false });
  assert.deepEqual(w.tick(T(10, 5)).launched, []);
  w.set('er-pr70m', 'done');
  const atLaunch = [];
  w.onLaunch = (name) => atLaunch.push(w.sessions().find((x) => x.name === name)?.state);
  assert.deepEqual(w.tick(T(10, 10)).launched, ['er-pr51m']);
  assert.deepEqual(atLaunch, ['working']); // on disk before `claude --bg` ran
});

test('a reclaim removes only the exact lock it judged free, never the one a faster batch took meanwhile (R9)', () => {
  const w = world({ rows: [row(1, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  const other = join(dirname(w.dir), 'i99'); // stopped, its merge session ended
  const b1 = join(other, 'B1');
  mkdirSync(b1, { recursive: true });
  w.agents[b1] = [{ id: 'b1', sessionId: 'session-b1', name: 'er-pr70m', state: 'done', cwd: '/w', startedAt: '' }];
  writeFileSync(join(other, 'settings.json'), JSON.stringify({ accounts: [{ alias: 'B1', dir: b1 }] }));
  writeFileSync(join(other, 'sessions.json'), JSON.stringify([{ name: 'er-pr70m', stage: 'merge', issue: 7, pr: 70, account: 'B1', id: 'b1', state: 'done' }]));
  writeFileSync(w.lock, JSON.stringify({ key: 'i99', issue: 7, at: '2026-11-19T10:00:00.000Z' }));
  mkdirSync(join(dirname(w.dir), 'i77')); // the faster batch, still running
  writeFileSync(join(dirname(w.dir), 'i77', 'lease.json'), JSON.stringify({ host: 'test-host', pid: process.pid }));
  const replacement = { key: 'i77', issue: 9, at: '2026-11-19T10:00:30.000Z' };
  const { claude } = w;
  let raced = false; // i77 reclaims i99's lock and takes its own while this batch still reads i99's accounts
  w.claude = (cmd, args, opts) => {
    if (args[0] === 'agents' && opts.env.CLAUDE_CONFIG_DIR === b1 && !raced) { raced = true; rmSync(w.lock); writeFileSync(w.lock, JSON.stringify(replacement)); }
    return claude(cmd, args, opts);
  };
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10)).launched, []);
  assert.deepEqual([raced, JSON.parse(readFileSync(w.lock, 'utf8')), existsSync(`${w.lock}.reclaim`)], [true, replacement, false]);
  assert.deepEqual(w.ledger().rows.map((r) => [r.status, r.next]), [['reviewing', 'waiting for the merge lock']]);
});

test('a stopped batch that restarts and launches a merge under its own lock keeps it from a reclaimer that judged it earlier (R9)', () => {
  const w = world({ rows: [row(1, 43, { status: 'reviewing', pr: 51, session: 'er-pr51' })] });
  // i99 stopped after recording its merge session and before launching it: no lease, the record unlisted and past its grace.
  const z = world({ rows: [row(1, 7, { status: 'reviewing', pr: 70, session: 'er-pr70' })], root: w.root, key: 'i99', accounts: ['B1'] });
  z.issues[7] = { refined: true, pr: { number: 70, approved: true } };
  z.records.push({ name: 'er-pr70m', stage: 'merge', issue: 7, pr: 70, attempt: 1, account: 'B1', id: null, sessionId: null,
    startedAt: new Date(T(9)).toISOString(), endedAt: null, state: 'working' });
  writeFileSync(join(z.dir, 'sessions.json'), JSON.stringify(z.records));
  writeFileSync(w.lock, JSON.stringify({ key: 'i99', issue: 7, at: new Date(T(9)).toISOString() }));
  const { claude } = w;
  let restarted = null; // i99 restarts and ticks while this batch still reads i99's account
  w.claude = (cmd, args, opts) => {
    if (opts.env.CLAUDE_CONFIG_DIR !== z.accts[0].dir) return claude(cmd, args, opts);
    if (args[0] === 'agents' && !restarted) {
      writeFileSync(join(z.dir, 'lease.json'), JSON.stringify({ host: 'test-host', pid: process.pid }));
      restarted = z.tick(T(10));
    }
    return z.claude(cmd, args, opts);
  };
  w.issues[43] = { refined: true, pr: { number: 51, approved: true } };
  w.agent('er-pr51', { stage: 'review', issue: 43, pr: 51 });
  assert.deepEqual(w.tick(T(10)).launched, []);
  assert.equal(restarted.launched.length, 1);
  assert.deepEqual([JSON.parse(readFileSync(w.lock, 'utf8')).key, existsSync(`${w.lock}.guard`)], ['i99', false]);
  assert.deepEqual(w.ledger().rows.map((r) => [r.status, r.next]), [['reviewing', 'waiting for the merge lock']]);
});

test('a higher-priority issue takes the free slot before a lower Batch, and the ledger shows its priority', () => {
  const w = world({ rows: [row(1, 41), row(2, 43, { batch: 2 })], cap: 1 });
  w.issues[43] = { labels: ['enhancement', 'priority:P0'] };
  assert.deepEqual(w.tick(T(10)).launched, ['er-i43r']);
  assert.deepEqual(w.ledger().rows.map((r) => [r.issue, r.status, r.batch, r.priority]), [[41, 'queued', 1, undefined], [43, 'refining', 2, 0]]);
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

test('merge=auto under a line without the merge clause waits for merge authorization (I1)', () => {
  const w = world({ rows: [row(1, 41, { status: 'reviewing', pr: 50, session: 'er-pr50' })] });
  const line = AUTH.replace(', and squash merge each approval-eligible PR.', '.');
  writeFileSync(join(w.dir, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(w.dir, 'settings.json'), 'utf8')), authorization: line }));
  w.body = w.body.replace(AUTH, line);
  w.issues[41] = { refined: true, pr: { number: 50, approved: true } };
  w.agent('er-pr50', { stage: 'review', issue: 41, pr: 50 });
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, existsSync(w.lock)], [[], false]);
  assert.deepEqual(w.ledger().rows.map((x) => [x.status, x.next]), [['owner', 'waiting for merge authorization']]);
});

test('a usage-limited merge session is not replaced once merge is no longer authorized (C24)', () => {
  for (const revoke of ['merge=off', 'a line without the merge clause']) {
    const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' })], accounts: ['A1', 'A2'] });
    const settings = JSON.parse(readFileSync(join(w.dir, 'settings.json'), 'utf8'));
    if (revoke === 'merge=off') settings.merge = 'off';
    else w.body = w.body.replace(AUTH, settings.authorization = AUTH.replace(', and squash merge each approval-eligible PR.', '.'));
    writeFileSync(join(w.dir, 'settings.json'), JSON.stringify(settings));
    w.issues[41] = { refined: true, pr: { number: 50, approved: true } };
    const id = w.agent('er-pr50m', { alias: 'A1', state: 'blocked', stage: 'merge', issue: 41, pr: 50 });
    w.logs[id] = "You've hit your session limit · resets 4pm (UTC)\n";
    assert.deepEqual([revoke, w.tick(T(12)).launched], [revoke, []]);
    assert.deepEqual(w.ledger().rows.map((x) => [x.status, x.next]), [['owner', 'waiting for merge authorization']]);
  }
});

test('a closed issue is done only through its own merged closing PR, closed as completed (C30)', () => {
  // Closed as completed while our merged PR only mentions it; closed as not planned although our closing PR merged.
  for (const issue of [{ closed: 'COMPLETED', mention: { number: 50, merged: true } }, { closed: 'NOT_PLANNED', pr: { number: 50, merged: true } }]) {
    const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' }), row(2, 42, { deps: [41], batch: 2 })] });
    w.issues[41] = { refined: true, ...issue };
    w.agent('er-i41a', { stage: 'implement', issue: 41 });
    const r = w.tick(T(11));
    assert.deepEqual([issue.closed, r.launched, w.status()], [issue.closed, [], { 41: 'blocked', 42: 'waiting' }]);
    assert.deepEqual(w.pending().map((e) => [e.type, e.task]), [['issue-closed', 41]]);
  }
});

// A worker asks the owner on #41 at 10:30 and goes idle; the owner answers by comment at 11:10.
const ask = (body, at) => ({ databaseId: Date.parse(at) / 1000, body, authorAssociation: 'OWNER', createdAt: at, url: `https://github.com/${REPO}/issues/41#issuecomment-${Date.parse(at) / 1000}`, author: { login: LOGIN } });
function asked({ stopFails = false } = {}) {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' })] });
  w.issues[41] = { refined: true, comments: [ask('<!-- dev-batch:owner issue=41 -->\nWhich format?', '2026-11-19T10:30:00Z')] };
  w.agent('er-i41a', { state: 'working', stage: 'implement', issue: 41 });
  w.stopFails = stopFails;
  w.set('er-i41a', 'done');
  return w;
}

test('a session idle after its owner question is stopped, and a later comment is the answer (I4)', () => {
  const w = asked();
  const r = w.tick(T(11));
  assert.deepEqual([w.status()[41], r.stopped], ['owner', ['er-i41a']]);
  w.issues[41].comments.push(ask('Take CSV.', '2026-11-19T11:10:00Z'));
  w.tick(T(11, 15));
  assert.deepEqual(w.pending().map((e) => e.type), ['owner-reply']);
  assert.match(w.ledger().rows[0].next, /^owner replied: /);
});

test('when the asking session cannot be stopped, its window closes when it left working (I4)', () => {
  const w = asked({ stopFails: true });
  const r = w.tick(T(11));
  assert.deepEqual([w.status()[41], r.stopped, w.events().filter((e) => e.type === 'stop-failed').length], ['owner', [], 1]);
  assert.equal(w.sessions()[0].idleAt, new Date(T(11)).toISOString());
  w.issues[41].comments.push(ask('Take CSV.', '2026-11-19T11:10:00Z'));
  w.tick(T(11, 15));
  assert.deepEqual(w.pending().map((e) => e.type), ['owner-reply']);
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

test('the owner releases a held row', () => {
  const w = world({ rows: [row(1, 41, { status: 'hold' })] });
  assert.deepEqual(w.tick(T(10)).launched, []);
  w.body = w.body.replace('| ⏸️ |', '| 🆕 |');
  assert.deepEqual(w.tick(T(10, 5)).launched, ['er-i41r']);
  assert.equal(w.status()[41], 'refining');
  assert.deepEqual(w.events().filter((e) => e.type === 'owner-edit').map((e) => e.detail), ['release #41']);
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

test('a complete batch whose final roll call fails to write is not complete until it is written', () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'removed' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true, merged: true } };
  w.agent('er-pr50m', { stage: 'merge', issue: 41, pr: 50 });
  w.writeFails = true;
  let r = w.tick(T(10));
  assert.deepEqual([r.complete, r.wrote], [false, false]);
  assert.deepEqual([w.pending(), existsSync(join(w.dir, 'summary.json'))], [[], false]); // nothing says complete yet
  w.writeFails = false;
  r = w.tick(T(10, 5));
  assert.deepEqual([r.complete, r.wrote], [true, true]);
  assert.equal(w.ledger().header.loop, 'stopped');
  assert.match(w.ledger().log.at(-1).event, /^batch complete: 1 PRs merged/);
  assert.equal(w.ledger().log.filter((l) => l.event.startsWith('batch complete')).length, 1);
  assert.deepEqual(w.pending().map((e) => e.type), ['batch-complete']); // raised once
  assert.ok(existsSync(join(w.dir, 'summary.json')));
});

test('a final roll call skipped for an owner edit made during the tick completes only once it is written', () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'removed' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true, merged: true } };
  w.agent('er-pr50m', { stage: 'merge', issue: 41, pr: 50 });
  w.onRead = (n) => { if (n === 2) w.edit((l) => { l.rows[1].deps = [41]; }); };
  let r = w.tick(T(10));
  assert.deepEqual([r.complete, r.wrote, w.pending(), existsSync(join(w.dir, 'summary.json'))], [false, false, [], false]);
  r = w.tick(T(10, 5));
  assert.deepEqual([r.complete, r.wrote], [true, true]);
  assert.deepEqual([w.ledger().rows[1].deps, w.pending().map((e) => e.type)], [[41], ['batch-complete']]);
});

test('the last merge session still in its closeout keeps the batch open until it is stopped and measured (I8)', () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true, merged: true } };
  w.agent('er-pr50m', { state: 'working', stage: 'merge', issue: 41, pr: 50 });
  let r = w.tick(T(10));
  assert.deepEqual([r.complete, w.status()[41], w.ledger().header.loop, existsSync(join(w.dir, 'summary.json'))], [false, 'merged', 'running', false]);
  w.set('er-pr50m', 'done');
  r = w.tick(T(10, 5));
  assert.deepEqual([r.complete, r.stopped], [true, ['er-pr50m']]);
  assert.deepEqual(lines(join(w.dir, 'metrics.jsonl')).map((m) => `${m.name} ${m.outcome}`), ['er-pr50m fact reached']);
  assert.deepEqual(w.pending().map((e) => e.type), ['batch-complete']);
});

test('the batch stays open while its last session is unknown or its stop failed, until it is stopped and measured (I8)', () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'removed', session: 'er-i43a' })] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true, merged: true } };
  w.agent('er-pr50m', { state: 'working', stage: 'merge', issue: 41, pr: 50 });
  // Only another machine listed er-i43a at takeover: no account here can show it or its metrics, so it does not hold the batch.
  w.records.push({ name: 'er-i43a', stage: 'implement', issue: 43, pr: null, attempt: 1, account: null, id: null, sessionId: null,
    startedAt: new Date(T(9)).toISOString(), endedAt: null, state: 'unknown' });
  writeFileSync(join(w.dir, 'sessions.json'), JSON.stringify(w.records));
  const summary = join(w.dir, 'summary.json');
  assert.equal(w.tick(T(10)).complete, false);
  w.unreadable.add(w.accts[0].dir);
  let r = w.tick(T(10, 5));
  assert.deepEqual([r.complete, w.sessions()[0].state, existsSync(summary)], [false, 'unknown', false]);
  w.unreadable.clear();
  w.set('er-pr50m', 'done');
  w.stopFails = true;
  r = w.tick(T(10, 10));
  assert.deepEqual([r.complete, r.stopped, w.sessions()[0].state, existsSync(summary)], [false, [], 'done', false]);
  w.stopFails = false;
  r = w.tick(T(10, 15));
  assert.deepEqual([r.complete, r.stopped], [true, ['er-pr50m']]);
  assert.deepEqual(lines(join(w.dir, 'metrics.jsonl')).map((m) => `${m.name} ${m.outcome}`), ['er-pr50m fact reached']);
  assert.deepEqual(w.pending().map((e) => e.type), ['batch-complete']);
});

test('the loop stops idle sessions of merged and removed rows, never a working one (I8)', () => {
  const w = world({ rows: [row(1, 41, { status: 'merging', pr: 50, session: 'er-pr50m' }), row(2, 43, { status: 'removed', session: 'er-i43a' }),
    row(3, 44, { status: 'removed', session: 'er-i44r' }), row(4, 45)] });
  w.issues[41] = { refined: true, pr: { number: 50, approved: true, merged: true } };
  w.agent('er-pr50m', { state: 'working', stage: 'merge', issue: 41, pr: 50 }); // still in its closeout when the merge is seen
  w.agent('er-i43a', { stage: 'implement', issue: 43 });
  w.agent('er-i44r', { state: 'working', stage: 'refine', issue: 44 });
  assert.deepEqual(w.tick(T(10)).stopped, ['er-i43a']);
  w.set('er-pr50m', 'done');
  assert.deepEqual(w.tick(T(10, 5)).stopped, ['er-pr50m']);
  assert.equal(w.sessions().find((x) => x.name === 'er-i44r').state, 'working');
  assert.deepEqual(lines(join(w.dir, 'metrics.jsonl')).map((m) => `${m.name} ${m.outcome}`), ['er-i43a removed', 'er-pr50m fact reached']);
});

test('a session launched under 120 s ago and not yet listed stays working', () => {
  const w = world({ rows: [row(1, 41)] });
  w.hideLaunches = true; // `claude agents` has not registered the new session yet
  assert.deepEqual(w.tick(T(10)).launched, ['er-i41r']);
  const r = w.tick(T(10, 1));
  assert.deepEqual([r.launched, r.stopped], [[], []]);
  assert.equal(w.sessions()[0].state, 'working');
  w.tick(T(10, 2)); // two minutes and still not listed: gone
  assert.equal(w.sessions()[0].state, 'stopped');
});

test('a session recorded before its launch and found by name gets its id, so the 15 s check does not tick early', async () => {
  const w = world({ rows: [row(1, 41, { status: 'refining', session: 'er-i41r' })] });
  const id = w.agent('er-i41r', { state: 'working', stage: 'refine', issue: 41 });
  w.records[0].id = null; // the loop stopped after the launch, before it recorded the id
  writeFileSync(join(w.dir, 'sessions.json'), JSON.stringify(w.records));
  const { ticks } = await w.run({ clock: (n) => T(10, 5) + n * 15_000, stopAt: (n) => n === 4 });
  assert.equal(ticks.length, 1);
  assert.equal(w.sessions()[0].id, id);
});

test('the 15 s check does not count a session still registering as left working', async () => {
  const w = world({ rows: [row(1, 41)] });
  w.hideLaunches = true;
  const { waits, ticks } = await w.run({ clock: (n) => T(10) + n * 15_000, stopAt: (n) => n === 8 });
  assert.deepEqual(ticks.map((t) => t.launched), [['er-i41r']]);
  assert.equal(waits.length, 8); // woken once the launch is 120 s old and still not listed
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

test('a session of another checkout under the same name is never adopted, bound or stopped by this batch (C29)', () => {
  const w = world({ rows: [row(1, 41), row(2, 43, { status: 'refining', session: 'er-i43r' })] });
  // Another repository sharing the account and the abbreviation runs er-i41r (working) and er-i43r (idle).
  w.agent('er-i41r', { state: 'working', record: false, cwd: '/other' });
  w.agent('er-i43r', { state: 'done', record: false, cwd: '/other' });
  // This batch recorded its own er-i43r before launching it, then stopped before the launch returned.
  w.records.push({ name: 'er-i43r', stage: 'refine', issue: 43, pr: null, attempt: 1, account: 'A1', id: null, sessionId: null,
    startedAt: new Date(T(9)).toISOString(), endedAt: null, state: 'working' });
  writeFileSync(join(w.dir, 'sessions.json'), JSON.stringify(w.records));
  w.issues[43] = { refined: true }; // this batch's refine fact, which would stop a bound idle session
  const r = w.tick(T(10));
  assert.deepEqual([r.launched, r.stopped], [['er-i41r2', 'er-i43a'], []]); // its own refine fact moves #43 on
  assert.deepEqual(w.claudeCalls.filter((c) => c.args[0] === 'stop'), []);
  assert.deepEqual(w.sessions().map((x) => [x.name, x.id, x.state]).slice(0, 1), [['er-i43r', null, 'stopped']]);
  assert.deepEqual(w.events().filter((e) => e.type === 'adopt'), []);
});

test('reconcile adopts a session the ledger names only from this batch\'s checkout (C29)', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' })] });
  rmSync(join(w.dir, 'ledger.last.md'));
  w.issues[41] = { refined: true };
  w.agent('er-i41a', { state: 'working', record: false, cwd: '/other' });
  const r = reconcile(w.ctx(T(11)));
  assert.deepEqual([r.adopted, r.unknown, r.launched], [[], ['er-i41a'], []]);
  assert.deepEqual(w.sessions().map((x) => [x.name, x.account, x.state]), [['er-i41a', null, 'unknown']]);
});

test('reconcile keeps a session of an unreadable account matchable until the account answers', () => {
  const w = world({ rows: [row(1, 41, { status: 'implementing', session: 'er-i41a' })], accounts: ['A1', 'A2'] });
  rmSync(join(w.dir, 'ledger.last.md'));
  w.issues[41] = { refined: true };
  w.agent('er-i41a', { alias: 'A2', state: 'working', record: false });
  w.unreadable.add(w.accts[1].dir);
  assert.deepEqual(reconcile(w.ctx(T(11))).unknown, ['er-i41a']);
  w.unreadable.clear();
  const r = w.tick(T(11, 5));
  assert.deepEqual([r.launched, r.stopped], [[], []]);
  assert.deepEqual(w.sessions().map((s) => [s.name, s.account, s.state]), [['er-i41a', 'A2', 'working']]); // adopted once A2 answers
  w.issues[41].pr = { number: 50 };
  w.set('er-i41a', 'done');
  assert.deepEqual(w.tick(T(11, 10)).stopped, ['er-i41a']); // and seen as finished
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
