# The batch ledger

The ledger is one marker-delimited region in the batch's source: an issue or discussion body, or a comment. The loop rewrites only this region. It splices the region into a body fetched again just before each write, so every byte outside the region survives.

## Format

```markdown
<!-- dev-batch:ledger v=1 -->
### Batch ledger

Coordinator: A1 · `er-i40c` · 🟢 running · cap 4 · merge auto · changed 2026-11-18 10:12 UTC
Owner authorization (2026-11-18 09:58 UTC, coordinator session `er-i40c`, owner's invocation `/dev-batch init src=40 merge=auto`): for every task in this ledger, …
Roll call: 3 tasks · ✅ 1 · 🔄 1 · 👤 1 · ❗ 0 events waiting

Status: 🆕 queued · ⏳ waiting on dependencies · 🔍 refining · 🛠️ implementing · 🔄 in review · 🔀 merging · ✅ merged · 👤 needs the owner · ⛔ blocked · ⏸️ on hold · ⏭️ removed

| # | Task | Deps | Batch | Status | PR · head | Session | Next |
|---|---|---|---|---|---|---|---|
| 1 | #41 Export tasks as CSV | — | B1 | ✅ | #52 · `4f2a9c1` | er-pr52m | — |
| 2 | #42 Import from CSV | #41 | B2 | 🔄 | #55 · `9b0e7d3` | er-pr55 | round 2 of 10 |
| 3 | #43 Bulk delete | — | B1 | 👤 | — | er-i43r | [decision on #43](<link>) |

<details><summary>Log</summary>

| Time (UTC) | Event |
|---|---|
| 11-18 10:05 | #42 review: er-pr55 on A1 |

</details>
<!-- /dev-batch:ledger -->
```

- **Coordinator line**: the coordinator's account alias, its session name, the loop's state (🟢 running, 🟡 paused, 🔴 stopped), `cap`, `merge`, and the time of the last write.
- **Owner authorization line**: present only when the owner recorded it; the full template is in [prompts.md](prompts.md#authorization-line).
- **Roll call**: the count per status, and the judgment events waiting for the coordinator (❗).
- **Columns**: row order, the task issue and title, its dependencies, its Batch layer, Status, the PR and its short head, the latest session, and Next (a review round, a wait reason or a decision link).
- **Log**: the last 20 events, folded. The full history is `events.jsonl` in the state directory.
- Only aliases (A1, A2), session names and GitHub links reach GitHub. Account paths, session ids and the event log stay local.

## Status legend

| Status | Meaning | Set by |
|---|---|---|
| 🆕 queued | Waiting for a slot | `init`, `add`, the owner |
| ⏳ waiting | A dependency in the ledger is not merged yet | The loop |
| 🔍 refining | `/dev-refine-issue` session | The loop |
| 🛠️ implementing | `/goal` session | The loop |
| 🔄 in review | `/dev-review-pr` session, or waiting for checks or the merge lock | The loop |
| 🔀 merging | `/dev-merge` session, or a merge that stopped | The loop |
| ✅ merged | The PR is merged | The loop, from the fact |
| 👤 needs the owner | A question, `merge=off`, or no authorization line | The loop |
| ⛔ blocked | A judgment waits for the coordinator | The loop |
| ⏸️ on hold | Not dispatched; follow-ups start here | The owner, `add --hold` |
| ⏭️ removed | Out of the batch; a running session finishes | `rm`, the owner deleting the row |

With `merge=off`, an approval-eligible row stays 👤 "waiting for merge authorization": the owner merges by hand (the row turns ✅ from the fact) or grants `config merge=auto`.

## Dispatch order

When a slot frees, the loop takes the dispatchable row with the lowest Batch, then the earliest row. A row is dispatchable when every dependency that is a row of this ledger is merged; a dependency outside the ledger counts as met. Batch is a priority, not a barrier: a B2 row whose dependencies are merged can start while an unrelated B1 row is still in review. Strict order comes from adding a dependency or putting rows on ⏸️ hold.

## Owner edits that count

The loop reads the region at every tick. The owner and the workers usually share one GitHub login, so it recognises an owner edit by what changed, not by who changed it.

- **Row order**, **Deps** and **Batch**.
- **⏸️ hold**: setting a row to ⏸️ keeps it from starting.
- **👤 or ⛔ back to 🆕**: answered or unblocked. The loop re-checks the GitHub facts and redoes only the missing step, never restarting from refine. Only a row that its refine verdict stopped is refined again, now with the answer.
- **⏸️ back to 🆕**: releases a held row. Follow-ups that `add --hold` added stay ⏸️ until then.
- **Deleting a row**: the same as `rm`; a running session finishes.
- **Editing or deleting the authorization line**: nothing new launches until it is restored or the owner runs `config` again.

A ⛔ stalled row that the owner sets back to 🆕 while its session is still working stalls again at once. Stop that session first, or wait for it to end.

The loop owns Status for every other transition, and PR · head, Session and Next. Any other change inside the region, by anyone, is overwritten by the next write; `/dev-merge` editing ledger rows of a tracker is one such change. Text outside the region is never touched.

A hand edit from GitHub's web editor is read tolerantly: CRLF line endings, extra spaces, a missing pipe and reordered rows are fine. A row whose Task cell or Status emoji cannot be read keeps its previous value and raises a `ledger-unreadable-row` event; it is never dropped.

## Writes

- The loop writes the region only when its content changes, and `changed` records that time. Each edit fires `issues: edited` or `discussion: edited` workflows, so there is no heartbeat write; the loop's liveness is its local lease.
- Just before writing, the loop fetches the body again. If the region changed since the tick read it, the write is skipped and the next tick applies the owner's edit on top of the decided rows. GitHub has no conditional write, so a concurrent edit within about a second can still be lost.
- `init` writes one region. A task list or an older ledger it replaces is kept, folded under `<details>` with the summary "Earlier task list", directly after the region. Otherwise the region is appended. No other text changes.
- When the source's author is not `OWNER`, `MEMBER` or `COLLABORATOR`, the ledger goes in a new comment by the signed-in account, and that comment becomes the batch's source.

## Local state

Each batch has a state directory, `${XDG_STATE_HOME:-~/.local/state}/dev-batch/<owner>/<repo>/<key>/`, where `<key>` is `i<N>` (issue), `d<N>` (discussion) or `c<commentId>`. The accounts on one machine share it. Do not commit or publish anything from it.

| File | What it is for |
|---|---|
| `settings.json` | The resolved settings plus `repo`, `src`, `login`, `abbr`, `authorization`, `extra`, `paused` and each setting's source. Its presence makes the directory a batch |
| `ledger.last.md` | The region as last written to GitHub |
| `ledger.next.md` | Decided changes whose GitHub write was skipped or failed. While it is pending, the next tick writes it |
| `ledger.seen.md` | The region that `ledger.next.md` was decided from. Owner edits are compared with it, so each applies once |
| `sessions.json` | One record per session the batch launched: name, stage, issue, PR, attempt, account alias, ids, start, end, when it last left `working` (`idleAt`), and state |
| `loop.json` | The loop's counters: failed GitHub ticks and launches, cooling accounts, hourly login checks |
| `events.jsonl` | Every event ([metrics.md](metrics.md#eventsjsonl)) |
| `pending/` | Judgments not yet delivered to the coordinator |
| `delivered/` | Judgments that `wait` already handed over. They are the recovery source when a coordinator ended before handling them |
| `metrics.jsonl` | One record per finished session ([metrics.md](metrics.md#metricsjsonl)) |
| `summary.json` | Written when the batch completes; its presence marks the batch inactive |
| `lease.json` | The loop's lease: pid, host, account alias, coordinator and start time |
| `loop.log` | The loop's output, one JSON line per tick |

The repository-wide `<owner>/<repo>/merge.lock` admits one merge session at a time across every batch of that repository ([prompts.md](prompts.md#stages)).

A session record's `state` is `working`, `done`, `blocked` (needs input), `limited` (blocked on a usage limit, see [accounts.md](accounts.md#usage-limits)), `stopped`, `failed`, or `unknown`. A session is `unknown` when its account cannot be read or it ran on another machine; the loop never stops or relaunches over it.
