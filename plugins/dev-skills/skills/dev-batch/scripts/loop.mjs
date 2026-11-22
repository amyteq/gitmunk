// The batch loop (spec §7, §9–§13, §16). `tick` reads the source and GitHub's facts and every account's sessions,
// advances each row, stops and launches sessions, writes events and metrics, and splices the ledger back. `run`
// repeats it under the lease; `reconcile` prepares a takeover. Every decision lives in the pure modules.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { advance, dispatchable, dispatchOrder } from './advance.mjs';
import { chooseAccount, limitCooling, readSnapshot } from './accounts.mjs';
import { deriveAbbr } from './config.mjs';
import { appendEvent, pendingCount, pidAlive, queueJudgment, releaseLease, takeLease } from './events.mjs';
import { GithubUnavailable, fetchFacts, issueFacts, readSource, sourceUrl, writeSource } from './facts.mjs';
import { findRegion, ownerEdits, parseLedger, renderLedger, spliceLedger } from './ledger.mjs';
import { batchSummary, sessionRecord, summarizeTranscript } from './metrics.mjs';
import { appendedScope, grantsMerge, nextFreeName, sessionName, stagePrompt } from './prompts.mjs';
import * as sessions from './sessions.mjs';

const TICK_MS = 300_000; // §8: the loop interval
const CHECK_MS = 15_000; // §8: the check for setting changes and sessions that left `working`
const HOUR = 3_600_000;
const GRACE_MS = 120_000; // a session `claude agents` does not list yet is still registering for this long after its launch
const STATUS_OF = { refine: 'refining', implement: 'implementing', review: 'reviewing', merge: 'merging' };
const STAGE_OF = Object.fromEntries(Object.entries(STATUS_OF).map(([stage, status]) => [status, stage]));
const PIPELINE = ['refining', 'implementing', 'reviewing', 'merging', 'merged'];
// Holds a cap slot. A limited session resumes by itself after the reset, so it holds its slot until it is stopped (§12).
export const RUNNING = new Set(['working', 'blocked', 'unknown', 'limited']);
const LIVE = RUNNING; // may still merge
const ENDED = new Set(['stopped', 'failed']);
const IDLE = new Set(['done', 'blocked', 'limited']); // stoppable; never working or unknown
const FINISHED = new Set(['merged', 'removed']);

const iso = (ms) => new Date(ms).toISOString();
const registering = (rec, now) => now - Date.parse(rec.startedAt) < GRACE_MS;
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const readLines = (path) => (read(path) ?? '').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
const writeJson = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

// ---- The repository merge lock (R9): one merge at a time across every batch of the repository ----

const lockFile = (dir) => join(dirname(dir), 'merge.lock');
// shortcut: an unreadable lock (a crash inside the exclusive create) counts as held; delete the file by hand if a batch waits on it.
const readLock = (dir) => (existsSync(lockFile(dir)) ? readJson(lockFile(dir), {}) : null);
// Each write stamps a new `id`, so a holder judged from an earlier read never matches a lock written since.
const newLock = (dir, issue, now) => ({ key: basename(dir), issue, at: iso(now), id: randomUUID() });
const sameLock = (a, b) => !!a && !!b && ['key', 'issue', 'at', 'id'].every((k) => a[k] === b[k]);
function createLock(dir, lock) {
  try {
    writeFileSync(lockFile(dir), JSON.stringify(lock), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
const acquireLock = (dir, issue, now) => createLock(dir, newLock(dir, issue, now));
// Every change to an existing lock (a claim, a release, a reclaim) runs under merge.lock.guard, one at a time across
// batches, and re-reads the lock inside it; only the exclusive create needs no guard. → fn's result, or null while busy.
// shortcut: a crash inside it leaves merge.lock.guard and every merge waits; delete it by hand, as for an unreadable lock.
function guarded(dir, fn) {
  const guard = `${lockFile(dir)}.guard`;
  try { writeFileSync(guard, '', { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { return fn(); } finally { rmSync(guard, { force: true }); }
}
// Removes the lock only while it is still exactly `holder`, never one written since (a replacement, or a renewed claim).
export function dropLock(dir, holder) {
  return guarded(dir, () => {
    if (!sameLock(readLock(dir), holder)) return false;
    rmSync(lockFile(dir), { force: true });
    return true;
  }) ?? false;
}
// Every merge launch claims the lock first: a free lock is created, the batch's own lock for the issue is renewed, so a
// reclaimer that judged it from an earlier read leaves it. → { lock, fresh } or null (held elsewhere, or busy).
export function claimLock(dir, issue, now) {
  return guarded(dir, () => {
    const held = readLock(dir);
    if (held && !(held.key === basename(dir) && held.issue === issue)) return null;
    const lock = newLock(dir, issue, now);
    if (held) writeAtomic(lockFile(dir), JSON.stringify(lock));
    else if (!createLock(dir, lock)) return null;
    return { lock, fresh: !held };
  });
}
// Another batch's lock is free once that batch's loop is gone (no lease, or its pid is gone on this host) and every
// merge session of the lock's issue in its sessions.json, which records a session before it launches, has ended as that
// batch's own accounts list it. An unreadable sessions.json, a session they cannot show, or one still registering keeps it.
function otherLockFree(dir, holder, ctx) {
  const other = join(dirname(dir), holder.key);
  const lease = readJson(join(other, 'lease.json'), null);
  if (lease && !(lease.host === ctx.host && !pidAlive(lease.pid))) return false;
  const accounts = readJson(join(other, 'settings.json'), {}).accounts ?? [];
  const records = existsSync(join(other, 'sessions.json')) ? readJson(join(other, 'sessions.json'), null) : [];
  return Array.isArray(records) && records.every((r) => {
    if (r.issue !== holder.issue || r.stage !== 'merge' || ENDED.has(r.state)) return true;
    const acc = accounts.find((a) => a.alias === r.account);
    const list = acc && sessions.listAgents({ configDir: acc.dir, run: ctx.claude });
    if (!Array.isArray(list)) return false;
    const listed = list.filter((x) => (r.id ? x.id === r.id : x.name === r.name)); // by name: any one running keeps it
    return listed.length ? listed.every((x) => x.state !== 'working' && x.state !== 'blocked') : !registering(r, ctx.now);
  });
}

// §7: the owner edits that count, applied to the rows the loop decided last; anything else in the region is the loop's.
function applyOwnerEdits(baseRows, edits, current, ev) {
  const rows = baseRows.map((r) => ({ ...r }));
  const byIssue = new Map(rows.map((r) => [r.issue, r]));
  for (const e of edits) {
    const r = byIssue.get(e.issue);
    if (e.issue !== undefined && !r) continue;
    if (e.type === 'deps') r.deps = e.value;
    else if (e.type === 'batch') r.batch = e.value;
    else if (e.type === 'hold') r.status = 'hold';
    else if (e.type === 'deleted') r.status = 'removed'; // same as rm: a running session finishes
    else if (e.type === 'answered' || e.type === 'release') Object.assign(r, { status: 'queued', next: '' });
    ev({ type: 'owner-edit', task: e.issue, detail: `${e.type}${e.issue ? ` #${e.issue}` : ''}${e.value === undefined ? '' : ` ${JSON.stringify(e.value)}`}` });
    if (e.type === 'answered') ev({ type: 'owner-reply', task: e.issue, detail: `#${e.issue}: the owner set the row back to queued`, judgment: true }, `#${e.issue}: the owner answered`);
  }
  // The owner's row order; a deleted row keeps its place, now removed.
  const pos = new Map(current.rows.map((r, i) => [r.issue, i]));
  const kept = rows.filter((r) => pos.has(r.issue)).sort((a, b) => pos.get(a.issue) - pos.get(b.issue));
  let k = 0;
  return rows.map((r) => (pos.has(r.issue) ? kept[k++] : r)).map((r, i) => ({ ...r, n: i + 1, status: r.status ?? 'hold' }));
}

// §16: one metrics.jsonl line per session, read from its transcript and its subagents' when it stops or ends.
function writeMetrics(dir, rec, account, outcome, row) {
  const path = account && rec.sessionId ? sessions.transcriptPath(account.dir, rec.sessionId) : null;
  const lines = (file) => readFileSync(file, 'utf8').split('\n');
  const subs = path && join(path.slice(0, -'.jsonl'.length), 'subagents');
  const subagents = subs && existsSync(subs) ? readdirSync(subs).filter((n) => n.endsWith('.jsonl')).map((n) => lines(join(subs, n))) : [];
  const record = sessionRecord({ session: { ...rec, id: rec.sessionId }, row, outcome, summary: summarizeTranscript(path ? lines(path) : [], subagents),
    settings: { effort: rec.effort ?? null, autocompact: rec.autocompact ?? null } }); // as launched; null when the loop did not launch it
  appendFileSync(join(dir, 'metrics.jsonl'), `${JSON.stringify(record)}\n`);
  rec.metrics = true;
}
// A session that ended by itself: its stage finished, its row was removed, it ended in a judgment, or it is retried.
const outcomeOf = (rec, status) => (status === 'removed' ? 'removed'
  : PIPELINE.indexOf(status) > PIPELINE.indexOf(STATUS_OF[rec.stage]) ? 'fact reached'
    : status === 'blocked' || status === 'owner' ? 'judgment' : 'retried');

/**
 * One pass (§10). ctx = { dir, settings, gh, claude, now, host, pid }: `settings` is the batch's settings.json
 * (resolved §8 values plus repo, src, login, abbr and the recorded authorization line), `gh(args)` and
 * `claude(cmd, args, { env })` are the adapters, `now` is epoch ms. Expected failures become events, never throws.
 * → { wrote, launched, stopped, events, complete, githubDown? }: `githubDown` when a GitHub call aborted the tick.
 */
export function tick(ctx) {
  const { dir, settings: s, gh, now } = ctx;
  const key = basename(dir);
  const at = (name) => join(dir, name);
  const st = { githubFailures: 0, launchFailures: 0, cooling: {}, login: {}, unreadable: [], atCap: false, regionProblem: null, ...readJson(at('loop.json'), {}) };
  const out = { wrote: false, launched: [], stopped: [], events: [], complete: false };
  const queued = [];
  const logLines = [];
  // Events are collected and written together in step 8; `line` also goes to the ledger's Log.
  const ev = (event, line) => { queued.push(event); if (line) logLines.push(line); };
  const flush = () => { for (const { judgment, ...e } of queued.splice(0)) out.events.push(judgment ? queueJudgment(dir, e, now) : appendEvent(dir, e, now)); };
  const finish = () => { flush(); writeJson(at('loop.json'), st); return out; };
  // Review Focus 5: one event per failed tick, the third in a row a judgment; nothing decided this tick is kept.
  const githubDown = (error) => {
    queued.length = 0;
    out.githubDown = true;
    st.githubFailures++;
    ev({ type: 'github-unavailable', detail: `${error.message} (${st.githubFailures} in a row)`, judgment: st.githubFailures === 3 });
    return finish();
  };
  const guard = (fn) => { try { return { value: fn() }; } catch (e) { if (e instanceof GithubUnavailable) return { down: githubDown(e) }; throw e; } };

  // 1. The source and its ledger region; GitHub comes first, so a failure aborts before any launch or write.
  const source = guard(() => readSource({ repo: s.repo, src: s.src, gh }).body);
  if (source.down) return source.down;
  const body = source.value;
  const found = findRegion(body);
  if (!found || found.error) {
    const problem = found?.error ?? 'missing';
    if (st.regionProblem !== problem) ev({ type: 'ledger-region', detail: `the ledger region is ${problem}: nothing launches and nothing is written until it is restored`, judgment: true });
    Object.assign(st, { regionProblem: problem, githubFailures: 0 });
    return finish();
  }
  st.regionProblem = null;
  const lastText = read(at('ledger.last.md'));
  const last = lastText && parseLedger(lastText).ledger;
  const { ledger: current, problems } = parseLedger(body.slice(found.start, found.end), last ? { previous: last } : {});
  // ledger.next.md holds rows decided but not yet written, so a failed write is never decided (and raised) twice.
  const nextText = read(at('ledger.next.md'));
  const base = nextText ? parseLedger(nextText).ledger : last || current;
  // ledger.seen.md is the region those rows were decided from: diffing against it applies each owner edit once.
  const seenText = nextText && read(at('ledger.seen.md'));
  const seen = seenText ? parseLedger(seenText, last ? { previous: last } : {}).ledger : last || current;
  for (const p of problems) ev({ type: 'ledger-unreadable-row', detail: `row ${p.row}: ${p.reason}` });

  // 2. Owner edits, and the authorization line as recorded at init or config (§11).
  const rows = applyOwnerEdits(base.rows, ownerEdits(seen, current), current, ev);
  const authorized = !!s.authorization && current.authorization?.trim() === s.authorization.trim();
  const decide = grantsMerge(s.authorization) ? s : { ...s, merge: 'off' }; // I1: merge=auto only under the line's merge clause

  // 3. Facts of every active row, one query.
  const active = rows.filter((r) => !FINISHED.has(r.status) && r.status !== 'hold');
  const fetched = guard(() => (active.length ? fetchFacts({ repo: s.repo, issues: active.map((r) => r.issue), gh }) : null));
  if (fetched.down) return fetched.down;

  // 4. Sessions of every account. Review Focus 3: an unreadable account's sessions are unknown, never relaunched.
  const records = readJson(at('sessions.json'), []);
  const account = new Map(s.accounts.map((a) => [a.alias, a]));
  const cli = (alias) => ({ configDir: account.get(alias).dir, run: ctx.claude });
  const ours = (x) => sessions.inCheckout(s.cwd, x); // binding by name needs the batch's checkout (C29)
  const agents = Object.fromEntries(s.accounts.map((a) => { const l = sessions.listAgents(cli(a.alias)); return [a.alias, Array.isArray(l) ? l : null]; }));
  const unreadable = s.accounts.filter((a) => !agents[a.alias]).map((a) => a.alias);
  for (const alias of unreadable) {
    if (!st.unreadable.includes(alias)) ev({ type: 'account-unreadable', account: alias, detail: `claude agents failed for ${alias}; its sessions are unknown until it answers` });
  }
  st.unreadable = unreadable;
  for (const [alias, until] of Object.entries(st.cooling)) if (until <= now) delete st.cooling[alias];
  const ended = []; // ended by themselves this tick: metrics in step 6
  for (const rec of records) {
    if (!rec.account && !ENDED.has(rec.state)) { // reconcile found it on no readable account: match it by name once one lists it
      const alias = Object.keys(agents).find((a) => agents[a]?.some((x) => x.name === rec.name && ours(x)));
      if (alias) Object.assign(rec, { account: alias, id: agents[alias].find((x) => x.name === rec.name && ours(x)).id });
    }
    const list = agents[rec.account];
    if (!list) { if (!ENDED.has(rec.state)) rec.state = 'unknown'; continue; }
    const agent = rec.id ? list.find((x) => x.id === rec.id) : list.find((x) => x.name === rec.name && ours(x));
    const was = rec.state;
    // A readable account that does not list it: gone, unless it was launched so recently that it is still registering.
    rec.state = agent?.state ?? (ENDED.has(was) ? was : registering(rec, now) ? 'working' : 'stopped');
    rec.id = agent?.id ?? rec.id; // a session recorded before its launch, found by name
    rec.sessionId = agent?.sessionId ?? rec.sessionId;
    rec.idleAt = rec.state === 'working' ? null : rec.idleAt ?? iso(now); // I4: when it left `working`, for owner answers
    // §12: blocked on a usage limit → limited, and its account cools until the stated reset.
    const until = rec.state === 'blocked' && limitCooling(sessions.logs(cli(rec.account), rec.id ?? rec.name) ?? '', now);
    if (until) {
      rec.state = 'limited';
      st.cooling[rec.account] = Math.max(st.cooling[rec.account] ?? 0, until);
      if (was !== 'limited') {
        ev({ type: 'limit', task: rec.issue, stage: rec.stage, session: rec.name, account: rec.account, detail: `usage limit; ${rec.account} cools until ${iso(until)}` },
          `#${rec.issue} ${rec.name}: usage limit on ${rec.account}`);
      }
    }
    if (ENDED.has(rec.state) && !rec.endedAt) { rec.endedAt = iso(now); if (was === 'limited') rec.limited = true; ended.push(rec); }
  }

  // 5. advance every active row. The merge lock is followed in memory while deciding, so two rows never both take
  //    it (R9); a lock left by a merged row of this batch, by a removed row whose merge session ended, or by a batch
  //    that is gone and whose merge session ended, is released first.
  let holder = readLock(dir);
  const liveRow = (issue) => rows.some((r) => r.issue === issue && !FINISHED.has(r.status));
  const ownFree = (issue) => rows.some((r) => r.issue === issue && r.status === 'merged')
    || (!liveRow(issue) && !records.some((x) => x.issue === issue && x.stage === 'merge' && LIVE.has(x.state)));
  if (holder?.key && (holder.key === key ? ownFree(holder.issue) : otherLockFree(dir, holder, ctx))) holder = dropLock(dir, holder) ? null : readLock(dir);
  const byIssue = new Map(rows.map((r) => [r.issue, r]));
  const facts = new Map(active.map((r) => [r.issue, issueFacts(fetched.value, r.issue, { repo: s.repo, login: s.login, pr: r.pr,
    sessions: records.filter((x) => x.issue === r.issue) })]));
  const merged = new Set(rows.filter((r) => r.status === 'merged' || facts.get(r.issue)?.pr?.merged).map((r) => r.issue));
  const decideRow = (row) => {
    const f = facts.get(row.issue);
    if (!f) return { row, batch: row.batch, priority: row.priority, actions: [], next: row };
    const mergeLock = !holder ? 'free' : holder.key === key && holder.issue === row.issue ? 'mine' : 'held';
    let r = advance({ row, facts: f, sessions: records.filter((x) => x.issue === row.issue), settings: decide, authorized, mergeLock, now: iso(now) });
    // Deps unmet: nothing launches, but facts such as a hand merge still apply.
    if ((row.status === 'queued' || row.status === 'waiting') && !dispatchable(row, byIssue, merged) && r.status !== 'merged'
      && r.actions.some((a) => a.type === 'launch' || a.kind === 'authorization-missing')) {
      r = { ...r, status: 'waiting', next: '', actions: r.actions.filter((a) => a.type === 'stop') };
    }
    if (!holder && r.actions.some((a) => a.type === 'lock')) holder = { key, issue: row.issue };
    if (mergeLock === 'mine' && r.actions.some((a) => a.type === 'unlock')) holder = null;
    return { row, batch: row.batch, priority: f.priority, facts: f, actions: r.actions,
      next: { ...row, status: r.status, pr: r.pr, head: r.head, next: r.next, priority: f.priority } };
  };
  // Decided in dispatch order, so the merge lock goes to the first eligible row in that order (Q1); kept in row order.
  const decision = new Map(dispatchOrder(rows.map((row) => ({ row, batch: row.batch, priority: facts.has(row.issue) ? facts.get(row.issue).priority : row.priority })))
    .map(({ row }) => [row, decideRow(row)]));
  const decided = rows.map((row) => decision.get(row));

  // 6. Stop sessions whose stage is finished; write the metrics of every session that stopped or ended.
  const stopSession = (rec, outcome, row) => {
    if (!agents[rec.account] || !sessions.stop(cli(rec.account), rec.id ?? rec.name)) {
      ev({ type: 'stop-failed', task: rec.issue, stage: rec.stage, session: rec.name, account: rec.account });
      return;
    }
    // `limited`: it ended on a usage limit, so its stage relaunches at the same attempt (§12).
    Object.assign(rec, { state: 'stopped', endedAt: iso(now), ...(rec.state === 'limited' && { limited: true }) });
    out.stopped.push(rec.name);
    ev({ type: 'stop', task: rec.issue, stage: rec.stage, session: rec.name, account: rec.account });
    writeMetrics(dir, rec, account.get(rec.account), outcome, row);
  };
  for (const d of decided) {
    for (const a of d.actions) {
      const rec = a.type === 'stop' && records.findLast((x) => x.name === a.session);
      if (rec) stopSession(rec, 'fact reached', d.next);
    }
  }
  // §14, I8: a finished row's sessions stop once idle, such as a merge session still in its closeout when the merge
  // was seen, or the session of a removed row. `advance` decides only for active rows.
  for (const d of decided) {
    if (FINISHED.has(d.next.status)) for (const rec of records) if (rec.issue === d.row.issue && IDLE.has(rec.state)) stopSession(rec, outcomeOf(rec, d.next.status), d.next);
  }
  for (const rec of ended) {
    const row = decided.find((d) => d.row.issue === rec.issue)?.next ?? { issue: rec.issue };
    if (!rec.metrics) writeMetrics(dir, rec, account.get(rec.account), outcomeOf(rec, row.status), row);
  }
  // The lock follows the rows: released on unlock, taken for a live merge session that lacks it.
  for (const d of decided) {
    const h = d.actions.some((a) => a.type === 'unlock') && readLock(dir);
    if (h?.key === key && h.issue === d.row.issue) dropLock(dir, h);
  }
  for (const d of decided) if (d.actions.some((a) => a.type === 'lock') && !d.actions.some((a) => a.type === 'launch')) acquireLock(dir, d.row.issue, now);

  // 7. Launch in dispatch order while a slot is free: adopt a live session already listed under the name (Review
  //    Focus 4), else build the prompt, choose the account (§12), take the lock for a merge (R9), and launch.
  let paused = !!s.paused;
  let free = s.cap - records.filter((x) => RUNNING.has(x.state)).length;
  let noAccount = false;
  const recorded = new Set(records.map((x) => x.name));
  const adoptable = new Map(); // live sessions that no record knows, by name
  for (const [alias, list] of Object.entries(agents)) {
    for (const x of list ?? []) if ((x.state === 'working' || x.state === 'blocked') && !recorded.has(x.name) && ours(x)) adoptable.set(x.name, { alias, agent: x });
  }
  const taken = new Set([...recorded, ...Object.values(agents).flatMap((l) => (l ?? []).map((x) => x.name)), ...rows.map((r) => r.session).filter(Boolean)]);
  const abbr = s.abbr ?? deriveAbbr(s.repo.split('/')[1]);
  const snapshots = Object.fromEntries(s.accounts.map((a) => [a.alias, readSnapshot(a.dir, now)]));
  // §12: logged in, checked before an account's first launch each hour.
  const loggedIn = (alias) => {
    if (!(now - (st.login[alias]?.at ?? -Infinity) < HOUR)) st.login[alias] = { at: now, ok: sessions.loggedIn(cli(alias)) };
    return st.login[alias].ok;
  };
  let choosable = null;
  for (const d of dispatchOrder(decided)) {
    const a = d.actions.find((x) => x.type === 'launch');
    if (!a) continue;
    const issue = d.row.issue;
    const keep = () => { d.next = { ...d.next, status: d.row.status === 'waiting' ? 'queued' : d.row.status, next: d.row.next }; };
    const limited = records.filter((x) => x.issue === issue && x.state === 'limited'); // stopped below; the launch takes its slot
    if (paused || free + limited.length <= 0 || noAccount) { keep(); continue; }
    const { stage, attempt } = a;
    const pr = d.next.pr;
    const first = sessionName({ abbr, stage, issue, pr, attempt });
    let orphan = null;
    for (let n = 1, name = first; !orphan && taken.has(name); name = `${first}${++n}`) orphan = adoptable.get(name);
    if (orphan) {
      const { alias, agent } = orphan;
      adoptable.delete(agent.name);
      records.push({ name: agent.name, stage, issue, pr, attempt, account: alias, id: agent.id, sessionId: agent.sessionId, startedAt: iso(now), endedAt: null, state: agent.state });
      d.next.session = agent.name;
      free--;
      ev({ type: 'adopt', task: issue, stage, session: agent.name, account: alias, detail: `${agent.name} is already ${agent.state}: adopted, not relaunched` });
      continue;
    }
    let prompt;
    try {
      prompt = stagePrompt({ stage, issue, pr, goal: d.facts.goal, settings: s, authorization: s.authorization, ledgerUrl: sourceUrl(s.repo, s.src) });
    } catch (e) { // never a launch and never a crash: the row waits for the coordinator
      d.next = { ...d.next, status: 'blocked', next: `${stage} not launched: ${e.message}` };
      ev({ type: 'launch-refused', task: issue, stage, detail: `#${issue}: ${e.message}`, judgment: true }, `#${issue}: ${stage} not launched: ${e.message}`);
      continue;
    }
    choosable ??= s.accounts.map((acc) => ({ ...acc, loggedIn: !!agents[acc.alias] && loggedIn(acc.alias) }));
    const choice = chooseAccount({ accounts: choosable, snapshots, cooling: new Map(Object.entries(st.cooling)), usageCap: s.usage_cap, coordinatorAlias: base.header.alias, now,
      unknownRunning: new Map(s.accounts.map((acc) => [acc.alias, records.some((x) => x.account === acc.alias && RUNNING.has(x.state))])) });
    if (!choice.alias) {
      keep();
      noAccount = true;
      const detail = choice.waitUntil ? `every account is at its cap or cooling; the earliest is free at ${iso(choice.waitUntil)}` : 'no account can take a session';
      if (!st.atCap) ev({ type: 'accounts-at-cap', detail, judgment: true }, 'no account is free: launches wait');
      st.atCap = true;
      continue;
    }
    st.atCap = false;
    const claim = stage === 'merge' && claimLock(dir, issue, now);
    if (stage === 'merge' && !claim) { keep(); continue; } // another batch took it first
    // §12, R9: a limited session resumes by itself after its reset, so it is stopped before its replacement launches.
    // A failed stop is retried on the next tick; until then nothing launches for the row, and a lock it claimed stays
    // with it, since a limited merge session may still merge.
    for (const old of limited) stopSession(old, 'retried', d.next);
    if (limited.some((x) => x.state === 'limited')) { keep(); continue; }
    free += limited.length;
    const name = nextFreeName(first, taken);
    const opts = { name, model: s.model, effort: s.effort, autocompact: stage === 'merge' ? null : s.autocompact, mcp: s.mcp ?? 'none', // missing fails closed
      scope: appendedScope({ stage, issue, settings: s, authorization: s.authorization, extra: s.extra }), prompt };
    const rec = { name, stage, issue, pr, attempt, account: choice.alias, id: null, sessionId: null, startedAt: iso(now), endedAt: null, state: 'working',
      effort: opts.effort, autocompact: opts.autocompact }; // §16: its metrics report the settings it launched with
    records.push(rec);
    writeJson(at('sessions.json'), records); // R9: recorded before it launches, so a crash never leaves a merge session unrecorded
    let launched;
    try { launched = sessions.launch(cli(choice.alias), opts); } catch (e) { launched = { error: e.message }; }
    if (launched.error) {
      records.splice(records.indexOf(rec), 1);
      if (claim?.fresh) dropLock(dir, claim.lock);
      keep();
      st.launchFailures++;
      ev({ type: 'launch-failed', task: issue, stage, session: name, account: choice.alias, detail: launched.error }, `#${issue} ${stage}: ${name} failed to launch on ${choice.alias}`);
      if (st.launchFailures >= 3) { // §9: three in a row pause the batch until `resume`
        paused = true;
        st.launchFailures = 0;
        writeJson(at('settings.json'), { ...readJson(at('settings.json'), s), paused: true });
        ev({ type: 'batch-paused', detail: `3 launches failed in a row (last: ${launched.error}); resume after fixing the cause`, judgment: true }, 'paused: 3 launches failed in a row');
      }
      continue;
    }
    st.launchFailures = 0;
    taken.add(name);
    free--;
    rec.id = launched.id;
    d.next.session = name;
    out.launched.push(name);
    ev({ type: 'launch', task: issue, stage, session: name, account: choice.alias, detail: sessions.launchArgs(opts) }, `#${issue} ${stage}: ${name} on ${choice.alias}`);
  }
  writeJson(at('sessions.json'), records);

  // 8. Events: a stage-done for each stage the facts finished, then advance's own events.
  for (const d of decided) {
    const from = PIPELINE.indexOf(d.row.status);
    if (from >= 0 && PIPELINE.indexOf(d.next.status) > from && d.row.status !== 'merging') ev({ type: 'stage-done', task: d.row.issue, stage: STAGE_OF[d.row.status] });
    if (d.next.status === 'merged' && d.row.status !== 'merged') ev({ type: 'stage-done', task: d.row.issue, stage: 'merge' }, `#${d.row.issue}: merged`);
    for (const a of d.actions) if (a.type === 'event') ev({ type: a.kind, task: d.row.issue, detail: a.detail, judgment: a.judgment }, a.detail);
  }
  flush();
  const newRows = decided.map((d) => d.next);
  // §14, I8: every session keeps the loop until it has ended, so the loop stops it once idle and records its metrics:
  // one still working, one whose account is unreadable, one whose stop failed. A session only another machine's
  // accounts list (takeover, no account here) has no metrics this machine can collect, so it does not.
  const complete = newRows.length > 0 && newRows.every((r) => FINISHED.has(r.status)) && records.every((x) => ENDED.has(x.state) || !x.account);
  let summary = null;
  let headline = null;
  if (complete) {
    // §10, §16: the final roll call; summary.json and the batch-complete event follow once it is written (below).
    summary = batchSummary(readLines(at('events.jsonl')), readLines(at('metrics.jsonl')));
    const hours = (sec) => (sec == null ? '—' : `${(sec / 3600).toFixed(1)} h`);
    const cost = summary.costPerMergedPr == null ? '—' : `$${summary.costPerMergedPr.toFixed(2)}`;
    headline = `${summary.measures.mergedPrs} PRs merged · refine to last merge, median ${hours(summary.measures.refineToLastMerge.median)} · cost per merged PR ${cost}`;
    if (base.header.loop !== 'stopped') logLines.push(`batch complete: ${headline}`);
  }

  // 9. Write the region only when it changed (or held an unreadable row), spliced into the body fetched again just
  //    now, so text added outside it meanwhile survives (Review Focus 2). 10. Record what was written.
  const ledger = {
    header: { ...base.header, loop: complete ? 'stopped' : paused ? 'paused' : 'running', cap: s.cap, merge: s.merge, waiting: pendingCount(dir) },
    authorization: current.authorization, // never written back once the owner edits or deletes it
    rows: newRows,
    log: [...base.log, ...logLines.map((event) => ({ time: iso(now).slice(5, 16).replace('T', ' '), event }))].slice(-20),
  };
  const changed = !!nextText || renderLedger(ledger) !== lastText || problems.length > 0; // decisions not yet written are always written
  if (changed) {
    ledger.header.changed = `${iso(now).slice(0, 16).replace('T', ' ')} UTC`;
    const text = renderLedger(ledger);
    writeAtomic(at('ledger.seen.md'), body.slice(found.start, found.end));
    writeAtomic(at('ledger.next.md'), text);
    const written = guard(() => {
      const fresh = readSource({ repo: s.repo, src: s.src, gh }).body;
      const region = findRegion(fresh);
      if (!region || region.error) return false; // gone or broken since step 1: the next tick raises it
      // The owner edited the region since step 1: keep ledger.next.md; the next tick applies the edit on top of it.
      if (fresh.slice(region.start, region.end) !== body.slice(found.start, found.end)) return false;
      writeSource({ repo: s.repo, src: s.src, gh, body: spliceLedger(fresh, renderLedger(ledger, { eol: fresh.includes('\r\n') ? '\r\n' : '\n' })) });
      return true;
    });
    if (written.down) return written.down;
    if (written.value) {
      writeAtomic(at('ledger.last.md'), text);
      rmSync(at('ledger.next.md'), { force: true });
      rmSync(at('ledger.seen.md'), { force: true });
      out.wrote = true;
      out.events.push(appendEvent(dir, { type: 'ledger-write' }, now));
    }
  }
  // §10: the batch ends only once its final roll call is written; until then the next tick retries the write.
  out.complete = complete && (out.wrote || !changed);
  if (out.complete && !existsSync(at('summary.json'))) { // summary.json marks the batch inactive: one event, once
    writeJson(at('summary.json'), summary);
    ev({ type: 'batch-complete', detail: headline, judgment: true });
  }
  st.githubFailures = 0; // Review Focus 5: a tick counts as GitHub answering only once every call of it succeeded
  return finish();
}

// The 15 s check: has a batch session that was working left `working`?
function leftWorking(ctx, s, now) {
  const working = readJson(join(ctx.dir, 'sessions.json'), []).filter((r) => r.state === 'working');
  return s.accounts.some((a) => {
    const mine = working.filter((r) => r.account === a.alias);
    const list = mine.length ? sessions.listAgents({ configDir: a.dir, run: ctx.claude }) : null;
    return Array.isArray(list) && mine.some((r) => {
      const agent = list.find((x) => (r.id ? x.id === r.id : x.name === r.name && sessions.inCheckout(s.cwd, x)));
      return agent ? agent.state !== 'working' : !registering(r, now);
    });
  });
}

/**
 * The detached loop (§10): take the lease, tick every 5 minutes, and tick early when the 15 s check sees
 * settings.json change (config, pause, resume) or a batch session leave `working`. It ends when the batch is complete
 * or the lease is no longer its own. ctx = { dir, gh, claude, host, pid, force?, clock?, sleep?, log? }.
 * → { complete } | { lost } | { held } | { busy }.
 */
export async function run(ctx) {
  const { dir } = ctx;
  const clock = ctx.clock ?? Date.now;
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { header } = parseLedger(read(join(dir, 'ledger.last.md')) ?? '').ledger;
  let lease;
  for (let tries = 0; ; tries++) {
    lease = takeLease(dir, { pid: ctx.pid, host: ctx.host, alias: header.alias, coordinator: header.coordinator, now: clock(), force: ctx.force });
    if (!lease.busy || tries >= 20) break;
    await sleep(250);
  }
  if (!lease.ok) return lease.busy ? { busy: true } : { held: lease.held };
  try {
    for (;;) {
      if (readJson(join(dir, 'lease.json'), {}).nonce !== lease.nonce) return { lost: true };
      const text = read(join(dir, 'settings.json'));
      const settings = JSON.parse(text);
      const result = tick({ ...ctx, settings, now: clock() });
      ctx.log?.(result);
      if (result.complete) return { complete: true };
      for (let waited = 0; waited < TICK_MS; waited += CHECK_MS) {
        await sleep(CHECK_MS);
        // While GitHub is down only a settings change wakes it early, so an outage is retried every 5 minutes.
        if (read(join(dir, 'settings.json')) !== text || (!result.githubDown && leftWorking(ctx, settings, clock()))) break;
      }
    }
  } catch (error) {
    queueJudgment(dir, { type: 'loop-error', detail: String(error?.stack ?? error) }, clock());
    throw error;
  } finally {
    releaseLease(dir, lease.nonce);
  }
}

/**
 * takeover (§13). Each session that the ledger's Session column names for a row in an active stage, and that no
 * local record knows, is adopted from `claude agents` of the configured accounts; one that no account lists (another
 * machine's) is recorded as unknown, so nothing relaunches over it, and raised for the coordinator. One tick then
 * redoes only the missing step from GitHub's facts. → the tick's result plus { adopted, unknown }.
 */
export function reconcile(ctx) {
  const { dir, settings: s, gh, now } = ctx;
  const adopted = [];
  const unknown = [];
  let body = null;
  try { body = readSource({ repo: s.repo, src: s.src, gh }).body; } catch (e) { if (!(e instanceof GithubUnavailable)) throw e; }
  const found = body == null ? null : findRegion(body);
  if (found && !found.error) {
    const records = readJson(join(dir, 'sessions.json'), []);
    const abbr = s.abbr ?? deriveAbbr(s.repo.split('/')[1]);
    const lists = s.accounts.map((a) => [a.alias, sessions.listAgents({ configDir: a.dir, run: ctx.claude })]);
    for (const row of parseLedger(body.slice(found.start, found.end)).ledger.rows) {
      const stage = STAGE_OF[row.status];
      if (!row.session || !stage || records.some((x) => x.name === row.session)) continue;
      const named = (x) => x.name === row.session && sessions.inCheckout(s.cwd, x); // C29: in this batch's checkout
      const [alias, list] = lists.find(([, l]) => Array.isArray(l) && l.some(named)) ?? [null, null];
      const agent = list?.find(named);
      const firstName = sessionName({ abbr, stage, issue: row.issue, pr: row.pr, attempt: 1 });
      const retry = row.session.startsWith(firstName) ? row.session.slice(firstName.length) : '';
      records.push({ name: row.session, stage, issue: row.issue, pr: row.pr, attempt: /^\d+$/.test(retry) ? Number(retry) : 1, account: alias,
        id: agent?.id ?? null, sessionId: agent?.sessionId ?? null, startedAt: iso(now), endedAt: null, state: agent?.state ?? 'unknown' });
      (agent ? adopted : unknown).push(row.session);
      const detail = `#${row.issue}: ${row.session} is not listed by any configured account; its stage is not relaunched until the coordinator decides`;
      if (!agent) queueJudgment(dir, { type: 'session-unknown', task: row.issue, stage, session: row.session, detail }, now);
    }
    writeJson(join(dir, 'sessions.json'), records);
  }
  return { ...tick(ctx), adopted, unknown };
}
