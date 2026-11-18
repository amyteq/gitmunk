---
title: "dev-batch: implementation plan"
skill: dev-batch
plugin: dev-skills
version: 0.1.0
status: in review
created: 2026-11-18
updated: 2026-11-18
design: docs/specs/dev-batch-design.md (0.2.0, approved 2026-11-18)
issue: 44
pr: 45
---

# dev-batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `dev-batch` skill in `dev-skills`: a SKILL.md plus a Node helper whose detached loop runs a batch of GitHub issues through refine → implement → review → merge in fresh named Claude sessions across accounts, with a ledger in the source issue or discussion.

**Architecture:** Pure modules (config, ledger, advance, prompts, accounts, metrics) hold every decision and are tested as tables. Thin adapters (facts → `gh`, sessions → `claude`) are tested against stub executables on `PATH`. `loop.mjs` composes them into one `tick`, run detached under a lease; `batch.mjs` is the CLI the coordinator agent calls. The agent handles only init, owner commands and judgment events.

**Tech Stack:** Node.js 20+ ES modules, `node:test`, `node:assert/strict`, the plugin's existing `mdast-util-from-markdown`; `gh` and `claude` CLIs at run time.

**Spec:** [`docs/specs/dev-batch-design.md`](../specs/dev-batch-design.md). Section numbers below (§n) refer to it; read the section a task names before starting it.

## Global Constraints

- Everything lives in `plugins/dev-skills/skills/dev-batch/`; tests are `scripts/*.test.mjs` and run with `npm test` from `plugins/dev-skills` (`node --test` finds them). Node 20+, no new npm dependency.
- Spawn every command with an argument array (`spawnSync`/`spawn`), never a shell string. GitHub text reaches a command line only as the single prompt argv element of a launch. The one exception is the owner's own previous status-line command, which the status-line script runs through `sh -c` exactly as Claude Code would (Task 9).
- Public repository: tests and examples use `example-org/example-repo`, aliases `A1`/`A2`, and temporary directories; no private names, paths, issue numbers or people.
- English prose; emoji only in the human-facing ledger, never in markers, event types or code identifiers.
- Markers, verbatim: `<!-- dev-batch:ledger v=1 -->` … `<!-- /dev-batch:ledger -->`; `<!-- dev-batch:verdict issue=<N> revision=<R> state=ready|owner|not-ready -->`; `<!-- dev-batch:owner issue=<N> -->`.
- Trusted author associations: `OWNER`, `MEMBER`, `COLLABORATOR`.
- Settings, environment variables and defaults exactly as §8, including `cap=4`, `usage_cap=80`, `merge=auto`, `reviewer=codex`, `writer=claude`, `rounds=10`, `model=opus`, `effort=xhigh`, `autocompact=300k`, `mcp=none`. Precedence: invocation argument > `DEV_BATCH_*` environment > default.
- Fixed values (§8): loop interval 300 s, settings check 15 s, 2 attempts per stage, stall after 4 h without GitHub progress, 3 consecutive failed launches pause the batch, ledger Log keeps 20 rows, Remote Control on, `--permission-mode auto`.
- Session names (§9): refine `<abbr>-i<N>r`, implement `<abbr>-i<N>a`, review `<abbr>-pr<M>`, merge `<abbr>-pr<M>m`, coordinator `<abbr>-<i|d><src>c`; a retry appends `2`, `3` …; a name is never reused.
- State directory: `${XDG_STATE_HOME:-~/.local/state}/dev-batch/<owner>/<repo>/<key>/` with `<key>` = `i<N>`, `d<N>` or `c<commentId>`; the repository-wide merge lock is `…/<owner>/<repo>/merge.lock`.
- Exit codes follow the plugin: `0` proceed, `1` refused or stopped (reason in the JSON output), `2` bad arguments or unreadable input. `wait` adds `3` for a timeout.
- Test command for a task's module: `node --test skills/dev-batch/scripts/<module>.test.mjs` from `plugins/dev-skills`; "run (FAIL)" expects module-not-found or the new assertions failing, "run (PASS)" expects every test in the file to pass.
- Commit after each task: `git add` the task's files, `git commit -m "feat(dev-batch): <task>"` with the session trailers; push only when the task list says so.

## Review Focus

1. **A hand-edited ledger.** The owner edits the table on GitHub's web editor: CRLF line endings, extra spaces, a missing trailing pipe, rows reordered or deleted, an unknown emoji. Parse tolerantly, keep the row, and raise a `ledger-unreadable-row` event for what cannot be read instead of dropping it (test in Task 2).
2. **A concurrent body edit.** The owner adds text outside the region between the loop's fetch and its write. The loop re-fetches and splices immediately before writing, so every byte outside the region survives (test in Task 12).
3. **One account unreadable mid-batch.** `claude agents --json --all` fails or the account is logged out. The tick goes on with the other accounts, shows that account's sessions as unknown, and never relaunches a stage whose session state is unknown (test in Task 12).
4. **A machine restart.** The lease's pid is gone. `start` or `takeover` reclaims the lease; pending events survive; a session still listed by `claude agents` under its name is adopted, not relaunched (tests in Tasks 10 and 12).
5. **GitHub fails during a tick.** A `gh` error or rate limit aborts that tick before any launch or write, logs one `github-unavailable` event, and the next tick retries; three in a row raise a judgment event (test in Task 12).

---

## File Structure

| File | Responsibility |
|---|---|
| `SKILL.md` | Sub-commands, the ask round, authority rules, the coordinator's procedures for init, judgment events, handover and takeover |
| `references/ledger.md` | Region format, status legend, owner edits that count |
| `references/prompts.md` | Stage prompts, appended scope, the markers workers write |
| `references/accounts.md` | Accounts, usage snapshots, account choice, what `setup` writes, the by-hand snippet |
| `references/metrics.md` | `events.jsonl`, `metrics.jsonl` and `summary.json` record formats |
| `scripts/config.mjs` | Settings schema, argument and environment parsing, precedence, `abbr`, state paths, ask-round questions |
| `scripts/ledger.mjs` | Parse, render and splice the region; detect owner edits |
| `scripts/advance.mjs` | Dependency layers, dispatch order, the per-stage state machine (pure) |
| `scripts/facts.mjs` | One GraphQL read per tick and the facts each row needs; reuses `selectTask` and `reviewEvidence` |
| `scripts/prompts.mjs` | Session names, launch prompts, appended scope |
| `scripts/sessions.mjs` | `claude` adapter: launch, list, stop, logs, auth |
| `scripts/accounts.mjs` | Usage snapshots, account choice, cooling |
| `scripts/statusline.mjs` | Standalone status-line script that `setup` copies into each config directory |
| `scripts/setup.mjs` | Plan and apply the per-account settings change |
| `scripts/events.mjs` | Event log, judgment queue, `wait`, lease |
| `scripts/metrics.mjs` | Transcript summary per session and the batch summary |
| `scripts/loop.mjs` | `tick`, `run`, `takeover` reconciliation |
| `scripts/batch.mjs` | CLI entry |
| `scripts/test-helpers.mjs` | Temporary state directories, stub `gh`/`claude` executables, fixture builders (tests only) |

`loop.mjs`, `prompts.mjs`, `setup.mjs` and `statusline.mjs` extend the module list in §5; each keeps one responsibility that would otherwise bloat `batch.mjs` or `accounts.mjs`.

---

### Task 1: Settings and paths (`config.mjs`)

**Files:**
- Create: `scripts/config.mjs`, `scripts/config.test.mjs`, `scripts/test-helpers.mjs`

**Interfaces:**
- Produces:
  - `SETTINGS`: array of `{ key, env, default, parse(value) → value | throws }` for every §8 key.
  - `parseInvocation(text: string) → { sub: string, args: Record<string,string>, extra: string|null }`: `key=value` pairs, double-quoted values with spaces, `extra="…"`; an unknown sub-command or key throws `InputError`.
  - `resolveSettings(args, env) → { values, sources, warnings }`, where `sources[key]` is `'argument' | 'environment' | 'default'` and `warnings` names `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when it is set, because it overrides `--autocompact` (§8).
  - `deriveAbbr(repoName: string) → string`.
  - `stateDir({ owner, repo, src }, env) → string`; `repoStateDir({ owner, repo }, env) → string`; `srcKey(src) → 'i<N>' | 'd<N>' | 'c<id>'`.
  - `askQuestions(sub, resolved, context) → [{ key, question, options: [{ value, label }] }]`, recommended option first, at most 4.
  - `class InputError extends Error`.

- [ ] **Step 1: Write the failing tests**

```js
test('defaults match the design', () => {
  const { values, sources } = resolveSettings({}, {});
  assert.deepEqual(pick(values, 'cap usage_cap merge reviewer writer rounds model effort autocompact mcp'),
    { cap: 4, usage_cap: 80, merge: 'auto', reviewer: 'codex', writer: 'claude', rounds: 10,
      model: 'opus', effort: 'xhigh', autocompact: '300k', mcp: 'none' });
  assert.equal(sources.cap, 'default');
});
test('argument beats environment beats default', () => {
  const { values, sources } = resolveSettings({ cap: '2' }, { DEV_BATCH_CAP: '6', DEV_BATCH_MODEL: 'claude-opus-5-5' });
  assert.equal(values.cap, 2); assert.equal(sources.cap, 'argument');
  assert.equal(values.model, 'claude-opus-5-5'); assert.equal(sources.model, 'environment');
});
test('accounts accept a JSON array or a comma list and default to CLAUDE_CONFIG_DIR, else ~/.claude');
test('invalid values are refused', () => { /* cap=0, usage_cap=101, merge=maybe, autocompact=50k, mcp=../x.txt (not .json) each throw InputError */ });
test('parseInvocation reads quoted values and extra', () => {
  assert.deepEqual(parseInvocation('init src=40 merge=off extra="no UI work"'),
    { sub: 'init', args: { src: '40', merge: 'off' }, extra: 'no UI work' });
  assert.equal(parseInvocation('').sub, 'status');
});
test('abbr', () => {
  assert.equal(deriveAbbr('example-repo'), 'er');
  assert.equal(deriveAbbr('gitmunk'), 'gi');
});
test('state paths', () => {
  assert.equal(stateDir({ owner: 'example-org', repo: 'example-repo', src: { kind: 'issue', number: 40 } }, { XDG_STATE_HOME: '/s' }),
    '/s/dev-batch/example-org/example-repo/i40');
});
test('ask round: init without src asks for it first; given values are not asked; never more than 4');
test('ask round: status, pause, resume and clear ask nothing');
test('CLAUDE_CODE_AUTO_COMPACT_WINDOW in the environment gives a warning');
```

`test-helpers.mjs` provides `tempDir()`, `stubBin(dir, name, script)` (writes an executable Node script that appends its argv and selected env to `STUB_LOG` and answers from a fixture file named by an env variable) and `withPath(dir)`, in the style of `dev-review-pr/scripts/launch-phase.test.mjs`.

- [ ] **Step 2: Run** `node --test skills/dev-batch/scripts/config.test.mjs` from `plugins/dev-skills`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `config.mjs`.** The question table is §6's "Asked when missing"; options per key: `merge` `auto`/`off`; `cap` `4`/`2`/`6`; model · effort `opus·xhigh`/`opus·high`; for `init`, the question text lists every other setting with its value and source. `src` options come from `context.candidates` (the agent supplies open tracker-like issues and discussions).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: The ledger (`ledger.mjs`)

**Files:**
- Create: `scripts/ledger.mjs`, `scripts/ledger.test.mjs`

**Interfaces:**
- Produces:
  - `STATUS`: `{ queued:'🆕', waiting:'⏳', refining:'🔍', implementing:'🛠️', reviewing:'🔄', merging:'🔀', merged:'✅', owner:'👤', blocked:'⛔', hold:'⏸️', removed:'⏭️' }`.
  - Ledger shape: `{ header: { coordinator, alias, loop: 'running'|'paused'|'stopped', cap, merge, changed, waiting }, authorization: string|null, rows: Row[], log: [{ time, event }] }`; `renderLedger` computes the roll call line (task count, count per status, `❗ <waiting> events waiting`) from `rows` and `header.waiting`, where `Row = { n, issue, title, deps: number[], batch: number, status: keyof STATUS, pr: number|null, head: string|null, session: string|null, next: string }`.
  - `findRegion(body) → { start, end } | null | { error: 'multiple' | 'unclosed' }`; a marker inside a code fence does not count.
  - `parseLedger(regionText) → { ledger, problems: [{ row, reason }] }`.
  - `renderLedger(ledger, { eol }) → string`, including both markers.
  - `spliceLedger(body, regionText) → string`: replaces the region, or appends it after the body with one blank line when none exists.
  - `foldEarlierList(body, listText) → string`: moves a replaced task list under `<details><summary>Earlier task list</summary>` directly after the region (§6).
  - `ownerEdits(lastWritten: Ledger, current: Ledger) → Edit[]`, where `Edit = { type: 'order'|'deps'|'batch'|'hold'|'answered'|'deleted'|'authorization', issue?, value? }`.

- [ ] **Step 1: Write the failing tests.**
  - `round trip`: rendering §7's example ledger and parsing it back gives the same object.
  - `splice keeps every byte outside the region`: a body with text before and after the region, and CRLF line endings, compared byte for byte; the rendered region uses CRLF when the body does.
  - `a marker in a code fence is not the region`.
  - `hand-edited table` (Review Focus 1): extra spaces, a missing trailing pipe, CRLF, an unknown status `🟣` → the row parses with `status` unchanged from `lastWritten` and one `problems` entry `{ row: 3, reason: 'unknown status 🟣' }`.
  - `owner edits`: a reordered row → `order`; `Deps` changed → `deps`; a status set to ⏸️ → `hold`; 👤 or ⛔ set to 🆕 → `answered`; a deleted row → `deleted`; the authorization line edited or removed → `authorization`. A loop-owned change (PR, Session, Next, any other status change) produces no edit.
  - `log keeps the last 20 rows`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Find the region with a line scan plus the fence detection used by `dev-track` (`fromMarkdown` positions of `code` nodes). Parse table rows by splitting on unescaped `|`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Dependencies and dispatch order (`advance.mjs`, part 1)

**Files:**
- Create: `scripts/advance.mjs`, `scripts/advance.test.mjs`

**Interfaces:**
- Consumes: `Row` (Task 2).
- Produces:
  - `layers(tasks: [{ issue, deps }]) → { batches: Map<issue, number> } | { cycle: number[] }`: B1 = no deps inside the batch; dependencies outside the batch count as met.
  - `dispatchable(row, rowsByIssue, mergedIssues: Set<number>) → boolean`: status `queued` or `waiting`, every dep merged.
  - `dispatchOrder(rows) → Row[]`: sorted by `(batch, row order)`.

- [ ] **Step 1: Failing tests.**
  - `layers`: `{41:[], 42:[41], 43:[], 44:[42,43]}` → B1, B2, B1, B3.
  - `a cycle is named`: `{1:[2], 2:[1]}` → `{ cycle: [1, 2] }`.
  - `batch is priority, not a barrier` (§7): a B2 row whose deps are merged is dispatchable while an unrelated B1 row is in review.
  - `order`: (B1, row 3) comes before (B2, row 1).
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 4: GitHub facts (`facts.mjs`)

**Files:**
- Create: `scripts/facts.mjs`, `scripts/facts.test.mjs`, `scripts/fixtures/facts-*.json`

**Interfaces:**
- Consumes: `selectTask` from `../../dev-refine-issue/scripts/check-refinement.mjs` and `reviewEvidence` from `../../dev-merge/scripts/check-merge.mjs` (same plugin, relative imports).
- Produces:
  - `factsQuery(repo, issues: number[]) → { query, variables }`: one GraphQL document with aliased `issue_<N>` fields (body, comments `last:100` with `databaseId`, `author.login`, `authorAssociation`, `createdAt`, `body`, `url`, `totalCount`; `closedByPullRequestsReferences(first:10, includeClosedPrs:true)`; `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT], last:20)`), and for each PR: `number`, `state`, `merged`, `headRefOid`, `author.login`, `comments(last:100)`, `reviews(last:50)` with `commit.oid`, `statusCheckRollup.state`.
  - `fetchFacts({ repo, issues, gh }) → raw`, where `gh(args) → { code, stdout, stderr }` is injected. When an issue's `comments.totalCount > 100`, it also runs `gh api --paginate repos/<repo>/issues/<N>/comments` for that issue.
  - `issueFacts(raw, issue, { repo, login, rounds, sessionWindows: [{ from, to }] }) → IssueFacts` with:
    - `task`: the `selectTask` decision;
    - `goal`: the first line starting with `/goal ` inside the fenced block under `**Goal prompt**` in the AUTO region's `## Execution` section, else null;
    - `verdict`: `{ revision, state, at }` from the newest trusted or own-login comment whose first line is a verdict marker for this issue;
    - `ownerQuestion`: `{ url, at }`;
    - `ownerAnswer`: `{ at }` for an unmarked comment after the question (§11);
    - `pr`: `{ number, state, merged, head, checks: 'pending'|'done'|'none', evidence, round, phase, reviewEnded: 'blocked'|'budget-exhausted'|null, lastActivity }`, choosing the newest open or merged PR by `login` that closes or references the issue.

- [ ] **Step 1: Failing tests** (fixtures shaped like the GraphQL response, `example-org/example-repo`):
  - `ready verdict at the current revision` → `verdict.state === 'ready'` and `task.action === 'use-current'`.
  - `a verdict from an untrusted, non-own login is ignored`.
  - `goal line`: extracts `/goal Execute from https://github.com/example-org/example-repo/issues/41#issuecomment-1. …`; a `/goal` line in human prose outside the region is ignored.
  - `PR by another login is not the task's PR`.
  - `approval-eligible at head` → `pr.evidence.ok === true`; after a new push `pr.evidence.ok === false`.
  - `review round from the latest dev-review-pr marker` → `round: 2`.
  - `checks`: rollup `PENDING` → `'pending'`; `SUCCESS` or `FAILURE` → `'done'`; null → `'none'`.
  - `owner answer`: an unmarked comment after the owner question, posted while no session of the row ran, counts; one posted while a session ran does not (the session window is passed in).
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 5: The stage state machine (`advance.mjs`, part 2)

**Files:**
- Modify: `scripts/advance.mjs`, `scripts/advance.test.mjs`

**Interfaces:**
- Consumes: `Row`, `IssueFacts`, settings values.
- Produces: `advance({ row, facts, sessions, settings, authorized, mergeLock, now }) → { status, pr, head, next, actions }`, where:
  - `sessions` lists this row's session records `{ name, stage, state: 'working'|'blocked'|'limited'|'done'|'stopped'|'failed'|'unknown', startedAt, endedAt, attempt }`; `limited` is a `blocked` session whose `claude logs` show a usage limit (the loop sets it, Task 12);
  - `actions` is a list of `{ type: 'launch', stage }`, `{ type: 'stop', session }`, `{ type: 'event', kind, judgment: boolean, detail }` or `{ type: 'lock' | 'unlock' }`;
  - the `kind`s are `refine-not-ready`, `owner-question`, `owner-reply`, `review-blocked`, `review-budget-exhausted`, `stall`, `stage-failed`, `merge-stopped`, `session-blocked`, `authorization-missing`.

- [ ] **Step 1: Failing tests**, one table with one case per §9 row and bullet:
  - queued with a current task and a ready verdict → launch `implement` (skips refine, §9 "Already-refined").
  - refine done with `state=owner` → status `owner`, `next` is the question link; `not-ready` → judgment `refine-not-ready`.
  - implement: an open PR by the login and the session `done` → status `reviewing`, stop the session, launch `review`.
  - review: approval-eligible at head and checks `done`, `merge=auto`, lock free → `lock`, launch `merge`; checks `pending` → wait; `merge=off` → status `owner`, next `waiting for merge authorization`.
  - a new head after approval → back to `reviewing` (§9).
  - merged → status `merged`, `unlock`, stop the merge session.
  - a session `done` without its fact, attempt 1 → relaunch with the next name; attempt 2 → `blocked`, judgment `stage-failed`.
  - 4 h without GitHub progress while `working` → judgment `stall`.
  - session state `blocked` (needs input) → judgment `session-blocked`.
  - session state `limited` → relaunch the stage under the next name without counting an attempt (§12 "Hitting a limit anyway"); the account choice skips the cooling account.
  - `authorized === false` → no launch; status `owner`, next `waiting for the owner's authorization`.
  - session state `unknown` → no launch, no stop (Review Focus 3).
  - `answered` (👤 → 🆕 by the owner) → re-checks the facts and launches only the missing stage.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 6: Names and prompts (`prompts.mjs`)

**Files:**
- Create: `scripts/prompts.mjs`, `scripts/prompts.test.mjs`

**Interfaces:**
- Produces:
  - `sessionName({ abbr, stage, issue, pr, attempt }) → string`, following the names in Global Constraints;
  - `coordinatorName({ abbr, src, k }) → string`: `k` is 1 for the first coordinator (no suffix), then `c2`, `c3`;
  - `nextFreeName(base, takenNames: Set<string>) → string`;
  - `stagePrompt({ stage, issue, pr, goal, settings, authorization, ledgerUrl }) → string`, with the exact strings of §9's Launch prompt column (the merge prompt quotes the authorization line verbatim);
  - `appendedScope({ stage, issue, settings, authorization, extra, coordinator }) → string`, carrying §11's decision policy, the authorization quote, the verdict-marker instruction for refine, the owner-question marker instruction for every stage, the reviewer/writer model and effort for review, and `extra`.

- [ ] **Step 1: Failing tests.**
  - `names`: `er-i41r`, `er-i41a`, `er-pr52`, `er-pr52m`, `er-i40c`, `er-d40c2`; `nextFreeName('er-pr55m', {'er-pr55m'})` → `'er-pr55m2'`.
  - `review prompt`: `/dev-review-pr pr=55 10 codex claude`.
  - `merge prompt`: starts `/dev-merge pr=55 issues=42 cleanup=own -- Squash merge PR #55 under the owner authorization quoted here: "` and contains `Leave the dev-batch ledger region between its markers unchanged`.
  - `refine scope asks for exactly one verdict comment whose first line is <!-- dev-batch:verdict issue=41 revision=<R> state=ready|owner|not-ready -->`.
  - `implement prompt is the issue's /goal line verbatim`; a goal not starting with `/goal ` throws.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 7: The `claude` adapter (`sessions.mjs`)

**Files:**
- Create: `scripts/sessions.mjs`, `scripts/sessions.test.mjs`

**Interfaces:**
- Produces, each taking `{ configDir, run }` where `run(cmd, args, { env, cwd }) → { code, stdout, stderr }` is injectable:
  - `launchArgs({ name, model, effort, autocompact, mcp, scope, prompt }) → string[]`: `['--bg', '--name', name, '--model', model, '--effort', effort, ...(autocompact ? ['--autocompact', autocompact] : []), '--permission-mode', 'auto', '--remote-control', name, ...mcpArgs, '--append-system-prompt', scope, prompt]`, where `mcpArgs` is `['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']` for `none`, `['--strict-mcp-config', '--mcp-config', path]` for a file, and nothing for `inherit`. A prompt that does not start with `/` throws.
  - `launch(...) → { id }`: the 8-hex id printed on stdout; no id → `{ error }`.
  - `listAgents(...) → Agent[] | { error }`: `claude agents --json --all`, mapped to `{ id, sessionId, name, state, cwd, startedAt }`.
  - `stop(..., id)`, `logs(..., id) → string`, `loggedIn(...) → boolean` from `claude auth status --json`.
  - `transcriptPath(configDir, sessionId) → string | null`: searches `<configDir>/projects/*/<sessionId>.jsonl`.
- Every call sets `CLAUDE_CONFIG_DIR=configDir` in the child environment and nothing else.

- [ ] **Step 1: Failing tests** against a stub `claude` (Task 1 helpers):
  - `launch argv for implement with mcp=none and autocompact=300k` equals the exact array.
  - `merge sessions get no --autocompact` (the caller passes `autocompact: null`).
  - `each call runs with CLAUDE_CONFIG_DIR of its account`.
  - `listAgents maps states working, blocked, done, stopped, failed`, and a non-zero exit gives `{ error }`.
  - `a prompt starting with "-" is refused before spawning`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 8: Accounts and usage (`accounts.mjs`, `statusline.mjs`)

**Files:**
- Create: `scripts/accounts.mjs`, `scripts/accounts.test.mjs`, `scripts/statusline.mjs`, `scripts/statusline.test.mjs`

**Interfaces:**
- Produces:
  - `readSnapshot(configDir, now) → { at, five, seven } | null`, reading `<configDir>/dev-batch-usage.json`. A window whose `resets_at` (epoch seconds) has passed counts as 0.
  - `chooseAccount({ accounts: [{ alias, dir, loggedIn }], snapshots, cooling: Map<alias, untilMs>, usageCap, coordinatorAlias, unknownRunning: Map<alias, number>, now }) → { alias } | { waitUntil } | { none: 'all-at-cap' }`, following §12's order.
  - `limitCooling(logText, now) → untilMs | null`: a usage-limit message cools the account until the stated reset time, else one hour.
  - `statusline.mjs`: no imports beyond `node:` modules. It reads the status-line JSON on stdin and writes `dev-batch-usage.json` beside itself as `{ at, five_hour: { used_percentage, resets_at }, seven_day: { … } }`, keeping the last known window when a new payload lacks it. It runs the chained command from `dev-batch-statusline.json` (`{ "chain": "<previous command>" }`) with the same stdin and prints its output, then prints `5h N% · 7d N%`.

- [ ] **Step 1: Failing tests.**
  - `coordinator's account first when below the cap`; `otherwise the lowest known below the cap`; `an unknown account only when no known one is below the cap, one session at a time`; `all at cap → waitUntil the earliest resets_at`; `a passed reset counts as 0%`; `a cooling account is skipped`.
  - `statusline writes the snapshot from rate_limits.five_hour and seven_day` (field names exactly as in Claude Code's status-line input: `used_percentage`, `resets_at`).
  - `statusline without rate_limits keeps the previous snapshot`.
  - `statusline runs the chained command with the same stdin`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 9: `setup` (`setup.mjs`)

**Files:**
- Create: `scripts/setup.mjs`, `scripts/setup.test.mjs`

**Interfaces:**
- Consumes: `statusline.mjs` (Task 8).
- Produces:
  - `planSetup({ settings: object, configDir, env: Record<string,string> }) → { changes: string[], next: object }`. It sets:
    - `statusLine` to `{ type: 'command', command: 'node "<configDir>/dev-batch-statusline.mjs"' }`, recording an existing different command as the chain;
    - each given `env` value;
    - `cleanupPeriodDays` to 365 when it is lower or unset.
  - `applySetup({ path, next, now })`: writes `<path>.dev-batch-backup-<yyyyMMddHHmmss>` first, then the JSON with 2-space indentation and the original key order, copies `statusline.mjs` to `<configDir>/dev-batch-statusline.mjs` and writes `dev-batch-statusline.json`.

  The script is copied because the plugin cache path changes with every plugin version.

- [ ] **Step 1: Failing tests.**
  - `fresh settings`: changes list the status line, `DEV_BATCH_MODEL=claude-opus-5-5` and `cleanupPeriodDays 365`.
  - `an existing status line is chained, not replaced`.
  - `cleanupPeriodDays 3650 is kept`.
  - `a second run changes nothing` (empty `changes`; no backup written).
  - `no key is removed and key order is kept`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 10: Events, `wait` and the lease (`events.mjs`)

**Files:**
- Create: `scripts/events.mjs`, `scripts/events.test.mjs`

**Interfaces:**
- Produces:
  - `appendEvent(dir, { type, task?, stage?, session?, account?, detail? }, now)`: one JSON line in `events.jsonl`, with `at` as an ISO time.
  - `queueJudgment(dir, event)`: also writes `pending/<epochMs>-<seq>.json`.
  - `wait(dir, { timeoutSeconds, pollMs = 1000 }) → { code: 0, events } | { code: 3 }`: moves delivered files to `delivered/`.
  - `takeLease(dir, { pid, host, alias, coordinator, now, force }) → { ok } | { held: lease }`: refuses while a live pid on this host holds it, and a lease from another host unless `force`.
  - `releaseLease(dir)`.
  - `pendingCount(dir)`.

- [ ] **Step 1: Failing tests.**
  - `wait returns pending events, moves them, exits 0`; `wait times out with 3`; `events queued while no wait runs stay pending`.
  - `lease`: a live pid refuses; a dead pid on the same host is reclaimed (Review Focus 4); another host needs `force`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 11: Metrics (`metrics.mjs`)

**Files:**
- Create: `scripts/metrics.mjs`, `scripts/metrics.test.mjs`, `scripts/fixtures/transcript-*.jsonl`

**Interfaces:**
- Produces:
  - `summarizeTranscript(lines: string[], subagentLines: string[][]) → { models, startedAt, endedAt, activeSeconds, requests, tokens: { input, output, cacheWrite, cacheRead }, costUsd, peakContext, compactions: [{ at, trigger, pre, post }], goal: { met, notMet }, rateLimits, apiErrors, denials }`.
  - The transcript fields to read:
    - `type:'assistant'` `message.id` and `message.usage` (deduplicated by message id, keeping the maximum per field; `model:'<synthetic>'` skipped);
    - `type:'cost-state'` `totalCostUSD` (last value);
    - `type:'system'` `subtype:'compact_boundary'` `compactMetadata.{ trigger, preTokens, postTokens }`;
    - `type:'attachment'` `attachment.type:'goal_status'` `attachment.met`;
    - `activeSeconds` is the sum of gaps between requests, each capped at 300 s.
  - `sessionRecord({ session, row, settings, summary, outcome }) → object`: one `metrics.jsonl` line with the §16 fields.
  - `batchSummary(events, records) → { stages: { [stage]: { mean, median } }, costPerMergedPr, measures }`, with the §17 measures it can compute.
  - Codex reviewer usage (§16) is copied into the review record only once amyteq/gitmunk#46 defines the published field; until then the review record covers the Claude review session alone.

- [ ] **Step 1: Failing tests** (fixture transcripts with `example-org/example-repo` paths):
  - `duplicate message ids count once with the field maxima`.
  - `subagent usage is added`.
  - `compactions and goal checks are read`.
  - `no cost-state → costUsd null`.
  - `batch summary: mean and median per stage; cost per merged PR`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 12: The loop (`loop.mjs`)

**Files:**
- Create: `scripts/loop.mjs`, `scripts/loop.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces:
  - `tick(ctx) → { wrote: boolean, launched: string[], stopped: string[], events: object[] }`. `ctx = { dir, settings, gh, claude, now, host, pid }`; `gh` and `claude` are the adapters, injected so tests use stubs.
  - The tick runs in this order:
    1. Read the source and the ledger.
    2. Apply owner edits.
    3. Read facts (one query).
    4. List agents per account; check `loggedIn` before an account's first launch each hour (§12); read `claude logs` of each `blocked` batch session and mark it `limited` and its account cooling when `limitCooling` matches.
    5. Run `advance` on every row.
    6. Stop finished sessions and write their metrics.
    7. Choose launches: free slots = `cap` − running workers; `dispatchOrder`; `chooseAccount`; a name not already listed by `claude agents` (adopt a listed one).
    8. Write events.
    9. Re-fetch the body and splice, only when the rendered region differs from the last written.
    10. Record the last written region.
  - `run(ctx)`: `takeLease`, then ticks every 300 s, and early when the 15 s check sees a settings file change, a batch session whose `claude agents` state left `working`, or `resume`. When every row is `merged` or `removed`, it writes the final roll call and `summary.json`, queues `batch-complete` and exits.
  - `reconcile(ctx) → actions` for `takeover`: compares the ledger with facts and sessions and redoes only the missing step.

- [ ] **Step 1: Failing tests** with a temporary state directory and stub `gh` (fixture GraphQL responses) and `claude`:
  - `two dependent issues run to merge`: tick by tick, #41 refine → implement → review → merge, then #42 starts; the ledger statuses follow; each stage's session is stopped when its fact appears.
  - `no write when nothing changed`: a second identical tick makes no `gh` edit call.
  - `concurrent body edit survives` (Review Focus 2): the stub returns a different body on the re-fetch; the written body keeps the new outside text.
  - `an unreadable account` (Review Focus 3): the stub `claude agents` fails for A2; A1 work continues; A2 rows launch nothing.
  - `github unavailable` (Review Focus 5): `gh` exits 1 → no launch, no write, one `github-unavailable` event; the third consecutive one is a judgment.
  - `adopt, don't relaunch` (Review Focus 4): a session named `er-i41a` already listed as `working` is adopted.
  - `cap and one merge at a time`: with `cap=1` only one worker runs; two approval-eligible PRs merge one after the other under the repository lock.
  - `three failed launches pause the batch`.
  - `a usage-limited session moves to the other account`: `blocked` + a limit message in the stub `claude logs` → A1 cools, the stage relaunches on A2 as `er-i41a2`.
  - `owner revokes the authorization line`: no new launch from the next tick.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit and push (first push of implementation code).

### Task 13: The CLI (`batch.mjs`)

**Files:**
- Create: `scripts/batch.mjs`, `scripts/batch.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–12.
- Produces these sub-commands; every one prints one JSON object on stdout:
  - `ask <invocation text>`: resolved settings, sources and `askQuestions`.
  - `init --src <s> --tasks <file> --settings <json> [--authorization <text>]`: `tasks` is `[{ issue, title, deps }]` from the agent. An empty list exits 1 with `no-tasks` and writes nothing; a cycle exits 1 naming it. It writes the region (in a new comment by the signed-in account when the source's author is not `OWNER`/`MEMBER`/`COLLABORATOR`, §6), folds an earlier list, and saves `settings.json`.
  - `add --tasks <file> [--pos end|<row>] [--hold <note>]` (`--hold "follow-up, not queued"` adds ⏸️ rows, §11) and `rm --task <N> [--stop]`.
  - `pause`, `resume`, `config [key=value…]` (no keys prints settings and sources), `status`.
  - `start` (spawns `run` detached, output to `loop.log`, returns), `run`, `tick`, `wait [--timeout <s>]`, `stop`.
  - `clear`, `takeover [--force]`, `handover --acct <alias|dir>` (validates, stops the loop, launches `coordinatorName` in the target account with the prompt `/dev-batch takeover src=<src>`), `launch --task <N> --stage <stage>` (a coordinator's judgment-driven relaunch), `setup [--acct …] [--apply]` (prints the plan, writes only with `--apply`).
  - Every sub-command takes `--batch <dir>`, or `src=`/`session=`, or finds the only active batch of the current repository (§6 "Locating the batch").

- [ ] **Step 1: Failing tests** by spawning the CLI:
  - `ask init without src`.
  - `init writes the region and settings` (stub `gh`); `init on an untrusted author's issue writes a comment`; `init with no tasks writes nothing`.
  - `init with a cycle exits 1 naming it`.
  - `config prints sources`.
  - `start refuses while the lease is held`.
  - `handover to the current or a logged-out account warns and changes nothing`.
  - `setup without --apply writes nothing`.
  - `bad flags exit 2`.
- [ ] **Steps 2–5:** run (FAIL), implement, run (PASS), commit.

### Task 14: SKILL.md and references

**Files:**
- Create: `SKILL.md`, `references/ledger.md`, `references/prompts.md`, `references/accounts.md`, `references/metrics.md`

**Interfaces:**
- Consumes: the CLI of Task 13.

- [ ] **Step 1: Write SKILL.md.**
  - Frontmatter: `name: dev-batch`; a `description` in the style of the sibling skills (what it does; use when; never merges without the recorded authorization); `argument-hint: "[status|init|add|rm|pause|resume|config|clear|handover|takeover|setup] [key=value…]"`; `disable-model-invocation: false`.
  - Sections:
    - status emoji legend and language rules, as in `dev-review-pr`;
    - usage and the ask round (§6), with `AskUserQuestion` in Claude Code and one message in Codex;
    - authority (§11), including that a model-selected invocation writes no authorization line;
    - the coordinator's procedures: init (resolve the source; collect tasks from an existing region, the source's issue references, `label=` and `milestone=`; analyse dependencies; ask; `init`; `start`; arm `wait` in the background, or in the foreground with `--timeout 540` in Codex, §15), handling each judgment `kind` from Task 5 (including adding follow-up issues with `add --hold`), handover, takeover;
    - the `${CLAUDE_SKILL_DIR}` / Codex path note copied from `dev-track`.

  Keep it under 200 lines; details go to the references.
- [ ] **Step 2: Write the four references** from §7, §9, §11, §12 and §16, with the record formats from Tasks 10 and 11.
- [ ] **Step 3: Check** with `node ../../scripts/check-publication.mjs --body-file <each file>` from the skill folder (exit 0), and `claude plugin validate .` from the repository root when the CLI is available.
- [ ] **Step 4: Commit.**

### Task 15: Release wiring and full checks

**Files:**
- Modify:
  - `plugins/dev-skills/.claude-plugin/plugin.json` (version `0.3.0-beta.1`; description lists `dev-batch`);
  - `plugins/dev-skills/package.json` (description lists `dev-batch`);
  - `plugins/dev-skills/README.md` ("Nine agent skills", a table row);
  - `README.md` (skill table row);
  - `docs/install.md` ("nine skills");
  - `CHANGELOG.md` (an entry under `## Unreleased`, created at the top when absent);
  - `docs/specs/dev-batch-design.md` and this plan (frontmatter `status: implemented`, `updated`).

- [ ] **Step 1: Make the edits above**, leaving the translations in `i18n/` to their own update (§19).
- [ ] **Step 2: Run every repository check from `AGENTS.md`.**
  - `node scripts/sync-shared.mjs --check`
  - `node --test bin/gitmunk.test.mjs`
  - `(cd plugins/dev-skills && npm ci && npm test)`
  - `python3 -m unittest discover -s plugins/dev-hooks/tests`
  - `python3 -m unittest discover -s scripts/github-agent/tests`
  - `python3 -m unittest discover -s scripts/release/tests`
  - `claude plugin validate .`

  Expected: all pass.
- [ ] **Step 3: Commit, push, and update PR #45's body** (parts table, checks run with results, the live checks still owed: §18's list).

---

## After the plan: live checks (owner-run, §18)

These follow the merge into `develop` and are not tasks here, because local tests cannot prove them:

- the usage snapshot from a background session's status line;
- the `claude agents --json --all` states against a real batch;
- a background `wait` waking a Claude Code session;
- a two-issue batch in a scratch repository across two accounts with a forced handover;
- `--autocompact` after a background restart (the pilot's job records kept it in their saved respawn flags, which is promising but not proof);
- `mcp=none` keeping plugin MCP servers out;
- `metrics.jsonl` against the transcripts.

Then `/dev-batch setup` on each account.
