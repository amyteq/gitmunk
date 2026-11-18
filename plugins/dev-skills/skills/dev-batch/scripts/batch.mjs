#!/usr/bin/env node
// The dev-batch CLI (spec §6, §10, §11, §13, §14): the one entry point the skill drives. Every sub-command prints
// exactly one JSON object on stdout; diagnostics go to stderr. Exit codes: 0 ok, 1 refused ({ error } or { warning }),
// 2 bad flags or input, 3 a `wait` timeout. The decisions live in the modules; this file wires them to gh, claude
// and the batch's state directory.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chooseAccount, readSnapshot } from './accounts.mjs';
import { layers } from './advance.mjs';
import { InputError, SETTINGS, askQuestions, deriveAbbr, parseInvocation, repoStateDir, resolveSettings, stateDir } from './config.mjs';
import * as events from './events.mjs';
import { GithubUnavailable, createComment, discussionCommentNode, fetchFacts, issueFacts, readSource, sourceKind, sourceUrl, writeSource } from './facts.mjs';
import { findRegion, foldEarlierList, parseLedger, renderLedger, spliceLedger } from './ledger.mjs';
import * as loop from './loop.mjs';
import { appendedScope, coordinatorName, grantsMerge, nextFreeName, sessionName, stagePrompt } from './prompts.mjs';
import * as sessions from './sessions.mjs';
import { applySetup, planSetup } from './setup.mjs';

const SELF = fileURLToPath(import.meta.url);
const HOST = hostname();
const env = process.env;
const STAGES = { refine: 'refining', implement: 'implementing', review: 'reviewing', merge: 'merging' };
const PIPELINE = ['refining', 'implementing', 'reviewing', 'merging', 'merged'];
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ENDED = new Set(['stopped', 'failed']);
const IDLE = new Set(['done', 'blocked']);

class Exit extends Error {
  constructor(code, out) { super(out.error ?? out.warning ?? 'exit'); Object.assign(this, { code, out }); }
}
const refuse = (error, more = {}) => { throw new Exit(1, { error, ...more }); };
const warn = (warning) => { throw new Exit(1, { warning }); };
const bad = (detail) => { throw new Exit(2, { error: 'usage', detail }); };
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- Files of the batch's state directory ----

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
const writeJson = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
const settingsOf = (dir) => readJson(join(dir, 'settings.json')) ?? refuse('bad-settings', { detail: `${join(dir, 'settings.json')} is unreadable` });
const saveSettings = (dir, settings) => writeJson(join(dir, 'settings.json'), settings); // the loop applies it within 15 s
// The rows the loop decides from: decisions not yet written (ledger.next.md), else the region it last wrote.
const ledgerOf = (dir) => parseLedger(read(join(dir, 'ledger.next.md')) ?? read(join(dir, 'ledger.last.md')) ?? '').ledger;
// Changes those rows; the next tick writes them, applying owner edits made on GitHub since on top (loop.mjs).
function changeLedger(dir, fn) {
  const ledger = ledgerOf(dir);
  fn(ledger);
  ledger.rows.forEach((r, i) => { r.n = i + 1; });
  writeAtomic(join(dir, 'ledger.next.md'), renderLedger(ledger));
}
const utc = (d = new Date()) => d.toISOString().slice(0, 16).replace('T', ' ');

// ---- GitHub, accounts and the loop's adapters ----

const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); // the facts of a large batch exceed 1 MB
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
};
function ghJson(args) {
  const r = gh(args);
  let value = null;
  try { if (r.code === 0) value = JSON.parse(r.stdout); } catch { /* below */ }
  return value ?? refuse('github-unavailable', { detail: `gh ${args.slice(0, 2).join(' ')}: ${r.stderr.trim() || `exit ${r.code}`}` });
}
const currentRepo = () => ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
const currentDir = () => resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'));
const cli = (account) => ({ configDir: account.dir });
const usageText = (dir) => { const s = readSnapshot(dir, Date.now()); return s ? `5h ${s.five ?? '?'}% · 7d ${s.seven ?? '?'}%` : 'usage unknown'; };
const loopCtx = (dir) => ({ dir, settings: settingsOf(dir), gh, now: Date.now(), host: HOST, pid: process.pid });
const brief = (t) => ({ wrote: t.wrote, launched: t.launched, stopped: t.stopped, ...(t.githubDown && { githubDown: true }) });
const tickNow = (dir) => brief(loop.tick(loopCtx(dir)));

// ---- Sources (§6): `<n>`, `#<n>`, or an issue, discussion, issue-comment or discussion-comment URL of this repository ----

// Digits only, so a source never escapes the state directory.
const num = (s) => (Number.isSafeInteger(Number(s)) && Number(s) > 0 ? Number(s) : refuse('bad-source', { detail: `not a number: ${s}` }));
function parseSrc(text, repo) {
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return { number: num(bare[1]) };
  const prefix = `https://github.com/${repo}/`;
  const m = text.toLowerCase().startsWith(prefix.toLowerCase())
    && /^(issues|discussions)\/(\d+)(?:#(issuecomment|discussioncomment)-(\d+))?$/.exec(text.slice(prefix.length));
  if (!m || (m[3] && (m[1] === 'issues') !== (m[3] === 'issuecomment'))) refuse('bad-source', { detail: `not an issue, discussion or comment of ${repo}: ${text}` });
  const kind = m[1] === 'issues' ? 'issue' : 'discussion';
  return m[4] ? { kind: 'comment', id: num(m[4]), parent: { kind, number: num(m[2]) } } : { kind, number: num(m[2]) };
}

// init's source, checked on GitHub: an issue or discussion (never a pull request), or a comment with its node id.
function resolveSrc(text, repo) {
  const src = parseSrc(text, repo);
  if (src.kind !== 'comment') {
    const kind = sourceKind({ repo, number: src.number, gh });
    if ((kind !== 'issue' && kind !== 'discussion') || (src.kind && src.kind !== kind)) {
      refuse('bad-source', { detail: `#${src.number} is ${kind === 'pull-request' ? 'a pull request' : kind ? `a ${kind}` : 'not an issue or discussion'} of ${repo}` });
    }
    src.kind = kind;
  }
  if (src.parent?.kind === 'discussion') {
    src.nodeId = discussionCommentNode({ repo, number: src.parent.number, id: src.id, gh })
      ?? refuse('bad-source', { detail: `discussion #${src.parent.number} has no comment ${src.id}` });
  }
  return src;
}

// ---- Locating the batch (§6) ----

function batchDirs(repo) {
  const [owner, name] = repo.split('/');
  const root = repoStateDir({ owner, repo: name }, env);
  return (existsSync(root) ? readdirSync(root) : []).map((k) => join(root, k)).filter((d) => existsSync(join(d, 'settings.json')));
}
const active = (dir) => !existsSync(join(dir, 'summary.json')); // the loop writes summary.json when the batch completes
// An issue or discussion also names the batch whose ledger moved to a comment on it (§6).
const named = (dirs, want) => dirs.filter((d) => {
  const { src } = settingsOf(d);
  return want.id ? src.id === want.id : (src.number ?? src.parent?.number) === want.number;
});
const describe = (dir) => {
  const s = settingsOf(dir);
  return { dir, src: sourceUrl(s.repo, s.src), coordinator: ledgerOf(dir).header.coordinator, active: active(dir) };
};

function locate(flags, words) {
  if (flags.batch) {
    const dir = resolve(flags.batch);
    return existsSync(join(dir, 'settings.json')) ? dir : refuse('no-batch', { detail: `no batch in ${dir}` });
  }
  const repo = currentRepo();
  const all = batchDirs(repo);
  const found = words.src ? named(all, parseSrc(words.src, repo))
    : words.session ? all.filter((d) => ledgerOf(d).header.coordinator === words.session) : all.filter(active);
  if (found.length === 1) return found[0];
  return refuse(found.length ? 'several-batches' : 'no-batch', { candidates: (found.length ? found : all).map(describe) });
}

// ---- The loop's lease (§10, §13) ----

const leaseOf = (dir) => readJson(join(dir, 'lease.json'));
const aliveHere = (lease) => !!lease && lease.host === HOST && events.pidAlive(lease.pid);
const foreign = (lease) => refuse('lease-foreign', { detail: `the lease belongs to ${lease.host}, which cannot be checked from here: pass --force to take it`, lease });
// Another batch.mjs command holds the lease for a moment; only the loop is ever told to stop.
const busyCommand = (lease) => (aliveHere(lease) && lease.holder === 'cli' ? refuse('lease-held', { detail: 'another command holds the lease; run this one again', lease }) : lease);
// The lease's pid is still this batch's loop. A pid can be recycled after a restart: nothing else is ever signalled.
const loopHere = (lease, dir) => aliveHere(lease) && lease.holder !== 'cli'
  && (spawnSync('ps', ['-ww', '-p', String(lease.pid), '-o', 'args='], { encoding: 'utf8' }).stdout ?? '').includes(` run --batch ${dir}`);

function startLoop(dir) {
  const fd = openSync(join(dir, 'loop.log'), 'a');
  try {
    const child = spawn(process.execPath, [SELF, 'run', '--batch', dir], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return { started: true, pid: child.pid };
  } finally { closeSync(fd); }
}

// SIGTERM to this batch's loop (callers check loopHere), which exits between ticks (see `run`). → true once gone within `ms`.
async function stopLoop(lease, ms) {
  process.kill(lease.pid, 'SIGTERM');
  for (const end = Date.now() + ms; events.pidAlive(lease.pid) && Date.now() < end;) await sleep(100);
  return !events.pidAlive(lease.pid);
}

// Runs `work` under the batch's lease, so no loop changes the state files meanwhile: a live loop on this host is
// stopped first and started again afterwards (its first tick is immediate). Another host's lease needs `force`.
async function underLease(dir, work, { restart = true, force = false } = {}) {
  const was = busyCommand(leaseOf(dir));
  const running = loopHere(was, dir);
  if (running && !(await stopLoop(was, 60_000))) {
    refuse('loop-busy', { detail: `the loop (pid ${was.pid}) stops after its current tick and keeps the lease until then: run this command again, then start` });
  }
  const { alias, coordinator } = ledgerOf(dir).header;
  let lease;
  for (let tries = 0; (lease = events.takeLease(dir, { pid: process.pid, host: HOST, alias, coordinator, holder: 'cli', force })).busy && tries < 20; tries++) await sleep(250);
  if (!lease.ok) {
    if (lease.held && lease.held.host !== HOST) foreign(lease.held);
    refuse('lease-held', { detail: 'another command holds the lease; run it again', lease: lease.held ?? null });
  }
  let restarted = null;
  let out;
  try { out = work(); } finally {
    events.releaseLease(dir, lease.nonce);
    if (running && restart) restarted = startLoop(dir);
  }
  return restarted ? { ...out, loop: restarted } : out;
}

// ---- Tasks and settings from the coordinator ----

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
function readTasks(file) {
  let tasks;
  try { tasks = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { bad(`--tasks: ${e.message}`); }
  const id = (n) => Number.isSafeInteger(n) && n > 0;
  if (!Array.isArray(tasks) || !tasks.every((t) => id(t?.issue) && typeof t.title === 'string' && (t.deps === undefined || (Array.isArray(t.deps) && t.deps.every(id))))) {
    bad('--tasks must be a JSON array of { issue, title, deps }');
  }
  if (new Set(tasks.map((t) => t.issue)).size !== tasks.length) bad('--tasks names an issue twice');
  return tasks.map((t) => ({ issue: t.issue, title: oneLine(t.title), deps: t.deps ?? [] }));
}
const newRow = (t, batch, status = 'queued', next = '') => ({ n: 0, issue: t.issue, title: t.title, deps: t.deps, batch, status, pr: null, head: null, session: null, next });
function batchesOf(rows) {
  const { batches, cycle } = layers(rows);
  return batches ?? refuse('cycle', { cycle, detail: `dependency cycle: ${cycle.map((n) => `#${n}`).join(' → ')}` });
}

// The ask round's `model_effort` answer ("opus high") is two settings; `keep` leaves a setting as it is.
function settingArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === 'keep') continue;
    if (key !== 'model_effort') out[key] = text;
    else {
      const [model, effort] = text.split(/\s+/);
      out.model = model;
      if (effort) out.effort = effort;
    }
  }
  return out;
}
const authLine = (text) => (text.startsWith('Owner authorization') && !/[\r\n]/.test(text) ? text : bad('--authorization must be one line that starts with "Owner authorization"'));
// I1: merge=auto only under a line with the merge clause; with no line at all nothing launches anyway.
function mergeGate({ merge, authorization }) {
  if (merge === 'auto' && authorization && !grantsMerge(authorization)) {
    refuse('merge-not-authorized', { detail: 'merge=auto needs the merge clause ("squash merge each PR that …") in the owner\'s authorization line: record a line with it, or use merge=off' });
  }
}
const taskFlag = (value) => (/^\d+$/.test(value ?? '') && Number(value) > 0 ? Number(value) : bad('--task must be an issue number'));

// ---- Sub-commands ----

function ask(words) {
  const { sub, args, extra } = parseInvocation(words.join(' '));
  for (const k of ['confirm', 'stop', 'force', 'apply']) if (args[k] !== undefined && !['yes', 'no'].includes(args[k])) bad(`${k} must be yes or no: ${args[k]}`);
  const resolved = resolveSettings(args, env);
  const context = { args };
  if (sub === 'handover') {
    context.accounts = resolved.values.accounts.filter((a) => resolve(a.dir) !== currentDir()).map((a) => ({ value: a.alias, label: `${a.alias} (${usageText(a.dir)})` }));
  }
  if (sub === 'takeover') {
    try {
      const lease = leaseOf(locate({}, args));
      context.foreignLease = !!lease && lease.host !== HOST;
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      context.batches = (e.out.candidates ?? []).map((c) => ({ value: c.src, label: `${c.src} (${c.coordinator})` }));
    }
  }
  return { sub, args, extra, settings: resolved.values, sources: resolved.sources, warnings: resolved.warnings, questions: askQuestions(sub, resolved, context) };
}

// §6: an older region is replaced and kept folded right after the new one; otherwise a GitHub task list that names
// the tasks is; otherwise the region is appended. No other text changes.
function placeRegion(body, region, tasks) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const found = findRegion(body);
  if (found?.error) refuse('ledger-region', { detail: `the source's ledger region is ${found.error}` });
  if (found) return foldEarlierList(spliceLedger(body, region), body.slice(found.start, found.end).split(eol).slice(1, -1).join(eol));
  const names = new RegExp(`(?:#|/issues/)(?:${tasks.map((t) => t.issue).join('|')})\\b`);
  const list = [...body.matchAll(/^(?:[ \t]*[-*+] \[[ xX]\] .*(?:\r?\n|$))+/gm)].find((m) => names.test(m[0]));
  if (list) {
    const text = list[0].replace(/\r?\n$/, '');
    const placed = body.slice(0, list.index) + region + body.slice(list.index + text.length);
    const r = findRegion(placed);
    if (r && !r.error) return foldEarlierList(placed, text); // a list inside a code block stays where it is
  }
  return spliceLedger(body, region);
}

function init(flags) {
  if (!flags.src || !flags.tasks || flags.settings === undefined) bad('init needs --src, --tasks and --settings');
  const tasks = readTasks(flags.tasks);
  let args;
  try { args = JSON.parse(flags.settings); } catch (e) { bad(`--settings: ${e.message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) bad('--settings must be a JSON object of the key=value arguments');
  const { values, sources, warnings } = resolveSettings(settingArgs(args), env);
  const extra = args.extra ? String(args.extra) : null;
  const authorization = flags.authorization === undefined ? null : authLine(flags.authorization);
  mergeGate({ merge: values.merge, authorization });
  if (!tasks.length) refuse('no-tasks', { detail: 'no tasks: nothing was written' });
  const batches = batchesOf(tasks);

  const repo = currentRepo();
  const [owner, name] = repo.split('/');
  let src = resolveSrc(flags.src, repo);
  const existing = named(batchDirs(repo), src);
  if (existing.length) refuse('batch-exists', { detail: 'this source already has a batch: use takeover or add', candidates: existing.map(describe) });
  const login = ghJson(['api', 'user']).login;
  const abbr = values.abbr ?? deriveAbbr(name);
  for (const a of values.accounts) if (!sessions.loggedIn(cli(a))) warnings.push(`account ${a.alias} (${a.dir}) is not logged in`);
  const ledger = {
    header: { alias: values.accounts.find((a) => resolve(a.dir) === currentDir())?.alias ?? '—', coordinator: coordinatorName({ abbr, src }),
      loop: 'running', cap: values.cap, merge: values.merge, changed: `${utc()} UTC`, waiting: 0 },
    authorization, rows: tasks.map((t, i) => ({ ...newRow(t, batches.get(t.issue)), n: i + 1 })), log: [],
  };

  // GitHub first: a refused or failed write leaves no state directory.
  const source = readSource({ repo, src, gh });
  let movedToComment;
  if (TRUSTED.has(source.association)) {
    writeSource({ repo, src, gh, body: placeRegion(source.body, renderLedger(ledger, { eol: source.body.includes('\r\n') ? '\r\n' : '\n' }), tasks) });
  } else { // §6, §11: an untrusted author can edit the source, so the ledger goes in a comment of the signed-in account
    src = createComment({ repo, parent: src.parent ?? { kind: src.kind, number: src.number }, body: renderLedger(ledger), gh });
    movedToComment = sourceUrl(repo, src);
  }
  const dir = stateDir({ owner, repo: name, src }, env);
  mkdirSync(dir, { recursive: true });
  saveSettings(dir, { ...values, abbr, repo, src, login, authorization, extra, paused: false, sources });
  writeAtomic(join(dir, 'ledger.last.md'), renderLedger(ledger));
  return { initialized: true, dir, src: sourceUrl(repo, src), tasks: tasks.length, batches: Object.fromEntries(batches), ...(movedToComment && { movedToComment }), warnings };
}

function add(dir, flags) {
  if (!flags.tasks) bad('add needs --tasks');
  const tasks = readTasks(flags.tasks);
  if (flags.pos !== undefined && !/^(end|top|\d+)$/.test(flags.pos)) bad('--pos must be end, top or a row number');
  if (!tasks.length) refuse('no-tasks', { detail: 'no tasks to add' });
  return underLease(dir, () => {
    const { rows } = ledgerOf(dir);
    const twice = tasks.filter((t) => rows.some((r) => r.issue === t.issue)).map((t) => t.issue);
    if (twice.length) refuse('already-in-ledger', { issues: twice });
    const batches = batchesOf([...rows, ...tasks]);
    const pos = flags.pos === undefined || flags.pos === 'end' ? rows.length : flags.pos === 'top' ? 0 : Number(flags.pos) - 1;
    if (pos < 0 || pos > rows.length) bad(`--pos must be end, top or a row number from 1 to ${rows.length + 1}`);
    const hold = flags.hold === undefined ? null : oneLine(flags.hold); // §11: follow-ups are added on hold, not queued
    changeLedger(dir, (l) => l.rows.splice(pos, 0, ...tasks.map((t) => newRow(t, batches.get(t.issue), hold === null ? 'queued' : 'hold', hold ?? ''))));
    rmSync(join(dir, 'summary.json'), { force: true }); // with new rows the batch is no longer complete
    return { added: tasks.map((t) => t.issue), tick: tickNow(dir) };
  });
}

function rm(dir, flags) {
  const issue = taskFlag(flags.task);
  return underLease(dir, () => {
    const s = settingsOf(dir);
    const row = ledgerOf(dir).rows.find((r) => r.issue === issue) ?? refuse('no-such-task', { detail: `#${issue} is not a row of this ledger` });
    if (row.status === 'merged') refuse('already-merged', { detail: `#${issue} is merged` });
    changeLedger(dir, (l) => Object.assign(l.rows.find((r) => r.issue === issue), { status: 'removed', next: '' }));
    const stopped = [];
    const stopFailed = [];
    if (flags.stop) { // without --stop a running session finishes its stage
      const kept = readJson(join(dir, 'sessions.json'), []).filter((rec) => {
        if (rec.issue !== issue || ENDED.has(rec.state)) return true;
        const account = s.accounts.find((a) => a.alias === rec.account);
        if (account && sessions.stop(cli(account), rec.id ?? rec.name)) { stopped.push(rec.name); return false; }
        stopFailed.push(rec.name);
        return true;
      });
      writeJson(join(dir, 'sessions.json'), kept);
    }
    return { removed: issue, stopped, stopFailed, tick: tickNow(dir) };
  });
}

// The repository's one-merge lock (§9) as the loop keeps it: refused while another row or batch holds it.
function takeMergeLock(dir, issue) {
  const path = join(dirname(dir), 'merge.lock');
  const held = existsSync(path) ? readJson(path, {}) : null;
  if (held && !(held.key === basename(dir) && held.issue === issue)) refuse('merge-lock-held', { lock: held });
  if (!held) writeFileSync(path, JSON.stringify({ key: basename(dir), issue, at: new Date().toISOString() }), { flag: 'wx' });
  return held ? null : path;
}

// A coordinator's judgment-driven relaunch. It retires every earlier record of the row's stage, including one stuck as
// `unknown`, so the loop follows the new session; the retired names stay taken (§9: a name is never reused).
function launchStage(dir, flags) {
  const issue = taskFlag(flags.task);
  const stage = Object.hasOwn(STAGES, flags.stage ?? '') ? flags.stage : bad('--stage must be refine, implement, review or merge');
  return underLease(dir, () => {
    const s = settingsOf(dir);
    const base = ledgerOf(dir);
    const row = base.rows.find((r) => r.issue === issue) ?? refuse('no-such-task', { detail: `#${issue} is not a row of this ledger` });
    if (stage === 'merge' && s.merge !== 'auto') refuse('merge-off', { detail: 'merge=off: the owner merges by hand' });
    if (stage === 'merge') mergeGate(s);
    const records = readJson(join(dir, 'sessions.json'), []);
    const old = records.filter((r) => r.issue === issue && r.stage === stage);
    if (old.some((r) => r.state === 'working')) refuse('session-working', { detail: `${old.findLast((r) => r.state === 'working').name} is still working` });
    const body = readSource({ repo: s.repo, src: s.src, gh }).body;
    const found = findRegion(body);
    if (!found || found.error) refuse('ledger-region', { detail: `the ledger region is ${found?.error ?? 'missing'}` });
    if (!s.authorization || parseLedger(body.slice(found.start, found.end)).ledger.authorization?.trim() !== s.authorization.trim()) {
      refuse('not-authorized', { detail: "the region's authorization line is not the one the owner recorded (§11)" });
    }
    const facts = issueFacts(fetchFacts({ repo: s.repo, issues: [issue], gh }), issue, { repo: s.repo, login: s.login, pr: row.pr, sessions: records.filter((r) => r.issue === issue) });
    const pr = facts.pr?.number ?? row.pr;
    if (!pr && (stage === 'review' || stage === 'merge')) refuse('no-pr', { detail: `#${issue} has no pull request to ${stage}` });
    let prompt;
    try {
      prompt = stagePrompt({ stage, issue, pr, goal: facts.goal, settings: s, authorization: s.authorization, ledgerUrl: sourceUrl(s.repo, s.src) });
    } catch (e) { refuse('launch-refused', { detail: e.message }); }

    const now = Date.now();
    const lists = new Map(s.accounts.map((a) => [a.alias, sessions.listAgents(cli(a))]));
    const choice = chooseAccount({
      accounts: s.accounts.map((a) => ({ ...a, loggedIn: Array.isArray(lists.get(a.alias)) && sessions.loggedIn(cli(a)) })),
      snapshots: Object.fromEntries(s.accounts.map((a) => [a.alias, readSnapshot(a.dir, now)])),
      cooling: new Map(Object.entries(readJson(join(dir, 'loop.json'), {}).cooling ?? {})), usageCap: s.usage_cap, coordinatorAlias: base.header.alias, now,
    });
    const account = s.accounts.find((a) => a.alias === choice.alias) ?? refuse('no-account', { detail: 'every account is at its cap, cooling or logged out', ...choice });
    const taken = new Set([...records.map((r) => r.name), ...base.rows.map((r) => r.session).filter(Boolean),
      ...[...lists.values()].flatMap((l) => (Array.isArray(l) ? l.map((x) => x.name) : []))]);
    const name = nextFreeName(sessionName({ abbr: s.abbr, stage, issue, pr }), taken);
    const lock = stage === 'merge' && takeMergeLock(dir, issue);
    const launched = sessions.launch(cli(account), { name, model: s.model, effort: s.effort, autocompact: stage === 'merge' ? null : s.autocompact,
      mcp: s.mcp ?? 'none', scope: appendedScope({ stage, issue, settings: s, authorization: s.authorization, extra: s.extra }), prompt });
    if (launched.error) {
      if (lock) rmSync(lock, { force: true });
      refuse('launch-failed', { detail: launched.error });
    }
    const startedAt = new Date(now).toISOString();
    writeJson(join(dir, 'sessions.json'), [...records.map((r) => (old.includes(r) && !ENDED.has(r.state) ? { ...r, state: 'stopped', endedAt: r.endedAt ?? startedAt } : r)),
      { name, stage, issue, pr, attempt: 1, account: account.alias, id: launched.id, sessionId: null, startedAt, endedAt: null, state: 'working' }]);
    changeLedger(dir, (l) => Object.assign(l.rows.find((r) => r.issue === issue), { status: STAGES[stage], pr, session: name, next: '' }));
    events.appendEvent(dir, { type: 'launch', task: issue, stage, session: name, account: account.alias, detail: 'relaunched by the coordinator' }, now);
    return { launched: name, account: account.alias, tick: tickNow(dir) };
  });
}

// §13: pause, stop the loop, record the new coordinator in the region, then launch it in the target account.
async function handover(dir, flags) {
  const s = settingsOf(dir);
  const target = flags.acct ? s.accounts.find((a) => a.alias === flags.acct || resolve(a.dir) === resolve(flags.acct)) : null;
  if (!flags.acct) warn('handover needs a target account; nothing changed');
  if (!target) warn(`${flags.acct} is not a configured account (${s.accounts.map((a) => a.alias).join(', ')}); nothing changed`);
  if (resolve(target.dir) === currentDir()) warn(`${target.alias} is the current account; nothing changed`);
  if (!sessions.loggedIn(cli(target))) warn(`${target.alias} is not logged in; nothing changed`);
  const listed = new Set(s.accounts.flatMap((a) => { const l = sessions.listAgents(cli(a)); return Array.isArray(l) ? l.map((x) => x.name) : []; }));
  const first = coordinatorName({ abbr: s.abbr, src: s.src });
  const current = ledgerOf(dir).header.coordinator ?? '';
  let k = current.startsWith(first) && /^\d*$/.test(current.slice(first.length)) ? Number(current.slice(first.length) || 1) : 0;
  let name;
  do name = coordinatorName({ abbr: s.abbr, src: s.src, k: ++k }); while (listed.has(name));

  const out = await underLease(dir, () => {
    const cur = settingsOf(dir);
    if (!cur.paused) saveSettings(dir, { ...cur, paused: 'handover' }); // takeover lifts a handover's pause, never the owner's
    changeLedger(dir, (l) => {
      l.log.push({ time: utc().slice(5), event: `handover: ${l.header.alias} → ${target.alias}, coordinator ${name}` });
      Object.assign(l.header, { alias: target.alias, coordinator: name });
    });
    return { tick: tickNow(dir) };
  }, { restart: false });
  const launched = sessions.launch(cli(target), { name, model: s.model, effort: s.effort, autocompact: s.autocompact, mcp: 'inherit',
    scope: appendedScope({ settings: s, authorization: s.authorization, extra: s.extra, coordinator: true }), prompt: `/dev-batch takeover src=${sourceUrl(s.repo, s.src)}` });
  if (launched.error) refuse('launch-failed', { detail: `${launched.error}; the batch is paused and its loop stopped`, ...out });
  return { handedOver: target.alias, session: name, id: launched.id, ...out };
}

// §13: across machines, takeover works from the ledger and GitHub alone. A trusted source's region gives the rows,
// cap and merge; the authorization is never taken from GitHub alone (§11), and extra is not in the region.
function rebuild(text, settingWords) {
  const repo = currentRepo();
  const [owner, name] = repo.split('/');
  const src = resolveSrc(text, repo);
  const login = ghJson(['api', 'user']).login;
  const source = readSource({ repo, src, gh });
  if (!TRUSTED.has(source.association) && !(src.kind === 'comment' && source.author === login)) {
    refuse('untrusted-source', { detail: `${sourceUrl(repo, src)} is by ${source.author || 'an unknown author'} (${source.association}): its ledger is not trusted` });
  }
  const found = findRegion(source.body);
  if (!found || found.error) refuse('ledger-region', { detail: `the source's ledger region is ${found?.error ?? 'missing'}` });
  const region = source.body.slice(found.start, found.end).replace(/\r\n/g, '\n');
  const { header } = parseLedger(region).ledger;
  const args = settingArgs(settingWords);
  const fromLedger = ['cap', 'merge'].filter((k) => args[k] === undefined && header[k] != null);
  for (const k of fromLedger) args[k] = String(header[k]);
  const { values, sources } = resolveSettings(args, env);
  for (const k of fromLedger) sources[k] = 'ledger';
  const dir = stateDir({ owner, repo: name, src }, env);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'ledger.last.md'), region);
  writeJson(join(dir, 'sessions.json'), []); // the other machine's sessions show as unknown through reconcile
  // Written last: settings.json is what makes the directory a batch.
  saveSettings(dir, { ...values, abbr: values.abbr ?? deriveAbbr(name), repo, src, login, authorization: null, extra: null, paused: false, sources });
  return { rebuilt: dir, authorization: 'needs-owner', extra: 'unrecovered',
    detail: 'rebuilt from the region: the owner restores the authorization with config --authorization; extra could not be recovered' };
}

async function takeover(flags, words) {
  let dir;
  let rebuilt = {};
  const { src, session, ...settingWords } = words;
  try { dir = locate(flags, words); } catch (e) {
    if (!(e instanceof Exit) || e.out.error !== 'no-batch' || !src || flags.batch) throw e;
    rebuilt = rebuild(src, settingWords);
    dir = rebuilt.rebuilt;
  }
  if (!rebuilt.rebuilt && Object.keys(settingWords).length) bad('key=value settings apply only when takeover rebuilds a batch: change them with config');
  const lease = leaseOf(dir);
  if (aliveHere(lease)) refuse('lease-held', { detail: `the loop runs here as pid ${lease.pid}`, lease });
  if (lease && lease.host !== HOST && !flags.force) foreign(lease);
  const out = await underLease(dir, () => {
    const s = settingsOf(dir);
    if (s.paused === 'handover') saveSettings(dir, { ...s, paused: false });
    const r = loop.reconcile(loopCtx(dir));
    return { adopted: r.adopted, unknown: r.unknown, tick: brief(r) };
  }, { restart: false, force: !!flags.force });
  return { ...rebuilt, ...out, loop: startLoop(dir) };
}

// §14: stop the sessions this batch launched whose stage is finished and that are idle. Never a working or unknown
// session, the coordinator, or one it did not launch. The loop reads the new states on its next tick.
function clear(dir) {
  const s = settingsOf(dir);
  const status = new Map(ledgerOf(dir).rows.map((r) => [r.issue, r.status]));
  const finished = (rec) => status.get(rec.issue) === 'removed' || PIPELINE.indexOf(status.get(rec.issue)) > PIPELINE.indexOf(STAGES[rec.stage]);
  const records = readJson(join(dir, 'sessions.json'), []);
  let stopped = 0;
  for (const a of s.accounts) {
    const list = sessions.listAgents(cli(a));
    if (!Array.isArray(list)) continue; // unreadable account: its sessions are unknown
    for (const rec of records.filter((r) => r.account === a.alias && finished(r))) {
      const agent = list.find((x) => (rec.id ? x.id === rec.id : x.name === rec.name));
      if (IDLE.has(agent?.state) && sessions.stop(cli(a), agent.id)) stopped++;
    }
  }
  return { stopped };
}

function status(dir) {
  const s = settingsOf(dir);
  const l = ledgerOf(dir);
  const lease = leaseOf(dir);
  const rollCall = { tasks: l.rows.length };
  for (const r of l.rows) rollCall[r.status] = (rollCall[r.status] ?? 0) + 1;
  let lastTick = null;
  try { lastTick = statSync(join(dir, 'loop.json')).mtime.toISOString(); } catch { /* never ticked */ }
  return {
    dir, src: sourceUrl(s.repo, s.src), coordinator: l.header.coordinator, account: l.header.alias, rollCall,
    rows: l.rows.map(({ n, issue, title, status: st, pr, session, next }) => ({ n, issue, title, status: st, pr, session, next })),
    sessions: readJson(join(dir, 'sessions.json'), []).filter((r) => !ENDED.has(r.state)).map(({ name, stage, issue, account, state, startedAt }) => ({ name, stage, issue, account, state, startedAt })),
    pending: events.pendingCount(dir),
    loop: { pid: lease?.pid ?? null, host: lease?.host ?? null, alive: lease ? (lease.host === HOST ? events.pidAlive(lease.pid) : null) : false,
      lastTick, paused: !!s.paused, complete: !active(dir), unwritten: existsSync(join(dir, 'ledger.next.md')) },
  };
}

// §11: config re-records the owner's authorization and restores it as the region's line; no other text changes.
function setAuthorizationLine(s) {
  const { body } = readSource({ repo: s.repo, src: s.src, gh });
  const found = findRegion(body);
  if (!found || found.error) refuse('ledger-region', { detail: `the ledger region is ${found?.error ?? 'missing'}` });
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.slice(found.start, found.end).split(eol);
  const at = lines.findIndex((l) => l.startsWith('Owner authorization'));
  if (at >= 0) lines[at] = s.authorization;
  else lines.splice(lines.findIndex((l) => l.startsWith('Coordinator:')) + 1 || 1, 0, s.authorization);
  writeSource({ repo: s.repo, src: s.src, gh, body: body.slice(0, found.start) + lines.join(eol) + body.slice(found.end) });
}

function config(dir, flags, words) {
  const s = settingsOf(dir);
  const { src, session, extra, ...rest } = words;
  const args = settingArgs(rest);
  const show = () => ({ settings: Object.fromEntries([...SETTINGS.map((x) => x.key), 'extra', 'authorization', 'paused'].map((k) => [k, s[k] ?? null])), sources: s.sources ?? {} });
  if (!Object.keys(args).length && extra === undefined && flags.authorization === undefined) return show();
  const { values } = resolveSettings(args, env);
  s.sources = { ...s.sources };
  for (const k of Object.keys(args)) {
    s[k] = values[k];
    s.sources[k] = 'config';
  }
  if (extra !== undefined) s.extra = extra || null;
  if (flags.authorization !== undefined) s.authorization = authLine(flags.authorization);
  if (args.merge !== undefined || flags.authorization !== undefined) mergeGate(s);
  if (flags.authorization !== undefined) setAuthorizationLine(s);
  saveSettings(dir, s);
  return { changed: [...Object.keys(args), ...(extra === undefined ? [] : ['extra']), ...(flags.authorization === undefined ? [] : ['authorization'])], ...show() };
}

function setup(flags, words) {
  const args = settingArgs(words);
  const { values } = resolveSettings(args, env);
  const chosen = Object.fromEntries(Object.entries(args).map(([k, v]) => [SETTINGS.find((x) => x.key === k).env, v]));
  const picks = flags.acct ?? ['all'];
  const accounts = values.accounts.filter((a) => picks.some((p) => p === 'all' || p === a.alias || resolve(a.dir) === (p === 'this' ? currentDir() : resolve(p))));
  if (!accounts.length) refuse('no-account', { detail: `no configured account matches ${picks.join(', ')}` });
  const results = accounts.map(({ alias, dir }) => {
    const path = join(dir, 'settings.json');
    let settings;
    try { settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; } catch { settings = null; }
    // Never applied over a settings.json that does not parse: the owner fixes it by hand first.
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { alias, path, error: 'settings.json is not a JSON object' };
    const { changes, next, chain } = planSetup({ settings, configDir: dir, env: chosen });
    const applied = !!flags.apply && changes.length > 0;
    if (applied) applySetup({ path, next, chain });
    return { alias, path, changes, applied };
  });
  if (results.some((r) => r.error)) throw new Exit(1, { error: 'unreadable-settings', accounts: results });
  return { accounts: results };
}

function start(dir) {
  const lease = leaseOf(dir);
  if (aliveHere(lease)) refuse('lease-held', { detail: `the loop already runs as pid ${lease.pid}`, lease });
  if (lease && lease.host !== HOST) foreign(lease);
  return startLoop(dir);
}

async function stop(dir, flags) {
  const lease = busyCommand(leaseOf(dir));
  if (!lease) return { stopped: false, detail: 'no loop holds the lease' };
  if (lease.host !== HOST) {
    if (!flags.force) foreign(lease);
    rmSync(join(dir, 'lease.json'), { force: true });
    return { stopped: true, host: lease.host };
  }
  if (!loopHere(lease, dir)) { // its pid is gone, or now another process's: drop the stale lease, signal nothing
    events.releaseLease(dir, lease.nonce);
    return { stopped: false, detail: `pid ${lease.pid} is not this batch's loop: its stale lease was dropped` };
  }
  // A loop still in its tick keeps the lease, so no second loop or takeover runs beside it; it releases it on exit.
  if (!(await stopLoop(lease, 10_000))) refuse('loop-busy', { detail: `the loop (pid ${lease.pid}) stops after its current tick and then releases the lease`, pid: lease.pid });
  events.releaseLease(dir, lease.nonce);
  return { stopped: true, pid: lease.pid, exited: true };
}

async function runLoop(dir) {
  // A tick is synchronous, so this handler only ever runs between ticks, when the state files are consistent.
  process.on('SIGTERM', () => {
    const lease = leaseOf(dir);
    if (lease?.pid === process.pid) events.releaseLease(dir, lease.nonce);
    print({ stopped: 'SIGTERM' });
    process.exit(0);
  });
  const r = await loop.run({ dir, gh, host: HOST, pid: process.pid,
    log: (t) => console.error(JSON.stringify({ at: new Date().toISOString(), ...brief(t), events: t.events.length })) });
  if (r.held || r.busy) refuse('lease-held', { lease: r.held ?? null });
  return r;
}

async function waitEvents(dir, flags) {
  const timeoutSeconds = flags.timeout === undefined ? Infinity : /^\d+$/.test(flags.timeout) ? Number(flags.timeout) : bad('--timeout must be a whole number of seconds');
  const r = await events.wait(dir, { timeoutSeconds });
  if (r.code === 3) throw new Exit(3, { timeout: true });
  return { events: r.events };
}

// ---- Dispatch ----

const S = { type: 'string' };
const B = { type: 'boolean' };
const FLAGS = {
  ask: {}, init: { src: S, tasks: S, settings: S, authorization: S }, setup: { acct: { type: 'string', multiple: true }, apply: B },
  add: { tasks: S, pos: S, hold: S }, rm: { task: S, stop: B }, launch: { task: S, stage: S }, handover: { acct: S }, takeover: { force: B },
  pause: {}, resume: {}, config: { authorization: S }, status: {}, clear: {}, start: {}, stop: { force: B }, run: {}, tick: {}, wait: { timeout: S },
};
const SETTING_WORDS = [...SETTINGS.map((s) => s.key), 'model_effort'];
const WORDS = { config: [...SETTING_WORDS, 'extra'], setup: SETTING_WORDS, takeover: SETTING_WORDS };
const HANDLERS = {
  add, rm, launch: launchStage, handover, takeover, clear, status, config, start, stop, run: runLoop, wait: waitEvents,
  pause: (dir) => { saveSettings(dir, { ...settingsOf(dir), paused: true }); return { paused: true }; },
  resume: (dir) => { saveSettings(dir, { ...settingsOf(dir), paused: false }); return { paused: false }; },
  tick: (dir) => underLease(dir, () => loop.tick(loopCtx(dir))),
};

async function main([sub, ...argv]) {
  if (!Object.hasOwn(FLAGS, sub ?? '')) bad(`expected a sub-command: ${Object.keys(FLAGS).join(', ')}`);
  if (sub === 'ask') return ask(argv);
  const located = Object.hasOwn(HANDLERS, sub);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...FLAGS[sub], ...(located && { batch: S }) }, allowPositionals: true, strict: true });
  } catch (e) { bad(e.message); }
  const { values: flags, positionals } = parsed;
  const allowed = [...(WORDS[sub] ?? []), ...(located ? ['src', 'session'] : [])];
  const words = {};
  for (const word of positionals) {
    const i = word.indexOf('=');
    if (i < 1 || !allowed.includes(word.slice(0, i))) bad(`unexpected argument: ${word}`);
    words[word.slice(0, i)] = word.slice(i + 1);
  }
  if (sub === 'init') return init(flags);
  if (sub === 'setup') return setup(flags, words);
  if (sub === 'takeover') return takeover(flags, words); // it may rebuild a batch that is not here yet
  return HANDLERS[sub](locate(flags, words), flags, words);
}

try {
  print(await main(process.argv.slice(2)));
} catch (error) {
  const known = error instanceof Exit ? error
    : error instanceof InputError ? new Exit(2, { error: 'usage', detail: error.message })
      : error instanceof GithubUnavailable ? new Exit(1, { error: 'github-unavailable', detail: error.message }) : null;
  if (!known) console.error(error?.stack ?? error);
  print(known?.out ?? { error: 'internal', detail: String(error?.message ?? error) });
  process.exitCode = known?.code ?? 1;
}
