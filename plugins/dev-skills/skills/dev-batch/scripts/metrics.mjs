// Pure summaries of a session transcript (JSONL) and of a batch's events and session records.
const USAGE = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const GAP_CAP_S = 300;
const RATE_LIMIT = /rate.?limit|usage limit|limit reached|\b429\b/i;
const DENIAL = /permission (?:to use|denied)|was denied|requires approval|doesn't want to proceed/i;

const parse = (lines) => lines.flatMap((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? [o] : []; } catch { return []; } }); // a truncated last line is skipped
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? (typeof b === 'string' ? b : '')).join(' ') : '');

export function summarizeTranscript(lines, subagentLines = []) {
  const byId = new Map(); // message id -> { usage maxima, at }
  const models = new Set();
  const out = { startedAt: null, endedAt: null, costUsd: null, compactions: [], goal: { met: 0, notMet: 0 }, rateLimits: 0, apiErrors: 0, denials: 0 };
  for (const [n, file] of [lines, ...subagentLines].entries()) {
    for (const o of parse(file)) {
      if (n === 0 && o.timestamp) { out.startedAt ??= o.timestamp; out.endedAt = o.timestamp; }
      const m = o.message;
      if (o.type === 'assistant' && o.isApiErrorMessage) {
        // the line's own `error` field wins; the text is the fallback. Checked before the synthetic-model skip, which only applies to usage.
        if (o.error ? o.error === 'rate_limit' : RATE_LIMIT.test(text(m?.content))) out.rateLimits++; else out.apiErrors++;
      } else if (o.type === 'assistant' && m?.usage && m.model !== '<synthetic>') {
        if (m.model) models.add(m.model);
        const key = m.id ?? `${n}:${o.uuid ?? o.timestamp}`;
        const e = byId.get(key) ?? { at: o.timestamp, u: {} };
        for (const f of USAGE) e.u[f] = Math.max(e.u[f] ?? 0, m.usage[f] ?? 0);
        byId.set(key, e);
      } else if (o.type === 'cost-state' && n === 0 && typeof o.totalCostUSD === 'number') out.costUsd = o.totalCostUSD;
      else if (o.type === 'system' && o.subtype === 'compact_boundary' && n === 0) {
        const c = o.compactMetadata ?? {};
        out.compactions.push({ at: o.timestamp, trigger: c.trigger, pre: c.preTokens, post: c.postTokens });
      } else if (o.type === 'attachment' && o.attachment?.type === 'goal_status') out.goal[o.attachment.met ? 'met' : 'notMet']++;
      else if (o.type === 'user' && Array.isArray(m?.content)) {
        for (const b of m.content) if (b?.type === 'tool_result' && b.is_error && DENIAL.test(text(b.content))) out.denials++;
      }
    }
  }
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let peakContext = 0;
  const times = [];
  for (const { at, u } of byId.values()) {
    const [i, o, w, r] = USAGE.map((f) => u[f] ?? 0);
    tokens.input += i; tokens.output += o; tokens.cacheWrite += w; tokens.cacheRead += r;
    peakContext = Math.max(peakContext, i + w + r);
    if (at) times.push(Date.parse(at));
  }
  times.sort((a, b) => a - b);
  let activeSeconds = 0;
  for (let i = 1; i < times.length; i++) activeSeconds += Math.min((times[i] - times[i - 1]) / 1000, GAP_CAP_S);
  return { models: [...models], ...out, activeSeconds, requests: byId.size, tokens, peakContext };
}

// One metrics.jsonl line (§16).
export function sessionRecord({ session, row = {}, settings = {}, summary, outcome }) {
  return {
    name: session.name, stage: session.stage, task: row.issue ?? session.task, pr: row.pr ?? null, account: session.account, sessionId: session.id,
    models: summary.models, effort: settings.effort, autocompact: settings.autocompact,
    startedAt: summary.startedAt, endedAt: summary.endedAt, activeSeconds: summary.activeSeconds, requests: summary.requests,
    tokens: summary.tokens, costUsd: summary.costUsd, peakContext: summary.peakContext, compactions: summary.compactions,
    goal: summary.goal, rateLimits: summary.rateLimits, apiErrors: summary.apiErrors, denials: summary.denials,
    outcome, // fact reached | retried | judgment | removed
    // Codex reviewer usage joins the review record once amyteq/gitmunk#46 defines the field.
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const stat = (xs) => ({ mean: mean(xs), median: median(xs) });
const by = (xs, f) => xs.reduce((m, x) => ((m[f(x)] ??= []).push(x), m), {});

// Durations are in seconds. Events: { at, type: 'launch'|'stage-done', task, stage }.
// Not computable from events and records alone: task -> dispatch (needs the task's creation time) and hours idle on a usage limit (needs usage windows).
export function batchSummary(events, records) {
  const t = (e) => Date.parse(e.at);
  const perTask = {}; // task -> stage -> { launch, done[] }
  for (const e of [...events].sort((a, b) => t(a) - t(b))) {
    if (e.type !== 'launch' && e.type !== 'stage-done') continue;
    const s = ((perTask[e.task] ??= {})[e.stage] ??= { launch: null, done: [] });
    if (e.type === 'launch') s.launch ??= t(e);
    else s.done.push(t(e));
  }
  const durations = {}, tasks = {}; // stage -> seconds[], and task -> stage -> seconds
  for (const [id, task] of Object.entries(perTask)) for (const [stage, s] of Object.entries(task)) if (s.launch != null && s.done.length) {
    const d = (s.done[0] - s.launch) / 1000;
    (durations[stage] ??= []).push(d);
    (tasks[id] ??= {})[stage] = d;
  }
  const stages = Object.fromEntries(Object.entries(durations).map(([k, v]) => [k, stat(v)]));

  const first = [], last = [];
  for (const task of Object.values(perTask)) {
    const start = task.refine?.launch, merges = task.merge?.done;
    if (start != null && merges?.length) { first.push((merges[0] - start) / 1000); last.push((merges.at(-1) - start) / 1000); }
  }
  const mergedPrs = Object.values(perTask).filter((s) => s.merge?.done.length).length;
  const cost = records.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const stageRecords = by(records, (r) => r.stage);
  const perStage = (f) => Object.fromEntries(Object.entries(stageRecords).map(([k, rs]) => [k, mean(rs.map(f))]));
  const impl = stageRecords.implement ?? [];
  const metRate = (rs) => (rs.length ? rs.filter((r) => r.goal.met > 0).length / rs.length : null);
  return {
    tasks,
    stages,
    costPerMergedPr: mergedPrs ? cost / mergedPrs : null,
    measures: {
      mergedPrs,
      implementSessionsGoalMet: impl.filter((r) => r.goal.met > 0).length,
      implementSessions: impl.length,
      goalNotMetContinuations: impl.reduce((a, r) => a + r.goal.notMet, 0),
      refineToLastMerge: stat(last),
      refineToFirstMerge: stat(first),
      costPerSessionByStage: perStage((r) => r.costUsd ?? 0),
      cacheReadsPerSessionByStage: perStage((r) => r.tokens.cacheRead),
      compactionsPerImplementSession: mean(impl.map((r) => r.compactions.length)),
      goalMetRateWithCompaction: metRate(impl.filter((r) => r.compactions.length)),
      goalMetRateWithoutCompaction: metRate(impl.filter((r) => !r.compactions.length)),
    },
  };
}
