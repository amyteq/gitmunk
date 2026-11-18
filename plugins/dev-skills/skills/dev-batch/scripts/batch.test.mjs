import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findRegion, parseLedger, renderLedger } from './ledger.mjs';
import { stubBin, tempDir, withPath } from './test-helpers.mjs';

const BATCH = fileURLToPath(new URL('./batch.mjs', import.meta.url));
const REPO = 'example-org/example-repo';
const LOGIN = 'bot-user';
const AUTH = "Owner authorization (2026-11-19 09:00 UTC, coordinator session `er-i40c`, owner's invocation `/dev-batch init src=40`): for every task in this ledger, refine, implement, review, and squash merge each approval-eligible PR.";
const ISSUE = `repos/${REPO}/issues/40`;
const PLAIN = { body: 'Plain issue.', comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// gh answers from the world file (STUB_FIXTURE) and writes source edits and new comments back into it.
const GH = `
const w = fixture();
const save = () => fs.writeFileSync(env.STUB_FIXTURE, JSON.stringify(w));
const out = (v) => process.stdout.write(JSON.stringify(v));
const q = argv.find((a) => a.startsWith('query=')) ?? '';
const field = (k) => argv.find((a) => a.startsWith(k + '='))?.slice(k.length + 1);
const body = () => fs.readFileSync(field('body').slice(1), 'utf8');
if (argv[0] === 'repo') out({ nameWithOwner: w.repo });
else if (argv[1] === 'user') out({ login: w.login });
else if (q.includes('issueOrPullRequest')) {
  const t = w.kinds[field('number')];
  out({ data: { repository: { issueOrPullRequest: t && t !== 'Discussion' ? { __typename: t } : null, discussion: t === 'Discussion' ? { id: 'D_1' } : null } }, errors: [{ type: 'NOT_FOUND' }] });
  process.exitCode = 1;
} else if (q.includes(': issue(number') && w.factsDown) process.exitCode = 1;
else if (q.includes(': issue(number')) out({ data: { repository: Object.fromEntries([...q.matchAll(/issue_(\\d+): issue/g)].map((m) => ['issue_' + m[1], w.node])) } });
else if (argv.includes('POST')) { w.comments.push(body()); save(); out({ id: 900 }); }
else if (argv.includes('PATCH')) { w.sources[argv[3]].body = body(); save(); out({}); }
else if (w.sources[argv[1]]) out(w.sources[argv[1]]);
else { process.stderr.write('unexpected gh ' + argv.join(' ')); process.exitCode = 1; }
`;
// git: the checkout's top level and its origin, from the world file.
const GIT = `
const w = fixture();
if (argv.join(' ') === 'rev-parse --show-toplevel' && w.checkout) process.stdout.write(w.checkout + '\\n');
else if (argv.join(' ') === 'remote get-url origin') process.stdout.write(w.origin + '\\n');
else process.exitCode = 128;
`;
// claude: login per config directory, the agents listed per directory, and a launch that always starts.
const CLAUDE = `
const w = fixture();
const cfg = env.CLAUDE_CONFIG_DIR;
if (argv[0] === 'auth') process.stdout.write(JSON.stringify({ loggedIn: !w.loggedOut.includes(cfg) }));
else if (argv[0] === 'agents') process.stdout.write(JSON.stringify(w.agents[cfg] ?? []));
else if (argv[0] === '--bg') process.stdout.write('Started background session c0ffee01\\n');
`;

// A repository with issue #40 (and #50) as possible sources, stub gh and claude on PATH, and accounts A1… in a temp dir.
function world({ association = 'OWNER', body = 'Intro text.\n', accounts = ['A1'] } = {}) {
  const root = tempDir();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  stubBin(bin, 'gh', GH);
  stubBin(bin, 'claude', CLAUDE);
  stubBin(bin, 'git', GIT);
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const accts = accounts.map((alias) => { const dir = join(root, alias); mkdirSync(dir); return { alias, dir }; });
  const file = join(root, 'world.json');
  const log = join(root, 'stub.log');
  const source = (text) => ({ body: text, user: { login: 'owner-user' }, author_association: association });
  writeFileSync(file, JSON.stringify({ repo: REPO, login: LOGIN, checkout, origin: `git@github.com:${REPO}.git`, kinds: { 40: 'Issue', 50: 'Issue', 9: 'Discussion', 77: 'PullRequest' }, node: PLAIN,
    comments: [], agents: {}, loggedOut: [], sources: { [ISSUE]: source(body), [`repos/${REPO}/issues/50`]: source('Second tracker.\n') } }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DEV_BATCH_|CLAUDE_)/.test(k))),
    PATH: withPath(bin), HOME: root, XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: accts[0].dir,
    DEV_BATCH_ACCOUNTS: JSON.stringify(accts.map((a) => a.dir)), STUB_FIXTURE: file, STUB_LOG: log };
  const w = {
    root, accts, env, checkout, dir: join(root, 'state', 'dev-batch', 'example-org', 'example-repo', 'i40'),
    cli: (...args) => {
      const r = spawnSync(process.execPath, [BATCH, ...args], { cwd: root, env: w.env, encoding: 'utf8' });
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
      return { code: r.status, out, text: r.stdout + r.stderr };
    },
    get: () => json(file),
    set: (fn) => { const v = json(file); fn(v); writeFileSync(file, JSON.stringify(v)); },
    calls: (name, first) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
      .filter((c) => c.name === name && (first === undefined || c.argv[0] === first)),
    tasks: (list) => { const p = join(root, `tasks-${Math.random()}.json`); writeFileSync(p, JSON.stringify(list)); return p; },
    body: () => json(file).sources[ISSUE].body,
    ledger: () => { const b = w.body(); const r = findRegion(b); return parseLedger(b.slice(r.start, r.end)).ledger; },
    file: (name) => join(w.dir, name),
    init: (src = '40') => w.cli('init', '--src', src, '--tasks', w.tasks([{ issue: 41, title: 'Export', deps: [] }, { issue: 42, title: 'Import', deps: [41] }]),
      '--settings', '{"cap":"2"}', '--authorization', AUTH),
  };
  return w;
}

test('ask init without src', () => {
  const w = world();
  const r = w.cli('ask', 'init', 'merge=off');
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.out.questions.map((q) => q.key), ['src', 'cap', 'model_effort']);
  assert.deepEqual([r.out.settings.merge, r.out.sources.merge, r.out.sources.cap, r.out.sources.accounts], ['off', 'argument', 'default', 'environment']);
  assert.equal(w.cli('ask', 'init confirm=no').code, 2); // a required source with the questions skipped
  assert.equal(w.cli('ask', 'init confirm=maybe src=40').code, 2);
});

test('init writes the region and settings', () => {
  const w = world({ body: 'Intro text.\n\n- [ ] #41 Export\n- [x] #42 Import\n\nOutro.\n' });
  const r = w.init();
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.dir, w.dir);
  const body = w.body();
  // The region replaces the task list, which is kept folded right after it; no other text changes.
  assert.ok(body.startsWith('Intro text.\n\n<!-- dev-batch:ledger v=1 -->\n'), body);
  assert.ok(body.endsWith('<!-- /dev-batch:ledger -->\n\n<details><summary>Earlier task list</summary>\n\n- [ ] #41 Export\n- [x] #42 Import\n\n</details>\n\nOutro.\n'), body);
  const l = w.ledger();
  assert.equal(l.authorization, AUTH);
  assert.deepEqual(l.rows.map((x) => [x.n, x.issue, x.title, x.deps, x.batch, x.status]), [[1, 41, 'Export', [], 1, 'queued'], [2, 42, 'Import', [41], 2, 'queued']]);
  assert.deepEqual([l.header.alias, l.header.coordinator, l.header.cap, l.header.merge], ['A1', 'er-i40c', 2, 'auto']);
  const s = json(w.file('settings.json'));
  assert.deepEqual([s.cap, s.repo, s.login, s.abbr, s.authorization, s.paused, s.extra], [2, REPO, LOGIN, 'er', AUTH, false, null]);
  assert.deepEqual([s.sources.cap, s.sources.merge, s.sources.accounts], ['argument', 'default', 'environment']);
  assert.deepEqual(s.src, { kind: 'issue', number: 40 });
  assert.equal(s.cwd, w.checkout); // I9: the checkout the loop and every claude call run in
  const { start, end } = findRegion(body);
  assert.equal(readFileSync(w.file('ledger.last.md'), 'utf8'), body.slice(start, end));

  const again = w.init();
  assert.deepEqual([again.code, again.out.error], [1, 'batch-exists']);
  assert.equal(w.body(), body);
});

test("init on an untrusted author's issue writes a comment", () => {
  const w = world({ association: 'NONE' });
  const r = w.init();
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.movedToComment, `https://github.com/${REPO}/issues/40#issuecomment-900`);
  const { sources, comments } = w.get();
  assert.equal(sources[ISSUE].body, 'Intro text.\n');
  assert.equal(comments.length, 1);
  assert.ok(comments[0].startsWith('<!-- dev-batch:ledger v=1 -->\n'));
  const dir = join(dirname(w.dir), 'c900');
  assert.equal(r.out.dir, dir);
  assert.deepEqual(json(join(dir, 'settings.json')).src, { kind: 'comment', id: 900, parent: { kind: 'issue', number: 40 } });
  assert.equal(existsSync(w.dir), false);
  assert.equal(w.cli('status', 'src=40').out.dir, dir); // the issue still names the batch
});

test('init refuses state-unwritable before any GitHub write when the state directory cannot be written (I6)', () => {
  const w = world();
  writeFileSync(join(w.root, 'not-a-dir'), '');
  w.env = { ...w.env, XDG_STATE_HOME: join(w.root, 'not-a-dir') };
  const r = w.init();
  assert.deepEqual([r.code, r.out?.error], [1, 'state-unwritable'], r.text);
  assert.equal(w.body(), 'Intro text.\n');
  assert.deepEqual([w.calls('gh').filter((c) => c.argv.includes('PATCH') || c.argv.includes('POST')), w.get().comments], [[], []]);
});

test('init with no tasks writes nothing', () => {
  const w = world();
  const r = w.cli('init', '--src', '40', '--tasks', w.tasks([]), '--settings', '{}');
  assert.deepEqual([r.code, r.out.error], [1, 'no-tasks']);
  assert.equal(w.body(), 'Intro text.\n');
  assert.equal(existsSync(join(w.root, 'state')), false);
});

test('init with a cycle exits 1 naming it', () => {
  const w = world();
  const tasks = [{ issue: 41, title: 'A', deps: [43] }, { issue: 42, title: 'B', deps: [] }, { issue: 43, title: 'C', deps: [41] }];
  const r = w.cli('init', '--src', '40', '--tasks', w.tasks(tasks), '--settings', '{}');
  assert.deepEqual([r.code, r.out.error, r.out.cycle], [1, 'cycle', [41, 43]]);
  assert.match(r.out.detail, /#41.*#43/);
  assert.equal(w.body(), 'Intro text.\n');
  assert.equal(existsSync(join(w.root, 'state')), false);
});

test('init refuses a pull request, another repository and a malformed source', () => {
  const w = world();
  for (const src of ['77', '61', `https://github.com/other-org/other-repo/issues/40`, '../40', `https://github.com/${REPO}/pull/40`, `https://github.com/${REPO}/issues/40#discussioncomment-1`]) {
    const r = w.cli('init', '--src', src, '--tasks', w.tasks([{ issue: 41, title: 'A', deps: [] }]), '--settings', '{}');
    assert.deepEqual([r.code, r.out?.error], [1, 'bad-source'], `${src}: ${r.text}`);
  }
  assert.equal(existsSync(join(w.root, 'state')), false);
});

test('the batch is found by src=, session= or as the only active one', () => {
  const w = world();
  w.init();
  for (const words of [[], ['src=40'], ['src=#40'], [`src=https://github.com/${REPO}/issues/40`], ['session=er-i40c'], ['--batch', w.dir]]) {
    assert.equal(w.cli('status', ...words).out?.dir, w.dir, words.join(' '));
  }
  const s = w.cli('status').out;
  assert.deepEqual([s.rollCall, s.pending, s.loop.alive, s.loop.paused], [{ tasks: 2, queued: 2 }, 0, false, false]);
  assert.deepEqual([w.cli('status', 'session=nope').code, w.cli('status', 'session=nope').out.error], [1, 'no-batch']);

  w.init('50');
  const several = w.cli('status');
  assert.deepEqual([several.code, several.out.error, several.out.candidates.length], [1, 'several-batches', 2]);
  assert.equal(w.cli('status', 'src=50').out.dir, join(dirname(w.dir), 'i50'));
});

test('config prints sources', () => {
  const w = world();
  w.init();
  let r = w.cli('config');
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([r.out.settings.cap, r.out.sources.cap, r.out.sources.rounds, r.out.sources.accounts], [2, 'argument', 'default', 'environment']);
  r = w.cli('config', 'cap=6', 'extra=be brief', 'model_effort=opus high');
  assert.equal(r.code, 0, r.text);
  r = w.cli('config');
  assert.deepEqual([r.out.settings.cap, r.out.sources.cap, r.out.settings.extra, r.out.settings.effort, r.out.sources.rounds], [6, 'config', 'be brief', 'high', 'default']);
  assert.equal(w.cli('config', 'cap=0').code, 2);
  assert.equal(json(w.file('settings.json')).cap, 6);

  // §11: the owner deleted the authorization line; config re-records it and restores it in the region.
  w.set((x) => { x.sources[ISSUE].body = x.sources[ISSUE].body.replace(`${AUTH}\n`, ''); });
  const again = AUTH.replace('init src=40', 'config merge=auto');
  r = w.cli('config', '--authorization', again);
  assert.equal(r.code, 0, r.text);
  assert.equal(w.ledger().authorization, again);
  assert.equal(json(w.file('settings.json')).authorization, again);
  assert.equal(w.cli('config', '--authorization', 'merge everything').code, 2);
});

test('config, pause and resume record a setting-change event; showing the settings records none (I10)', () => {
  const w = world();
  w.init();
  const changes = () => lines(w.file('events.jsonl')).filter((e) => e.type === 'setting-change').map((e) => e.detail);
  w.cli('config');
  assert.deepEqual(changes(), []);
  assert.equal(w.cli('config', 'cap=3', 'extra=be brief').code, 0);
  assert.equal(w.cli('pause').code, 0);
  assert.equal(w.cli('resume').code, 0);
  assert.deepEqual(changes(), ['config: cap, extra', 'paused', 'resumed']);
});

test('wait through the CLI wakes on a judgment a tick queues, and records the wake (I10, M14)', async () => {
  const w = world();
  w.init();
  const waiting = spawn(process.execPath, [BATCH, 'wait', '--timeout', '60'], { cwd: w.root, env: w.env });
  let out = '';
  waiting.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((done) => waiting.on('exit', done));
  await sleep(300);
  w.set((v) => { v.sources[ISSUE].body = 'The region is gone.\n'; }); // the next tick raises ledger-region
  assert.equal(w.cli('tick').code, 0);
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(out).events.map((e) => e.type), ['ledger-region']);
  const wakes = lines(w.file('events.jsonl')).filter((e) => e.type === 'wake');
  assert.deepEqual(wakes.map((e) => e.detail), ['ledger-region']);
  assert.deepEqual([w.cli('wait', '--timeout', '0').code, lines(w.file('events.jsonl')).filter((e) => e.type === 'wake').length], [3, 1]);
});

test('merge=auto needs the merge clause in the authorization line: init, config and launch refuse it (I1)', () => {
  const w = world();
  const line = AUTH.replace(', and squash merge each approval-eligible PR.', '.');
  const init = (settings) => w.cli('init', '--src', '40', '--tasks', w.tasks([{ issue: 41, title: 'Export', deps: [] }]), '--settings', settings, '--authorization', line);
  const refused = init('{}');
  assert.deepEqual([refused.code, refused.out.error], [1, 'merge-not-authorized'], refused.text);
  assert.equal(w.body(), 'Intro text.\n');
  assert.equal(existsSync(join(w.root, 'state')), false);

  assert.equal(init('{"merge":"off"}').code, 0);
  assert.equal(w.cli('config', 'merge=auto').out.error, 'merge-not-authorized');
  assert.equal(json(w.file('settings.json')).merge, 'off');
  assert.equal(w.cli('config', 'merge=auto', '--authorization', AUTH).code, 0); // granted with the clause in one call
  assert.equal(w.cli('config', '--authorization', line).out.error, 'merge-not-authorized');
  assert.deepEqual([json(w.file('settings.json')).authorization, w.ledger().authorization], [AUTH, AUTH]);

  // A batch whose recorded line lacks the clause (edited by hand) never launches a merge.
  w.set((x) => { x.sources[ISSUE].body = x.sources[ISSUE].body.replace(AUTH, line); });
  writeFileSync(w.file('settings.json'), JSON.stringify({ ...json(w.file('settings.json')), authorization: line }));
  const launch = w.cli('launch', '--task', '41', '--stage', 'merge');
  assert.deepEqual([launch.code, launch.out.error], [1, 'merge-not-authorized'], launch.text);
  assert.deepEqual(w.calls('claude', '--bg'), []);
});

test('a command that starts the loop or a session refuses checkout-missing once the checkout is gone (I9)', () => {
  const w = world();
  w.init();
  rmSync(w.checkout, { recursive: true });
  for (const args of [['start'], ['tick'], ['launch', '--task', '41', '--stage', 'refine'], ['add', '--tasks', w.tasks([{ issue: 43, title: 'X', deps: [] }])]]) {
    const r = w.cli(...args);
    assert.deepEqual([r.code, r.out?.error], [1, 'checkout-missing'], `${args[0]}: ${r.text}`);
  }
  assert.equal(existsSync(w.file('loop.log')), false);
  assert.deepEqual([w.cli('status').code, w.cli('pause').code], [0, 0]); // reading and pausing still work
});

test('start refuses while the lease is held', () => {
  const w = world();
  w.init();
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'n1' }));
  const r = w.cli('start');
  assert.deepEqual([r.code, r.out.error], [1, 'lease-held']);
  assert.equal(json(w.file('lease.json')).nonce, 'n1');
  assert.equal(existsSync(w.file('loop.log')), false);
});

test('a command never signals another command that holds the lease', () => {
  const w = world();
  w.init();
  // This test process stands in for a running `add`: a SIGTERM to it would end the test run.
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: process.pid, host: hostname(), holder: 'cli', nonce: 'n1' }));
  for (const args of [['add', '--tasks', w.tasks([{ issue: 43, title: 'X', deps: [] }])], ['stop'], ['rm', '--task', '41']]) {
    const r = w.cli(...args);
    assert.deepEqual([r.code, r.out.error], [1, 'lease-held'], args[0]);
  }
  assert.equal(json(w.file('lease.json')).nonce, 'n1');

  // A loop's lease whose pid now belongs to another process (recycled after a restart) is never signalled either;
  // stop drops it.
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'n2' }));
  assert.deepEqual([w.cli('rm', '--task', '41').code, w.cli('rm', '--task', '41').out.error], [1, 'lease-held']);
  const r = w.cli('stop');
  assert.deepEqual([r.code, r.out.stopped], [0, false], r.text);
  assert.equal(existsSync(w.file('lease.json')), false);
});

test('start runs the loop detached and stop ends it between ticks, releasing the lease', async (t) => {
  const w = world();
  w.init();
  w.cli('pause');
  const r = w.cli('start');
  assert.equal(r.code, 0, r.text);
  t.after(() => { try { process.kill(r.out.pid); } catch { /* already gone */ } });
  for (let i = 0; i < 100 && !existsSync(w.file('loop.json')); i++) await sleep(100); // its first tick is done
  assert.equal(json(w.file('lease.json')).pid, r.out.pid);
  const s = w.cli('stop');
  assert.deepEqual([s.code, s.out.stopped, s.out.exited], [0, true, true], s.text);
  assert.equal(existsSync(w.file('lease.json')), false);
  assert.match(readFileSync(w.file('loop.log'), 'utf8'), /"stopped":"SIGTERM"/);
});

test("takeover refuses while the loop lives here, needs --force for another host's lease, then reconciles and starts", async (t) => {
  const w = world({ accounts: ['A1', 'A2'] });
  w.init();
  w.cli('pause');
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'n1' }));
  assert.deepEqual([w.cli('takeover').code, w.cli('takeover').out.error], [1, 'lease-held']);
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: 1, host: 'other-host', nonce: 'n2' }));
  assert.deepEqual([w.cli('takeover').code, w.cli('takeover').out.error], [1, 'lease-foreign']);
  assert.equal(json(w.file('lease.json')).nonce, 'n2');

  w.set((v) => { v.loggedOut = [w.accts[1].dir]; });
  const r = w.cli('takeover', '--force');
  assert.equal(r.code, 0, r.text);
  t.after(() => { try { process.kill(r.out.loop.pid); } catch { /* already gone */ } });
  assert.deepEqual([r.out.adopted, r.out.unknown, r.out.loop.started], [[], [], true]);
  // I10: every configured account is checked; the loop skips one that is not logged in.
  assert.deepEqual(r.out.warnings, [`account A2 (${w.accts[1].dir}) is not logged in: no session launches in it until it is`]);
  const holder = () => (existsSync(w.file('lease.json')) ? json(w.file('lease.json')).pid : null);
  for (let i = 0; i < 100 && holder() !== r.out.loop.pid; i++) await sleep(100);
  assert.equal(holder(), r.out.loop.pid);
  assert.equal(w.cli('stop').out.exited, true);
});

// Another machine: the region on GitHub exists, the local state directory does not.
function elsewhere(opts) {
  const w = world(opts);
  assert.equal(w.init().code, 0);
  rmSync(join(w.root, 'state'), { recursive: true, force: true });
  w.set((v) => { v.factsDown = true; }); // the started loop's ticks stop before any write, so the rebuilt files stay as written
  return w;
}
async function stopLoopOf(w, dir, r) {
  const holder = () => (existsSync(join(dir, 'lease.json')) ? json(join(dir, 'lease.json')).pid : null);
  for (let i = 0; i < 100 && holder() !== r.out.loop.pid; i++) await sleep(100);
  assert.equal(holder(), r.out.loop.pid);
  assert.equal(w.cli('stop', '--batch', dir).out.exited, true);
}

test('takeover src= without --force refuses lease-foreign before it rebuilds anything (I2)', () => {
  const w = elsewhere();
  const reads = () => w.calls('gh').filter((c) => c.argv[0] === 'api' && c.argv[1] === ISSUE).length;
  const before = reads();
  const r = w.cli('takeover', 'src=40');
  assert.deepEqual([r.code, r.out.error], [1, 'lease-foreign'], r.text);
  assert.equal(existsSync(join(w.root, 'state')), false);
  assert.equal(reads(), before); // the source was not even read
});

test('takeover src= on a machine without the state directory rebuilds it from the region and starts the loop', async (t) => {
  const w = elsewhere({ body: 'Intro text.\r\n' });
  const region = w.body().slice(findRegion(w.body()).start, findRegion(w.body()).end);
  const r = w.cli('takeover', `src=https://github.com/${REPO}/issues/40`, 'merge=off', '--force');
  assert.equal(r.code, 0, r.text);
  t.after(() => { try { process.kill(r.out.loop.pid); } catch { /* already gone */ } });
  assert.deepEqual([r.out.rebuilt, r.out.authorization, r.out.extra, r.out.loop.started], [w.dir, 'needs-owner', 'unrecovered', true]);
  const s = json(w.file('settings.json'));
  assert.deepEqual([s.cap, s.sources.cap, s.merge, s.sources.merge, s.sources.accounts], [2, 'ledger', 'off', 'argument', 'environment']);
  assert.deepEqual([s.repo, s.login, s.abbr, s.authorization, s.extra, s.paused, s.cwd], [REPO, LOGIN, 'er', null, null, false, w.checkout]);
  assert.deepEqual(s.src, { kind: 'issue', number: 40 });
  assert.deepEqual(json(w.file('sessions.json')), []);
  assert.ok(region.includes('\r\n'));
  assert.equal(readFileSync(w.file('ledger.last.md'), 'utf8'), region.replace(/\r\n/g, '\n'));
  await stopLoopOf(w, w.dir, r);
  assert.equal(w.cli('takeover', 'session=nobody').out.error, 'no-batch'); // without src= there is nothing to rebuild from
  assert.equal(w.cli('takeover', 'src=40', 'cap=3').code, 2); // a local batch changes its settings with config
  assert.equal(json(w.file('settings.json')).cap, 2);
});

test('takeover src= rebuilds only from a trusted source with a valid region, else exits 1 and writes nothing', async (t) => {
  const w = elsewhere();
  const state = join(w.root, 'state');
  const original = w.body();
  const take = (...words) => w.cli('takeover', ...words, '--force');
  w.set((v) => { v.origin = 'https://github.com/other-org/example-repo.git'; }); // I9: a checkout of another repository
  assert.deepEqual([take('src=40').code, take('src=40').out.error], [1, 'checkout-missing']);
  w.set((v) => { v.origin = `https://github.com/${REPO}`; v.sources[ISSUE].author_association = 'NONE'; });
  assert.deepEqual([take('src=40').code, take('src=40').out.error], [1, 'untrusted-source']);
  w.set((v) => { v.sources[ISSUE].author_association = 'OWNER'; v.sources[ISSUE].body = 'No region here.\n'; });
  assert.deepEqual([take('src=40').code, take('src=40').out.error], [1, 'ledger-region']);
  assert.equal(existsSync(state), false);

  // A comment: trusted when its author is the signed-in account, whatever its association.
  const COMMENT = `repos/${REPO}/issues/comments/900`;
  const { start, end } = findRegion(original);
  w.set((v) => { v.sources[COMMENT] = { body: `Notes.\n${original.slice(start, end)}\n`, user: { login: 'someone' }, author_association: 'NONE' }; });
  const url = `src=https://github.com/${REPO}/issues/40#issuecomment-900`;
  assert.deepEqual([take(url).code, take(url).out.error], [1, 'untrusted-source']);
  assert.equal(existsSync(state), false);
  w.set((v) => { v.sources[COMMENT].user.login = LOGIN; });
  const r = take(url);
  assert.equal(r.code, 0, r.text);
  t.after(() => { try { process.kill(r.out.loop.pid); } catch { /* already gone */ } });
  const dir = join(dirname(w.dir), 'c900');
  assert.equal(r.out.rebuilt, dir);
  assert.deepEqual(json(join(dir, 'settings.json')).src, { kind: 'comment', id: 900, parent: { kind: 'issue', number: 40 } });
  await stopLoopOf(w, dir, r);
});

test('stop keeps the lease and says loop-busy while the loop is still in a tick', async (t) => {
  const w = world();
  w.init();
  // A sleeper that ignores SIGTERM stands in for a loop in a long tick; its arguments look like the loop's.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)", 'run', '--batch', w.dir],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((ready) => child.stdout.once('data', ready));
  writeFileSync(w.file('lease.json'), JSON.stringify({ pid: child.pid, host: hostname(), nonce: 'n1' }));
  const r = w.cli('stop');
  assert.deepEqual([r.code, r.out.error], [1, 'loop-busy'], r.text);
  assert.equal(json(w.file('lease.json')).nonce, 'n1');
  assert.deepEqual([w.cli('takeover').code, w.cli('takeover').out.error], [1, 'lease-held']); // no second loop meanwhile
});

test('handover to the current or a logged-out account warns and changes nothing', () => {
  const w = world({ accounts: ['A1', 'A2', 'A3'] });
  w.init();
  w.set((x) => { x.loggedOut = [w.accts[1].dir]; });
  const files = () => ['settings.json', 'ledger.last.md'].map((f) => readFileSync(w.file(f), 'utf8'));
  const before = files();
  const body = w.body();
  for (const acct of ['A1', w.accts[0].dir, 'A2', 'A9', '']) {
    const r = w.cli('handover', '--acct', acct);
    assert.equal(r.code, 1, `${acct}: ${r.text}`);
    assert.ok(r.out.warning, acct);
  }
  assert.deepEqual(files(), before);
  assert.equal(w.body(), body);
  assert.equal(existsSync(w.file('ledger.next.md')), false);
  assert.deepEqual(w.calls('claude', '--bg'), []);
});

test('handover pauses, records the new coordinator in the region and launches it in the target account', () => {
  const w = world({ accounts: ['A1', 'A2'] });
  w.init();
  const r = w.cli('handover', '--acct', 'A2');
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.session, 'er-i40c2');
  assert.equal(json(w.file('settings.json')).paused, 'handover');
  const l = w.ledger();
  assert.deepEqual([l.header.alias, l.header.coordinator, l.header.loop], ['A2', 'er-i40c2', 'paused']);
  assert.match(l.log.at(-1).event, /handover: A1 → A2/);
  const [launch] = w.calls('claude', '--bg');
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, w.accts[1].dir);
  assert.equal(launch.argv[launch.argv.indexOf('--name') + 1], 'er-i40c2');
  assert.equal(launch.argv.at(-1), `/dev-batch takeover src=https://github.com/${REPO}/issues/40`);
});

test('handover then the target account\'s takeover lifts the handover pause and starts the loop there; an owner\'s pause stays (M14)', async (t) => {
  const w = world({ accounts: ['A1', 'A2'] });
  w.init();
  assert.equal(w.cli('handover', '--acct', 'A2').code, 0);
  w.env = { ...w.env, CLAUDE_CONFIG_DIR: w.accts[1].dir }; // the new coordinator runs in A2
  const r = w.cli('takeover');
  assert.equal(r.code, 0, r.text);
  t.after(() => { try { process.kill(r.out.loop.pid); } catch { /* already gone */ } });
  assert.equal(json(w.file('settings.json')).paused, false);
  assert.deepEqual([w.ledger().header.alias, w.ledger().header.coordinator], ['A2', 'er-i40c2']);
  await stopLoopOf(w, w.dir, r);

  assert.equal(w.cli('pause').code, 0); // the owner's pause survives the next handover and takeover
  w.env = { ...w.env, CLAUDE_CONFIG_DIR: w.accts[1].dir };
  assert.equal(w.cli('handover', '--acct', 'A1').code, 0);
  w.env = { ...w.env, CLAUDE_CONFIG_DIR: w.accts[0].dir };
  const back = w.cli('takeover');
  assert.equal(back.code, 0, back.text);
  t.after(() => { try { process.kill(back.out.loop.pid); } catch { /* already gone */ } });
  assert.equal(json(w.file('settings.json')).paused, true);
  await stopLoopOf(w, w.dir, back);
});

test('add puts rows where asked and holds follow-ups; rm removes a row; both write the region', () => {
  const w = world();
  w.init();
  w.cli('pause');
  let r = w.cli('add', '--tasks', w.tasks([{ issue: 43, title: 'Bulk delete', deps: [] }]), '--pos', '1');
  assert.equal(r.code, 0, r.text);
  r = w.cli('add', '--tasks', w.tasks([{ issue: 44, title: 'Follow-up', deps: [42] }]), '--hold', 'follow-up, not queued');
  assert.equal(r.code, 0, r.text);
  const rows = w.ledger().rows;
  assert.deepEqual(rows.map((x) => [x.n, x.issue, x.batch, x.status]), [[1, 43, 1, 'queued'], [2, 41, 1, 'queued'], [3, 42, 2, 'waiting'], [4, 44, 3, 'hold']]);
  assert.equal(rows[3].next, 'follow-up, not queued');
  assert.equal(w.cli('add', '--tasks', w.tasks([{ issue: 41, title: 'Again', deps: [] }])).out.error, 'already-in-ledger');
  assert.equal(w.cli('add', '--tasks', w.tasks([{ issue: 45, title: 'X', deps: [] }]), '--pos', '9').code, 2);

  r = w.cli('rm', '--task', '43');
  assert.equal(r.code, 0, r.text);
  assert.equal(w.ledger().rows[0].status, 'removed');
  assert.equal(w.cli('rm', '--task', '99').out.error, 'no-such-task');
  assert.equal(existsSync(w.file('ledger.next.md')), false);
  assert.equal(existsSync(w.file('lease.json')), false);
});

test('add refuses an issue that is already closed and writes nothing (NB1)', () => {
  const w = world();
  w.init();
  const [body, ledger] = [w.body(), readFileSync(w.file('ledger.last.md'), 'utf8')];
  w.set((v) => { v.node = { ...v.node, state: 'CLOSED' }; });
  const r = w.cli('add', '--tasks', w.tasks([{ issue: 43, title: 'Done already', deps: [] }]));
  assert.deepEqual([r.code, r.out?.error, r.out?.issues], [1, 'issue-closed', [43]], r.text);
  assert.deepEqual([w.body(), readFileSync(w.file('ledger.last.md'), 'utf8')], [body, ledger]);
});

test('launch replaces a stuck unknown session record and relaunches the stage', () => {
  const w = world();
  w.init();
  w.cli('pause');
  writeFileSync(w.file('sessions.json'), JSON.stringify([{ name: 'er-i41r', stage: 'refine', issue: 41, pr: null, attempt: 1, account: null, id: null,
    sessionId: null, startedAt: '2026-11-19T09:00:00.000Z', endedAt: null, state: 'unknown' }]));
  const r = w.cli('launch', '--task', '41', '--stage', 'refine');
  assert.equal(r.code, 0, r.text);
  assert.equal(r.out.launched, 'er-i41r2');
  // The stuck record is retired, not deleted, so its name stays taken.
  assert.deepEqual(json(w.file('sessions.json')).map((x) => [x.name, x.state, x.account]), [['er-i41r', 'stopped', null], ['er-i41r2', 'working', 'A1']]);
  const [launch] = w.calls('claude', '--bg');
  assert.match(launch.argv.at(-1), /^\/dev-refine-issue 41\n/);
  assert.equal(launch.cwd, w.checkout); // I9: wherever the command was run from
  assert.deepEqual([w.ledger().rows[0].status, w.ledger().rows[0].session], ['refining', 'er-i41r2']);
  assert.equal(w.cli('launch', '--task', '42', '--stage', 'review').out.error, 'no-pr');
});

test('clear stops only idle sessions whose stage is finished', () => {
  const w = world();
  w.init();
  const last = parseLedger(readFileSync(w.file('ledger.last.md'), 'utf8')).ledger;
  last.rows[0].status = 'implementing';
  last.rows[1].status = 'refining';
  writeFileSync(w.file('ledger.last.md'), renderLedger(last));
  const rec = (name, stage, issue) => ({ name, stage, issue, pr: null, attempt: 1, account: 'A1', id: name, sessionId: null, startedAt: '2026-11-19T09:00:00.000Z', endedAt: null, state: 'done' });
  writeFileSync(w.file('sessions.json'), JSON.stringify([rec('er-i41r', 'refine', 41), rec('er-i41a', 'implement', 41), rec('er-i42r', 'refine', 42)]));
  w.set((x) => { x.agents[w.accts[0].dir] = [['er-i41r', 'done'], ['er-i41a', 'working'], ['er-i42r', 'done'], ['er-i40c', 'done']].map(([name, state]) => ({ id: name, name, state })); });
  const r = w.cli('clear');
  assert.deepEqual([r.code, r.out], [0, { stopped: 1 }]);
  assert.deepEqual(w.calls('claude', 'stop').map((c) => c.argv[1]), ['er-i41r']);
});

test('setup without --apply writes nothing', () => {
  const w = world({ accounts: ['A1', 'A2'] });
  writeFileSync(join(w.accts[0].dir, 'settings.json'), '{"theme":"dark"}');
  const r = w.cli('setup', 'cap=6');
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.out.accounts.map((a) => [a.alias, a.applied]), [['A1', false], ['A2', false]]);
  assert.ok(r.out.accounts[0].changes.includes('env DEV_BATCH_CAP=6'));
  assert.equal(readFileSync(join(w.accts[0].dir, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.deepEqual(readdirSync(w.accts[0].dir), ['settings.json']);
  assert.deepEqual(readdirSync(w.accts[1].dir), []);

  writeFileSync(join(w.accts[1].dir, 'settings.json'), '{oops');
  const bad = w.cli('setup', '--apply', '--acct', 'A2');
  assert.deepEqual([bad.code, bad.out.error], [1, 'unreadable-settings']);
  assert.deepEqual(readdirSync(w.accts[1].dir), ['settings.json']);
});

test('bad flags exit 2', () => {
  const w = world();
  w.init();
  for (const args of [['frobnicate'], [], ['init', '--nope'], ['init', '--src', '40'], ['wait', '--timeout', 'soon'], ['config', 'bogus=1'],
    ['rm', '--task', 'x'], ['status', 'stray'], ['launch', '--task', '41', '--stage', 'deploy'], ['stop', '--force=yes']]) {
    const r = w.cli(...args);
    assert.deepEqual([r.code, r.out?.error], [2, 'usage'], `${args.join(' ')}: ${r.text}`);
  }
  assert.deepEqual([w.cli('wait', '--timeout', '0').code, w.cli('wait', '--timeout', '0').out], [3, { timeout: true }]);
});
