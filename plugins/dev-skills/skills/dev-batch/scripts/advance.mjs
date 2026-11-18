// Dependency layers and dispatch order (§7), and the per-stage state machine (§9–§12). Pure functions, no I/O.

// B1 = no deps inside the batch; a dependency outside the batch counts as met. A cycle is named by its members.
export function layers(tasks) {
  const known = new Set(tasks.map((t) => t.issue));
  const deps = new Map(tasks.map((t) => [t.issue, t.deps.filter((d) => known.has(d))]));
  const batches = new Map();
  while (batches.size < deps.size) {
    const ready = [...deps].filter(([i, ds]) => !batches.has(i) && ds.every((d) => batches.has(d)));
    if (!ready.length) {
      // Every unplaced task has an unplaced dep, so walking deps must revisit one: that loop is the cycle.
      const seen = [];
      let at = [...deps.keys()].find((i) => !batches.has(i));
      while (!seen.includes(at)) { seen.push(at); at = deps.get(at).find((d) => !batches.has(d)); }
      return { cycle: seen.slice(seen.indexOf(at)).sort((a, b) => a - b) };
    }
    // A task lands one layer above its deepest dep. Placing this round's `ready` together is safe: none depends on another.
    for (const [i, ds] of ready) batches.set(i, Math.max(0, ...ds.map((d) => batches.get(d))) + 1);
  }
  return { batches };
}

// Queued or waiting, and every dep met: merged, or with no row in the batch (same rule as layers).
export function dispatchable(row, rowsByIssue, mergedIssues) {
  return (row.status === 'queued' || row.status === 'waiting')
    && row.deps.every((d) => mergedIssues.has(d) || !rowsByIssue.has(d) || rowsByIssue.get(d).status === 'merged');
}

// Lowest Batch first, then row order. Array.sort is stable, so ties keep the ledger's row order.
export const dispatchOrder = (rows) => [...rows].sort((a, b) => a.batch - b.batch);

// ---- The stage state machine ----

const STATUS_OF = { refine: 'refining', implement: 'implementing', review: 'reviewing', merge: 'merging' };
const STAGE_OF = Object.fromEntries(Object.entries(STATUS_OF).map(([stage, status]) => [status, stage]));
// How far GitHub's facts have got (see `wanted`); a session's stage is finished once this rank is past it.
const RANK = { refine: 0, implement: 1, 'no-goal': 1, owner: 1, 'not-ready': 1, review: 2, checks: 3, merge: 3, merged: 4 };
const LIVE = new Set(['working', 'blocked', 'limited', 'unknown']);
const IDLE = new Set(['done', 'blocked', 'limited']); // stoppable once the stage's fact is in; never working or unknown
const JUDGMENT = new Set(['refine-not-ready', 'owner-reply', 'review-blocked', 'review-budget-exhausted', 'stall', 'stage-failed', 'merge-stopped', 'session-blocked']);
const ATTEMPTS = 2;
const STALL_MS = 4 * 60 * 60 * 1000;

// Next texts that are waits, not decisions: a row showing one re-reads GitHub every tick.
const WAITING = {
  authorization: "waiting for the owner's authorization",
  merge: 'waiting for merge authorization',
  lock: 'waiting for the merge lock',
  checks: 'waiting for checks to finish',
};

// The step GitHub's facts ask for, sessions aside: merged, merge, checks (approved, checks running), review,
// implement, no-goal (ready, but no /goal line to launch with), owner or not-ready (the verdict stops it), else refine.
function wanted(f) {
  if (f.pr?.merged) return 'merged';
  if (f.pr) return !f.pr.evidence.ok ? 'review' : f.pr.checks === 'pending' ? 'checks' : 'merge';
  const state = f.task?.action === 'use-current' && f.verdict?.revision === f.task.revision ? f.verdict.state : null;
  if (state === 'ready') return f.goal ? 'implement' : 'no-goal'; // the implement prompt is the /goal line verbatim
  return state ?? 'refine';
}

const keep = (row) => ({ status: row.status, pr: row.pr, head: row.head, next: row.next, actions: [] });

/**
 * One row's next status and the actions for the loop. `sessions` are the row's session records in launch order;
 * `mergeLock` is 'free', 'mine' (this row holds it) or 'held' (another row does); `now` is an ISO time or a Date.
 * Launch actions carry the stage and attempt; naming the session and choosing the account are the loop's.
 * An event is raised only when the row's status or Next changes, so repeating a tick raises nothing new.
 */
export function advance({ row, facts, sessions, settings, authorized, mergeLock, now }) {
  if (!row.status || row.status === 'hold' || row.status === 'removed') return keep(row);
  const answered = row.status === 'queued' || row.status === 'waiting';
  let want = wanted(facts);
  // The owner answered or unblocked (👤/⛔ → 🆕): refine again with the answer instead of stopping on the old verdict.
  if (answered && (want === 'owner' || want === 'not-ready')) want = 'refine';
  const latest = (stage) => sessions.filter((s) => s.stage === stage).at(-1);
  const q = facts.ownerQuestion;
  const decision = q ? `[decision on #${row.issue}](${q.url})` : `decision needed on #${row.issue}`;
  const to = (status, next = '', ...actions) => ({ status, next, actions });
  const halt = (status, next, kind) => to(status, next, { type: 'event', kind, judgment: JUDGMENT.has(kind), detail: `#${row.issue}: ${next}` });
  const launch = (stage, attempt) => to(STATUS_OF[stage], '', { type: 'launch', stage, attempt });

  // Move to what GitHub asks for, adopting a live session of that stage instead of starting a second one.
  function goTo(step) {
    if (step === 'checks') return to('reviewing', WAITING.checks);
    if (step === 'owner') return halt('owner', decision, 'owner-question');
    if (step === 'not-ready') return halt('blocked', 'refine: not ready', 'refine-not-ready');
    if (step === 'no-goal') return halt('blocked', 'ready verdict without a /goal line', 'stage-failed');
    const s = latest(step);
    if (s && LIVE.has(s.state)) return inStage(step, s);
    if (step !== 'merge') return launch(step, 1);
    if (settings.merge !== 'auto') return to('owner', WAITING.merge);
    return mergeLock === 'held' ? to('reviewing', WAITING.lock) : launch('merge', 1);
  }

  // The row is in `stage`, whose latest session is `s` (if any).
  function inStage(stage, s) {
    if (s?.state === 'unknown') return null; // Review Focus 3: never relaunch or stop what cannot be seen
    if (s?.state === 'working') {
      // The stall clock starts at the newest GitHub activity, but never before the session itself started.
      const since = Math.max(Date.parse(facts.lastActivity) || 0, Date.parse(s.startedAt) || 0);
      if (since && +new Date(now) - since >= STALL_MS) return halt('blocked', `stalled: no GitHub progress for 4 h (${s.name})`, 'stall');
      return to(STATUS_OF[stage], stage === 'review' && facts.pr?.round ? `round ${facts.pr.round} of ${settings.rounds}` : '');
    }
    // §11: a worker that needs the owner posts its question and ends.
    if (s && !answered && q && Date.parse(q.at) > Date.parse(s.startedAt)) return halt('owner', decision, 'owner-question');
    if (want !== stage || !s) return goTo(want);
    if (s.state === 'blocked') return halt('blocked', `${s.name} needs input`, 'session-blocked');
    if (s.state === 'limited') return launch(stage, s.attempt); // §12: a usage limit is not a failed attempt
    // Idle or ended without the stage's fact.
    if (stage === 'merge') return halt('merging', `merge stopped: ${s.name} ended without merging`, 'merge-stopped'); // no retry without a new fact
    if (stage === 'review' && facts.pr.reviewEnded) return halt('blocked', `review ended ${facts.pr.reviewEnded}`, `review-${facts.pr.reviewEnded}`);
    if (s.attempt >= ATTEMPTS) return halt('blocked', `${stage} failed ${s.attempt} attempts (${s.name})`, 'stage-failed');
    return launch(stage, s.attempt + 1);
  }

  let out;
  if (want === 'merged') out = to('merged');
  else if (row.status === 'merged' || row.status === 'blocked') out = to(row.status, row.next); // ⛔ waits for the coordinator
  else if (row.status === 'owner' && row.next !== WAITING.authorization && row.next !== WAITING.merge) {
    out = facts.ownerAnswer ? halt('owner', `owner replied: ${decision}`, 'owner-reply') : to('owner', row.next);
  } else if (STAGE_OF[row.status] && row.next !== WAITING.checks && row.next !== WAITING.lock) {
    out = inStage(STAGE_OF[row.status], latest(STAGE_OF[row.status]));
  } else out = goTo(want); // queued, waiting, and the waits above
  if (!out) return keep(row);

  let { status, next, actions } = out;
  // §11: without the owner's authorization line nothing new launches, merges included; running sessions go on.
  if (!authorized && actions.some((a) => a.type === 'launch')) ({ status, next, actions } = halt('owner', WAITING.authorization, 'authorization-missing'));
  if (status === row.status && next === row.next) actions = actions.filter((a) => a.type !== 'event'); // raised on an earlier tick
  const needsLock = actions.some((a) => a.type === 'launch' && a.stage === 'merge') || latest('merge')?.state === 'working';
  const lock = needsLock && mergeLock === 'free' ? [{ type: 'lock' }] : !needsLock && mergeLock === 'mine' ? [{ type: 'unlock' }] : [];
  const stops = sessions.filter((s) => IDLE.has(s.state) && RANK[s.stage] < RANK[want]).map((s) => ({ type: 'stop', session: s.name }));
  return { status, pr: facts.pr?.number ?? row.pr, head: facts.pr?.head?.slice(0, 7) ?? row.head, next, actions: [...stops, ...lock, ...actions] };
}
