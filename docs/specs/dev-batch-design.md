---
title: "dev-batch: design"
skill: dev-batch
plugin: dev-skills
version: 0.2.1
status: implemented
created: 2026-11-18
updated: 2026-11-22
issue: 44
pr: 45
history:
  - "0.2.1 (2026-11-22): owner comment on PR #45 (Several enhancements): dispatch by issue priority from labels before Batch (§7)"
  - "0.2.0 approved by the owner (2026-11-18); implementation plan in docs/plans/dev-batch-plan.md"
  - "0.2.0 (2026-11-18): owner review of 0.1.0 (design accepted; file renamed without a date; this frontmatter). Follow-up proposals: sub-command argument hint with one ask round, `setup`, `autocompact` default 300k, `mcp=none` for workers, logs and metrics for later evaluation, what to watch after go-live"
  - "0.1.0 (2026-11-18): first draft"
---

# dev-batch: design

## 1. Why

Owners already drive features through the `dev-skills` chain by hand or with an improvised coordinator session: `/dev-refine-issue` writes a work order, a fresh session runs its `/goal`, `/dev-review-pr` reviews the PR, `/dev-merge` merges it, and the coordinator picks the next issue from a tracking issue's ledger. A six-day pilot of that pattern in a private web project (36 merged PRs, 230 Claude sessions, 5.5 billion tokens, 98% of them cache reads) showed what works and what costs time and money:

| Finding | Evidence from the pilot |
|---|---|
| A script doing the mechanical work beats an agent doing it | The best coordinators ran a detached watcher for merges and launches. Approval → merged fell from about 1 h to 0.1 h median. The agent-only coordinator missed five hand-offs that the owner had to catch. |
| A blocking question stalls everything | One synchronous question held the coordinator for 5 h; 47 worker messages and one approved merge waited. |
| No account failover means idle nights | One account hit its weekly limit and nothing ran for 11.6 h. |
| Launch flags drift when an agent types them | Ten sessions ran on the wrong model because `--model` was omitted. |
| Refining far ahead adds latency | Task → dispatch: median 0.3 h but mean 7.7 h, because work refined 8–45 h earlier sat waiting. |
| Coordinator state belongs outside its context | Compaction fired at about 335k tokens (with `--autocompact 368k`), 18 times across three coordinators, and lost nothing because state lived in files. Idle heartbeats alone burned 41.6M tokens. |
| Every stopped session frees memory | An idle finished session holds 0.4–0.8 GB until it is stopped. |

`dev-batch` turns that pattern into one skill: give it a set of issues, and it runs each through refine → implement → review → merge in fresh named sessions, several at a time, across Claude accounts, until the set is done.

## 2. Goals, non-goals, anti-goals

**Goals**

- Run a batch of GitHub issues to merged PRs with no owner action except real decisions.
- Keep one short, readable ledger in the GitHub issue, discussion or comment the batch came from.
- Respect dependencies, a concurrency cap, one merge at a time, and per-account usage limits; move work to another account when one is near its limit.
- Let the owner talk to one long-lived coordinator session (including from the phone through Remote Control), and change settings while it runs.
- Hand the coordinator over to another account, and take it over, without losing or repeating work.
- Work when the coordinator session runs in Claude Code or in Codex.

**Non-goals (v1)**

- Deploying, or checking a deployment.
- Codex as the implementation worker. Codex stays the default reviewer inside `/dev-review-pr`.
- Reading Codex usage to throttle reviews. A review blocked by a limit surfaces as a judgment event.
- Shared resource slots beyond the cap and the merge lock (for example one E2E environment).
- Several machines coordinating one batch at the same time. Takeover across machines works through the ledger; running two loops does not.
- Analysing runs and reporting trends. The skill records events and per-session metrics (§16); a later evaluation skill reads them.

**Anti-goals** (failure even if it technically works)

- Merging or launching anything the owner did not authorize for this batch.
- Treating a worker's own claim ("done", "approved") as fact. Status comes from GitHub.
- Blocking the loop on a question to the owner.
- Growing the batch on its own: follow-up issues are registered, never queued automatically.
- Destroying owner content in the source issue or overwriting the owner's ledger edits.

## 3. Approaches

| Approach | Trade-off | Decision |
|---|---|---|
| 1. The coordinator is an agent session following SKILL.md: it reads the ledger, launches, polls on a timer | Least code. Every check is a model turn; launch flags and usage checks stay in the agent's hands, where the pilot's misses came from | Rejected |
| 2. SKILL.md plus a Node helper that does the mechanical work as a detached loop and wakes the agent only for judgment | Cheap when nothing changes, deterministic launches, the same on both hosts; more code to write and test | **Chosen by the owner** |
| 3. A standing service with its own database (queue, leases, attempts) | Most robust; needs installation, splits truth between a database and the GitHub ledger, too heavy for a plugin skill | Rejected |

How the loop reaches the agent was a second choice:

| Option | Trade-off | Decision |
|---|---|---|
| A. One long-lived coordinator session waits on a background `wait` command that ends when an event arrives | The owner keeps one session to talk to; one model turn per event, none per heartbeat | **Chosen by the owner** |
| B. A fresh short session per event | Cheapest and uniform, but no single coordinator to talk to | Rejected |

Claude Code's `/workflows` engine was not used: a workflow runs inside one session and one account, and Codex has no equivalent.

## 4. Overview

```text
owner ──/dev-batch init|add|rm|pause|config…──▶ coordinator session (Claude Code or Codex)
                                                   │  runs batch.mjs subcommands
                                                   │  waits on `batch.mjs wait` (background)
                                                   ▼
          ┌──────────── batch.mjs run (detached loop, one per batch) ────────────┐
          │ every tick: read ledger + GitHub facts + `claude agents --json` per  │
          │ account → advance each task → launch / stop sessions → write ledger  │
          │ → queue judgment events for the coordinator                          │
          └──────────────────────────────────────────────────────────────────────┘
                 │ launches (fixed argv)                  ▲ facts
                 ▼                                        │
   refine  <abbr>-i<N>r ─▶ implement <abbr>-i<N>a ─▶ review <abbr>-pr<M> ─▶ merge <abbr>-pr<M>m
   (/dev-refine-issue)     (/goal from the issue)    (/dev-review-pr)       (/dev-merge)
```

- **GitHub is the shared truth**: the ledger region in the source, the task comment and issue region that `/dev-refine-issue` writes, PRs, review markers, merge state.
- **The local state directory** holds what must not go to GitHub: account paths, session ids, the loop's lease, the event log and the settings.
- **The loop** is mechanical and never calls a model. **The coordinator agent** handles init, owner commands and judgment events.

## 5. Components

All paths are inside `plugins/dev-skills/skills/dev-batch/`.

| File | Role |
|---|---|
| `SKILL.md` | Sub-commands, authority rules, the coordinator's procedure for init, judgment events, handover and takeover |
| `references/ledger.md` | The ledger region format, status legend, owner edits that count |
| `references/prompts.md` | The launch prompt and appended scope for each stage, and the marker comments workers write |
| `references/accounts.md` | Accounts, usage snapshots, the status-line snippet, account choice, what `setup` writes |
| `references/metrics.md` | The `events.jsonl` and `metrics.jsonl` record formats (§16), for the later evaluation skill |
| `scripts/batch.mjs` | CLI entry: `ask`, `init`, `setup`, `add`, `rm`, `launch`, `handover`, `takeover`, `pause`, `resume`, `config`, `status`, `clear`, `start`, `stop`, `run`, `tick`, `wait` |
| `scripts/statusline.mjs` | The standalone usage status line that `setup` copies into each account, because the plugin cache path changes with every version |
| `scripts/*.mjs` | Modules: `config`, `ledger`, `facts` (GitHub), `sessions` (CLI adapters), `advance` (state machine), `loop`, `prompts`, `accounts`, `events`, `metrics` (transcript summary), `setup` |
| `scripts/*.test.mjs` | `node --test` suites; fixtures and stub `gh`/`claude` executables, no network |

Node 20+, no new npm dependency. Commands are spawned with argument arrays, never through a shell string; GitHub text never reaches a command line except as a separate argv element of a prompt.

## 6. Sub-commands

Usage: `/dev-batch <sub> [key=value…]` in Claude Code, `$dev-batch …` in Codex. Values with spaces use double quotes. Precedence is invocation argument, then environment variable, then default; the helper carries the default of every setting, so nothing depends on the environment being set. With no sub-command the skill runs `status`. Every sub-command takes `extra="…"`: free-text rules the coordinator keeps in the batch settings and passes to every judgment and every worker's appended scope.

**Argument hint and one ask round.** The hint lists only the sub-commands: `argument-hint: "[status|init|add|rm|pause|resume|config|clear|handover|takeover|setup] [key=value…]"`. After the sub-command, the skill collects the values that are still missing in **one** round of questions, recommended answer first: `AskUserQuestion` in Claude Code (at most four questions), one plain message in Codex that lists the questions with their defaults (a reply of `ok` takes them all). Values given on the command line are not asked again. `confirm=no` skips the round and uses the defaults; a required value with no default (the source of `init`) then stops with an error.

| Sub-command | Asked when missing (recommended first) |
|---|---|
| `init` | Source (required; offers open issues and discussions that look like trackers); `merge` (`auto` / `off`); `cap` (4 / 2 / 6); model · effort (`opus` · `xhigh` / `opus` · `high`). The question text lists the other settings with their values and sources |
| `add` | Issues; position (`end` / top / after a row); dependencies (analyse / none) |
| `rm` | Which row; stop its running session (no / yes) |
| `config` | With no keys: print every setting with its source, then ask about `cap`, `usage_cap`, `merge` and model · effort, "keep" first |
| `handover` | Target account (the other valid accounts, with their usage) |
| `takeover` | Which batch, when there are several; `force` only when the lease belongs to another host |
| `setup` | Accounts (all configured / this one); write or show the changes only |
| `status`, `pause`, `resume`, `clear` | Nothing; which batch only when it cannot be located (below) |

| Sub-command | Arguments | Effect |
|---|---|---|
| `init` | `src=` (required), `label=`, `milestone=`, `merge=`, any setting from §8 | Resolve the source, collect tasks, analyse dependencies, run the ask round with the key settings and recommendations, write the ledger region and the owner's authorization line, start the loop, arm `wait` |
| `add` | `src=` (issue numbers `12,15`, an issue, discussion or comment), `pos=` (row number or `end`, default `end`), `deps=` | Add tasks; dependencies are analysed for the new rows only |
| `rm` | `task=<issue>`, `stop=yes` | Mark the row ⏭️ removed. A running session finishes unless `stop=yes` stops it |
| `handover` | `acct=` (an alias like `A2` or a config directory), `src=` or `session=` | Validate the account, stop this loop, start a coordinator session in that account that runs `takeover` |
| `takeover` | `src=` or `session=`, `force=yes` | Reconcile the ledger with GitHub facts, take the lease, start the loop, arm `wait` |
| `pause` / `resume` | `src=` | Stop or restart new launches; running sessions continue |
| `clear` | `src=` | Stop every session this batch launched whose stage is finished; report how many it stopped |
| `config` | `key=value…` | Change settings; the loop applies them on its next step (within 15 s). With no keys, print each setting and where it came from |
| `status` | `src=` | Print the roll call, active sessions, pending events and the loop's health. Read-only |
| `setup` | `acct=` (default: every configured account), `apply=no` | For each account's user settings: install the usage status line (chaining an existing one), add the `DEV_BATCH_*` values the owner chose, and raise `cleanupPeriodDays` to 365 when it is lower or unset, so transcripts survive for evaluation. Shows the change per account, writes after the ask round with a backup beside the file, and changes nothing that is already in place |

**Locating the batch.** `src=` names it; `session=` names its coordinator session. Without either, the skill uses the only active batch of the current repository and stops when there are none or several.

**Source rules for `init`.**

- `src=<n>` is an issue or a discussion in the current repository; a comment link is that comment. Anything else, or a source the skill cannot read, stops with an error.
- Tasks come from an existing `dev-batch` region, otherwise from the source's issue references (task-list items, tables, `#n` links), plus every open issue with `label=` or in `milestone=` when given. No tasks: exit with a warning and write nothing.
- The source's author must be `OWNER`, `MEMBER` or `COLLABORATOR`: an issue's author can edit its body, and only trusted people may steer the batch. Otherwise the ledger goes in a new comment by the signed-in account, and the report says so.
- `init` writes one marker-delimited region. A task list or older ledger it replaces is kept, folded under `<details>` with the summary "Earlier task list" directly after the region (outside it, so the loop never rewrites it); no other text changes.
- Dependencies: the agent reads GitHub's "blocked by" relations, "depends on #n" text, and any dependency map in the source, writes them into the Deps column and computes batch layers (B1, B2, …). A cycle stops `init` with the cycle named.

## 7. The ledger

The ledger is one region in the source body or comment. The loop rewrites only this region, splicing it into a freshly fetched body immediately before each write.

```markdown
<!-- dev-batch:ledger v=1 -->
### Batch ledger

Coordinator: A1 · `ex-i40c` · 🟢 running · cap 4 · merge auto · changed 2026-11-18 10:12 UTC
Owner authorization (2026-11-18 09:58 UTC, coordinator session `ex-i40c`, owner's invocation `/dev-batch init src=40 merge=auto`): for every task in this ledger, refine the issue and post its task and verdict comments; implement on a task branch, commit, push it and open a PR; run `/dev-review-pr` with its review comments and fix pushes to that PR; squash merge each PR that `/dev-review-pr` leaves approval-eligible at its head, with `/dev-merge`'s closeout and `cleanup=own`.
Roll call: 9 tasks · ✅ 3 · 🔄 1 · 🛠️ 2 · 🆕 2 · 👤 1 · ❗ 0 events waiting

Status: 🆕 queued · ⏳ waiting on dependencies · 🔍 refining · 🛠️ implementing · 🔄 in review · 🔀 merging · ✅ merged · 👤 needs the owner · ⛔ blocked · ⏸️ on hold · ⏭️ removed

| # | Task | Deps | Batch | Status | PR · head | Session | Next |
|---|---|---|---|---|---|---|---|
| 1 | #41 Export tasks as CSV | — | B1 | ✅ | #52 · `4f2a9c1` | ex-pr52m | — |
| 2 | #42 Import from CSV | #41 | B2 | 🔄 | #55 · `9b0e7d3` | ex-pr55 | round 2 of 10 |
| 3 | #43 Bulk delete | — | B1 · P1 | 👤 | — | ex-i43r | [decision on #43](<link>) |

<details><summary>Log</summary>

| Time (UTC) | Event |
|---|---|
| 11-18 10:05 | #42 review round 1: 3 findings |

</details>
<!-- /dev-batch:ledger -->
```

- **Dispatch order.** When a slot frees, the loop takes the eligible row whose issue has the highest priority, then the lowest Batch, then the earliest row order. The priority comes from the issue's labels at every tick (`P0`–`P9`, `priority:P1`, `priority/high`, `high priority` and similar; `critical` or `urgent` is P0, `high` P1, `medium` or `normal` P2, `low` P3; several labels take the highest). An issue without one ranks as P2, and a labelled priority shows in the Batch cell (`B2 · P0`). The owner changes it on the issue, not in the ledger. A running session is never stopped for a higher-priority row; the priority decides only which launch takes the next free slot, for every stage. Batch is a priority among rows of equal issue priority, not a barrier: only Deps hold a task back, so a B2 row whose dependencies (those that are rows of this ledger; one outside it counts as met) are merged can start while an unrelated B1 row is still in review. Strict order comes from adding a dependency or putting rows on ⏸️ hold.
- **Owner edits that count**, read at every tick: row order, Deps, Batch, setting a row to ⏸️ (hold), setting a ⏸️ row to 🆕 (release), setting 👤 or ⛔ back to 🆕 (answered or unblocked: the loop re-checks the GitHub facts and redoes only the missing step, never restarting from refine), deleting a row (same as `rm`), and editing or deleting the authorization line (see §11). The loop owns Status for every other transition, and PR · head, Session and Next. Any other change inside the region — by anyone, including `/dev-merge` editing ledger rows of a tracker — is overwritten by the next write. The owner and the workers usually share one GitHub login, so the loop recognises owner edits by what changed, not by who changed it.
- **Write only on change.** The loop edits the source only when the region's content changes; `changed` records that time. Each edit fires `issues: edited` / `discussion: edited` workflows, so there is no heartbeat write. The loop's liveness is its local lease (§10).
- **Machine fields stay local.** Account paths, session ids and the event log live in the state directory; the ledger shows only aliases (A1, A2), session names and GitHub links. That keeps machine paths and account identities off GitHub.
- **The Log** keeps the last 20 events, folded. The full history is the local event log.
- **No conditional write exists on GitHub.** The loop re-fetches and splices just before writing, so the window for losing a concurrent edit is about a second. `shortcut: last-writer-wins within ~1 s of a concurrent body edit; add a post-write read-back and retry if lost edits are ever seen.`

## 8. Settings

| Key | Environment variable | Default | Meaning |
|---|---|---|---|
| `cap` | `DEV_BATCH_CAP` | `4` | Most worker sessions running at once (the coordinator and `/dev-review-pr`'s own reviewer/writer phases are not counted) |
| `usage_cap` | `DEV_BATCH_USAGE_CAP` | `80` | Percent of an account's 5-hour or 7-day window above which it gets no new session |
| `accounts` | `DEV_BATCH_ACCOUNTS` | the current `CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude config directories, as a JSON array or a comma-separated list; shown as A1, A2, … in that order |
| `merge` | `DEV_BATCH_MERGE` | `auto` | `auto` merges approval-eligible PRs under the owner's recorded authorization (§11), and only when that line has its merge clause; `off` leaves each approval-eligible row at 👤 "waiting for merge authorization", where the owner merges by hand (the row turns ✅ from the fact) or grants `config merge=auto` |
| `reviewer` / `writer` | `DEV_BATCH_REVIEWER` / `DEV_BATCH_WRITER` | `codex` / `claude` | Providers passed to `/dev-review-pr` |
| `rounds` | `DEV_BATCH_ROUNDS` | `10` | `/dev-review-pr` round budget |
| `model` / `effort` | `DEV_BATCH_MODEL` / `DEV_BATCH_EFFORT` | `opus` / `xhigh` | Model and effort of every Claude session the loop launches |
| `reviewer_model`, `reviewer_effort`, `writer_model`, `writer_effort` | `DEV_BATCH_REVIEWER_MODEL`, … | unset (the CLI's defaults) | Passed to `/dev-review-pr` as the owner's choice for its phases |
| `autocompact` | `DEV_BATCH_AUTOCOMPACT` | `300k` | `--autocompact` for refine, implement and review sessions and the coordinator. Merge sessions get none: none came near it in the pilot |
| `abbr` | `DEV_BATCH_ABBR` | initials of the repository name (`example-repo` → `er`; one word → its first two letters) | Session name prefix |
| `mcp` | `DEV_BATCH_MCP` | `none` | MCP servers for worker sessions: `none` launches them with `--strict-mcp-config` and no servers (each unused server held 0.2–0.5 GB in the pilot); a path to an MCP config file gives exactly those servers; `inherit` keeps the account's servers |

Fixed in v1 and documented, not configurable: loop interval 5 min (plus a 15 s check for setting changes), 2 attempts per stage, a stall after 4 h without GitHub progress, automatic `clear` of finished stages, Remote Control on, permission mode `auto`.

**Why `--autocompact 300k`.** The window is the point at which Claude Code compacts, less a reserve: the pilot's `368k` fired at a median of 335k, and models with a 1M window compact at about 967k by default (`auto`). Replaying every pilot session's real context growth at other windows:

| Window (fires at about) | Cache reads vs 368k | Compactions, 230 sessions | Per implement session |
|---|---|---|---|
| 250k (217k) | 0.70× | 235 | 2.0 |
| **300k (267k)** | **0.83×** | **164** | **1.5** |
| 368k (335k), the pilot | 1.00× | 103 (120 observed) | 1.0 (1.2 observed) |
| 500k (467k) | 1.24× | 60 | 0.6 |
| `auto` (about 967k) | 1.83× | 7 | 0.1 |

Cache reads are 98% of the tokens and count against the usage windows, and an exhausted window caused the pilot's longest stall (11.6 h). The 120 pilot compactions lost nothing, and compaction did not explain unmet goals: implement sessions that compacted met their goal more often (15 of 28) than those that did not (4 of 12). The number of unmet `/goal` checks follows session length (correlation 0.45) more than compactions (0.25). `300k` saves about a sixth of the cache reads at about 1.5 compactions per implement session, close to what the pilot showed to be safe; `250k` is the next step if the metrics in §16 hold. `auto` is rejected: almost twice the cache reads.

Two Claude Code facts the helper respects: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment overrides the flag, so `init` warns when it is set; and the documentation does not say whether `--autocompact` survives a background session's restart, which is a live check (§18).

## 9. Task lifecycle

`advance(task, facts, sessions, settings)` is a pure function that returns the next status and actions. One row per stage:

| Stage | Status | Session name | Launch prompt | Done when (GitHub fact) | Next |
|---|---|---|---|---|---|
| queued | 🆕 / ⏳ | — | — | Every dependency that is a row of this ledger is merged (a dependency outside the ledger counts as met), row not on hold, a slot free, and no eligible row ahead of it in (Batch, row order) | refine, or implement when the issue already has a current task comment and a ready verdict |
| refine | 🔍 | `<abbr>-i<N>r` | `/dev-refine-issue <N>` plus the decision policy (§11) | The issue's `## Execution` points to a current task comment **and** a `dev-batch:verdict` comment for that revision exists | `ready` → implement; `owner` → 👤; `not-ready` → judgment |
| implement | 🛠️ | `<abbr>-i<N>a` (then `2`, `3` …) | The `/goal` line from the issue's `## Execution` section, verbatim | The task's PR, by the signed-in account into this repository: one that closes #N, else one that references #N and will close it or was opened after the implement session started (never one merged before the row's first launch, except the merged closing PR of an issue closed as completed, which turns the row ✅ whenever it merged and wins over another, open PR; a closed issue with no such PR, or closed as not planned or duplicate, stops at ⛔ with an `issue-closed` judgment and is never relaunched; once the row names a PR it keeps it unless that PR is closed unmerged or a closing PR appears), and the session is idle or ended | review |
| review | 🔄 | `<abbr>-pr<M>` | `/dev-review-pr pr=<M> <rounds> <reviewer> <writer>`; the phase model/effort settings go in the appended scope as the owner's choice, because `/dev-review-pr` accepts no extra arguments | The latest trusted `dev-review-pr` report on #M has `Verdict: approval-eligible` and its `Reviewed head` is the PR's head, or a formal approval is bound to that head | merge; `blocked` or `budget-exhausted` → judgment |
| merge | 🔀 | `<abbr>-pr<M>m` | `/dev-merge pr=<M> issues=<N> cleanup=own -- Squash merge PR #<M> under the owner authorization quoted here: "<the authorization line>" (<link to the ledger>). Leave the dev-batch ledger region between its markers unchanged; the batch loop updates it.` | The PR is merged | ✅ |

- **Never reuse a session name.** A retry adds `2`, `3` … (`ex-pr55m2`). A late event from an older session updates only that session's record.
- **One merge at a time per repository.** A repository-level lock in the state directory, shared by every batch of that repository, admits one merge session at a time; `/dev-merge` itself re-checks the base. A merge launches only after every check on the PR's head has finished, because `/dev-merge`'s gate needs them finished.
- **`/dev-merge` outside the region.** Without `tracker=` it may update tracker sections of the source outside the ledger region (an older "Issues ledger", "Next steps"); that is left as it is. Inside the region its edits are overwritten (§7).
- **A new PR head after approval** sends the row back to review.
- **A session that ends without its fact**, a stage with 2 failed attempts, or 4 h without new GitHub progress becomes a judgment event; the row shows ⛔ with the reason until the coordinator decides.
- **Three consecutive failed launches** pause the batch and raise an event.
- **`dev-merge` stops** (CI failing, `hold` label, gate stop) leave the row 🔀 with the reason and raise an event; the loop does not retry a merge without a new fact.
- **Readiness.** `/dev-refine-issue` reports readiness in prose. The refine prompt asks the session, as its last step, to post one comment whose first line is `<!-- dev-batch:verdict issue=<N> revision=<R> state=ready|owner|not-ready -->` and one plain sentence. The loop counts a verdict only from the signed-in account or an `OWNER`/`MEMBER`/`COLLABORATOR`.
- **Already-refined issues**: when an issue has a current task comment, `init` asks the coordinator to judge readiness from it and post the verdict, so no refine session runs.

## 10. The loop and events

- `init` records the checkout it runs in (`git rev-parse --show-toplevel`) as `cwd` in `settings.json`. The loop and every `claude` call run there, wherever a later command is run from; once the directory is gone, every command that would start the loop or a session refuses with `checkout-missing`.
- `batch.mjs start` spawns `batch.mjs run` detached (its own process group, output to `loop.log`) and returns. `run` takes the lease: `lease.json` with pid, host, account alias, coordinator session and start time. A second `run` for the same batch exits when the lease holder is alive.
- Each tick: read the ledger and owner edits → one GraphQL query for issue, PR, review-marker and label facts of all active rows → `claude agents --json --all` once per account → `advance` every row → stop finished sessions → choose launches → write events → write the ledger if it changed. Ticks run every 5 minutes, and immediately after a setting change, a worker session ending, or `resume`.
- **Events** go to `events.jsonl`. Those that need judgment (refine `not-ready`, a review that ended blocked, a stall, a failed merge, all accounts at their cap, an owner reply on a 👤 row) are also queued in `pending/`.
- `batch.mjs wait [--timeout <s>]` returns as soon as `pending/` holds an event, prints the events as JSON, moves them to `delivered/` and exits `0`; it exits `3` on timeout. Every 60 s it also checks the lease: a batch that is active and not paused, whose lease no live loop on this host holds (a loop killed by the OOM killer, a reboot or `kill -9` writes no event), gets one `loop-not-running` judgment per `wait`. In Claude Code the coordinator runs it as a background command, so the session wakes only when it exits. In Codex it runs in the foreground with `--timeout 540` and is re-run after each return.
- While no `wait` is armed (the coordinator session ended), events stay pending, the coordinator line shows "❗ N events waiting", and the loop keeps doing mechanical work. `takeover` picks the events up.
- When every row is ✅ or ⏭️, the loop writes a final roll call with stage durations from the event log, raises a `batch-complete` event and exits.

## 11. Authority and safety

- **One authorization line for the whole pipeline.** The owner chose a fully automatic batch, so `init` writes one "Owner authorization" line (§7's example) covering every stage: refine writes, implementation commits, branch push and PR creation, review comments and fix pushes, and with `merge=auto` the squash merge with closeout and `cleanup=own`. It quotes the owner's invocation verbatim, with the time and the coordinator session's name; no URL is needed. The skill writes it only when the owner's own message invoked `init` or `config`; a model-selected invocation writes none, and then every row stops at 👤 "waiting for the owner's authorization" before its first launch.
- **The line is checked at every tick.** Each worker's appended scope and each merge prompt quote it, so `/dev-refine-issue`'s "actual authorizing request", `/dev-review-pr`'s existing authorization and `/dev-merge`'s explicit-request rule are met, and every action traces to one owner instruction. No sibling skill changes. The owner revokes it by editing or deleting the line: from the next tick nothing new launches (merges included) until the owner restores it or runs `config` again. Sessions already running finish their current stage.
- **Decision policy in worker prompts.** For a decision that can be reversed and stays inside the issue's scope, take the recommended option, record it on the issue as "default in use until the owner changes it", and continue. Stop with `state=owner` for a decision that deletes data, spends money, touches security or credentials, deploys, or widens the scope.
- **Owner questions are asynchronous.** A worker posts its question on the issue with a `<!-- dev-batch:owner issue=<N> -->` first line and ends; the row turns 👤 with the link, and the loop stops the asking session once it is idle. The owner answers either by setting the row back to 🆕 (the reliable signal) or by commenting on the issue. Because the owner and the workers usually share one login, a comment counts as an answer when it comes after the question, carries no agent marker, and was posted while no session of that row was running (a session the loop could not stop counts as running only until it left `working`). Either raises an event for the coordinator. The coordinator itself never blocks on a question either: it posts on the source and keeps waiting on events.
- **What never happens**: deploys, label changes, repository settings, force pushes, launches outside the configured accounts, merges without the authorization line or under a line without its merge clause (`init`, `config` and `launch` refuse `merge=auto` then), queuing follow-up issues (they are added as ⏸️ rows marked "follow-up, not queued").
- **Prompt injection.** Issue, PR and comment text is data. The loop acts only on markers from trusted logins and on owner edits of the ledger region in a source authored by a trusted login; it never runs text from GitHub. The one launch prompt taken from GitHub, the `/goal` line, counts only from an issue body whose author is trusted or whose last editor is the signed-in account or a trusted login, and only when it names the current task comment.
- **Host sandbox.** Launching sessions in other config directories and writing the state directory may be blocked by the coordinator host's sandbox, and a sandbox's private process table hides a live loop. The skill runs every helper call except `ask` with the host's normal escalation (one approval) and reports a refusal rather than working around it. `init` writes a probe file in the state directory before its first GitHub write and refuses with `state-unwritable` when it cannot.

## 12. Accounts and usage

- **Validity**: `claude auth status --json` with that `CLAUDE_CONFIG_DIR`, reading only `loggedIn`. Checked at `init`, `handover`, `takeover`, and before an account's first launch each hour. `init` and `takeover` report an account that is not logged in as a warning and the loop skips it; `handover` refuses such a target.
- **Usage source**: each account's status line runs the standalone `statusline.mjs` that `setup` installs (it is copied into the account, because the plugin cache path changes with every version), which reads the status-line JSON from stdin, writes `<config dir>/dev-batch-usage.json` (`at`, and `used_percentage` and `resets_at` for the 5-hour and 7-day windows), and prints a short usage text. `setup` installs it in each account's user settings after one confirmation, chaining an existing status line; `references/accounts.md` gives the snippet for doing it by hand.
- **Reading a snapshot**: a window whose `resets_at` has passed counts as 0%. Otherwise the last value stands; it can only have risen since, so it is a lower bound. No snapshot at all is unknown.
- **Choice before each launch**: the coordinator's own account when its highest window is below `usage_cap`; otherwise the known account with the lowest usage below the cap; otherwise an unknown account, one session at a time until a snapshot appears; otherwise no launch, one `accounts-at-cap` event, and the next attempt at the earliest `resets_at`.
- **Hitting a limit anyway**: a session whose job turns `blocked` with a usage-limit message in the last 20 lines of `claude logs` marks its account cooling until the last reset time stated there (or one hour), and the task's stage is relaunched in another account under the next session name, continuing from the pushed branch.

## 13. Handover and takeover

- `handover acct=<x>`: an empty, unknown, logged-out or current account warns and changes nothing. Otherwise: pause launches, stop this loop, log the handover in the ledger, then start `<abbr>-<i|d><src>c<k>` in that account with `/dev-batch takeover src=<src>` and Remote Control. Worker sessions keep running in their own accounts; the new loop still sees them through the account list.
- `takeover`: refuse while the lease holder's pid is alive on this host. A lease from another host cannot be checked, so taking it over needs `force=yes` (several machines running one batch is a non-goal). Then, for each row, compare the ledger with GitHub facts and session states and redo only the missing step: a PR with no review gets a review; an approval with no merge gets a merge; a finished session with no fact becomes an event. Nothing already done is relaunched. Then take the lease, start the loop and arm `wait`.
- Across machines, `takeover` works from the ledger and GitHub alone; session ids from the other machine are unknown and shown as such. On a machine without the batch's local state, `takeover src=` rebuilds it from the ledger and GitHub and records no authorization: merges wait until the owner runs `config` with the authorization again (§11). It also needs `force=yes`, because the last loop ran on another host. The rebuild records the checkout it runs in, after checking that its `origin` is the batch's repository (else `checkout-missing`).
- `stop` gives the lease up only after the loop has exited; while a tick is still running it reports `loop-busy`, and the loop stops after that tick.

## 14. `clear` and memory

The loop stops a session as soon as its stage's GitHub fact is observed and the session is idle or ended (`claude stop`, which keeps the transcript and worktree), and every idle session of a ✅ merged or ⏭️ removed row, such as a merge session that was still closing out when the merge was seen. `clear` does the same sweep on demand for every session this batch launched and reports how many it stopped. It never stops a working session, the coordinator, or a session it did not launch.

## 15. Codex as the coordinator host

The SKILL.md procedure is host-neutral and the helper is plain Node. Differences: `wait` runs in the foreground with a timeout instead of in the background, and the handover target is always a Claude account. Workers are Claude sessions in v1 whatever the host.

## 16. Logs and metrics

The skill records enough for a later evaluation skill to measure each batch without the archaeology the pilot needed. Everything stays in the local state directory, `${XDG_STATE_HOME:-~/.local/state}/dev-batch/<owner>/<repo>/<source>/`, which the accounts on one machine share.

| File | One record per | Content |
|---|---|---|
| `events.jsonl` | Event | Time, task, stage, session, account alias, type (launch with its argv, stage done, ledger write, wake, judgment, owner edit, limit, stop, setting change) and detail |
| `metrics.jsonl` | Session, written when the loop stops it or it ends | Name, stage, task, PR, account alias, session id, models, effort, autocompact, start and end, active time, API requests; tokens by type (input, output, cache write, cache read; deduplicated by message id, subagents included); Claude Code's own cost figure; peak context; each compaction with the tokens before and after; `/goal` checks met and not met; rate-limit and API errors; permission denials; outcome (fact reached, retried, judgment, removed). Read from the session's transcript. Workers only: the coordinator's own record is later, not in v1 |
| `summary.json` | Batch, at completion | Stage durations per task, mean and median per stage, cost per merged PR and the measures in §17; the final roll call in the ledger shows the headline numbers |

- **Reviewer phases.** `/dev-review-pr` runs Codex with `--ephemeral`, so its usage is not recorded anywhere. A separate `dev-review-pr` change, tracked in its own issue, should put each phase's Codex usage in its report marker; `dev-batch` copies it into the review session's record when it is there.
- **Retention.** Claude Code deletes transcripts after `cleanupPeriodDays` (30 days by default); `setup` raises it to 365.
- **Later, not in v1.** The coordinator's own `metrics.jsonl` record and its decisions as events.
- **Not included.** OpenTelemetry export, which needs a collector while the transcripts and these files are enough; and analysis, which belongs to the later evaluation skill.

## 17. What to watch after go-live

| Measure | Pilot | Look for |
|---|---|---|
| Implement sessions that met their `/goal` | 19 of 40; 336 "not met" continuations | More, with just-in-time refine writing acceptance criteria against current code |
| Refine → last merge, per issue (mean / median) | 17.3 h / 10.8 h | Lower |
| Refine → first merge | 13.3 h / 6.2 h | Lower |
| Task → dispatch | 7.7 h / 0.3 h | Mean close to the median, since refine now runs just before dispatch |
| Cost per session, top three stages (mean) | Coordinator $50.6, implement $17.0, review $15.8 | Lower. Cost is the headline because it weighs output, cache writes and cache reads; raw tokens are 98% cache reads, the cheapest kind, and output is under 1% |
| Cache reads per session, same three stages (mean) | 230M, 37M, 39M | Lower at `autocompact=300k`; this is what fills the usage windows |
| Cost per merged PR | $63 | Lower |
| Compactions per implement session; goal met with and without | 1.2; 54% / 33% | No fall in the met rate at 300k |
| Hours with work waiting and no session running because of a usage limit | 11.6 h | None |

## 18. Verification

**Offline tests** (`npm test`, fixtures and stub executables only):

- argument parsing, validation and precedence (argument > environment > default); which values the ask round asks per sub-command, and `confirm=no`;
- `setup`: chains an existing status line, keeps a backup, removes nothing, and a second run changes nothing;
- metrics from a fixture transcript: deduplication by message id, subagents, compactions, `/goal` checks, cost;
- ledger parse → render round-trip; splicing preserves every byte outside the region; each owner edit in §7;
- `advance` as a table: each stage × each fact combination → status and actions, including retries, stalls, head changes and merge-lock contention;
- dependency layering and cycle detection;
- account choice: below cap, at cap, reset passed, stale, unknown, all at cap;
- launch argv per stage (no shell strings), session names and no reuse;
- fact extraction: review verdict at head, task-comment pointer and `/goal` line from an issue region, verdict and owner markers from trusted and untrusted logins, PR linkage;
- `wait` semantics; lease refusal; a full `tick` against stub `gh` and `claude`.

**Live checks** (owner-run; local tests do not prove them): the usage snapshot is written from a background session's status line; `claude agents --json --all` reports the states the loop expects; a background `wait` wakes a Claude Code session; one small batch of two dependent issues in a scratch repository runs to merge across two accounts with a forced handover; `--autocompact` is still in effect after a background session restarts; `mcp=none` also keeps plugin-provided MCP servers out; `metrics.jsonl` from that batch matches the transcripts.

## 19. Rollout

A task branch from `develop` and one PR into `develop` (the beta channel), tracked by #44. `dev-skills` goes to `0.3.0`; `CHANGELOG.md`, the plugin README's skill table and the root README's skill table gain `dev-batch`. Translations under `i18n/` are left to their own update. After the merge, the owner runs `/dev-batch setup` once for the configured accounts.

## 20. Calls made in this design (for the owner to check)

1. `status` added as the default, read-only sub-command.
2. The loop interval, attempts, stall time, automatic clear, Remote Control and permission mode are fixed rather than configurable.
3. The ledger table is the source of owner-editable fields; no hidden JSON state block on GitHub.
4. Readiness comes from a small `dev-batch:verdict` comment the refine session posts, instead of changing `dev-refine-issue`.
5. Default `model=opus` (an alias); owners pin an exact model through `DEV_BATCH_MODEL`.
6. An untrusted source author moves the ledger to a comment by the signed-in account.
7. Follow-up issues become ⏸️ rows, never queued automatically.
8. One authorization line covers the whole pipeline; it quotes the owner's invocation and session name rather than a URL; editing or deleting it stops new launches from the next tick.
9. `merge` is `auto` or `off`; there is no per-PR release. With `off`, the owner merges by hand or grants `config merge=auto`.
10. Setting 👤 or ⛔ back to 🆕 re-checks the facts and redoes only the missing step.
11. Owner answers are recognised by what changed (a ledger edit) or by an unmarked comment while no session of the row runs, since owner and workers share a login.
12. The ledger is written only on change; the loop's liveness is its local lease; cross-host takeover needs `force=yes`.
13. Merges use `cleanup=own`, wait for the PR's checks to finish, take a repository-wide lock, and are told to leave the ledger region alone; `/dev-merge`'s edits inside it are overwritten.
14. Settings, including the account list, are fixed at `init` and change only through `config`.
15. One ask round after the sub-command collects missing values; it replaces `init`'s single confirmation question.
16. `setup` is a sub-command that writes the owner's user settings, after the ask round and with a backup.
17. `autocompact` defaults to `300k` for workers and the coordinator.
18. Metrics are read from transcripts when a session stops, not exported through OpenTelemetry.
19. Codex reviewer usage needs a separate `dev-review-pr` change; `dev-batch` only copies it when present.
20. Worker sessions get no MCP servers by default (`mcp=none`); a project that needs some names them in a config file.

Credit: the stage separation, "a worker's report is a lead, not evidence", never reusing an identifier, and the takeover rule "redo only the missing step" were adapted from `dabingfy-dot/solo-to-team-skills` (MIT).
