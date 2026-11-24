# Logs and metrics

The batch records enough for a later evaluation skill to measure it. Everything stays in the batch's local state directory ([ledger.md](ledger.md#local-state)); nothing is exported. Analysis belongs to the evaluation skill.

**GitHub cost.** The facts query of one tick costs about 4.6k GraphQL nodes per active issue (rows not merged, removed or on hold). That is fine for v1 batch sizes, but a large batch spends rate limit at every tick: keep `cap`, the batch size and the 5-minute tick interval in mind.

## events.jsonl

One JSON line per event, appended:

```json
{"at":"2026-11-18T10:05:00.000Z","type":"launch","task":42,"stage":"review","session":"er-pr55","account":"A1","detail":["--bg","--name","er-pr55","…"]}
```

| Field | Content |
|---|---|
| `at` | ISO time |
| `type` | The event type below |
| `task` | The issue number of the row, when there is one |
| `stage` | `refine`, `implement`, `review` or `merge`, when it applies |
| `session` | The session name, when it applies |
| `account` | The account alias, when it applies |
| `detail` | A plain sentence; for a loop `launch`, the full argument list |

Fields that do not apply are absent.

| Type | When |
|---|---|
| `launch` | A stage session started. A coordinator's `launch` has the detail "relaunched by the coordinator" |
| `adopt` | A live session already listed under the stage's name, in the batch's checkout, was adopted instead of launched |
| `launch-failed` | `claude` refused a launch; three in a row raise `batch-paused` |
| `stage-done` | GitHub's facts finished a stage (`merge` when the PR merged) |
| `stop`, `stop-failed` | The loop stopped, or failed to stop, a session whose stage is finished or a limited session before its replacement launches |
| `limit` | A session hit a usage limit; its account cools ([accounts.md](accounts.md#usage-limits)) |
| `owner-edit` | An owner edit of the region: `order`, `deps`, `batch`, `hold`, `answered`, `release`, `deleted` or `authorization`, with the issue and new value |
| `owner-question` | A worker asked the owner; the row is 👤 |
| `authorization-missing` | A launch waits for the owner's authorization line; the row is 👤 |
| `account-unreadable` | `claude agents` failed for an account |
| `ledger-unreadable-row` | A row of the region could not be read; it keeps its previous value |
| `github-unavailable` | A GitHub call failed and aborted the tick; the third in a row is a judgment |
| `ledger-write` | The tick wrote the ledger region to the source |
| `setting-change` | `config` (detail `config: <changed keys>`), `pause` (`paused`) or `resume` (`resumed`) changed the settings |
| `wake` | `wait` returned events; the detail lists their types |
| Judgment types | `refine-not-ready`, `owner-reply`, `review-blocked`, `review-budget-exhausted`, `stall`, `stage-failed`, `session-blocked`, `merge-stopped`, `issue-closed`, `launch-refused`, `session-unknown`, `cost-alert`, `accounts-at-cap`, `batch-paused`, `ledger-region`, `loop-error`, `loop-not-running`, `batch-complete` (handling in SKILL.md) |

Coordinator decisions are not recorded as events in v1.

## Judgments

A judgment is an event that the coordinator must decide. Its record goes to `events.jsonl` and, identically, to `pending/<epoch ms, 13 digits>-<sequence, 8 digits>.json`. The file is written under a `.tmp` name and renamed, so `wait` never reads half a file.

`wait` claims each pending file by renaming it into `delivered/`, in name order, and prints `{ "events": [ … ] }` with exit `0`. Every 60 s it also checks the lease: when the batch is active and not paused and no live loop on this host holds the lease, it queues one `loop-not-running` judgment, once per `wait`. A lease of another host cannot be checked and counts as held. With `--timeout` it prints `{ "timeout": true }` and exits `3` when nothing arrived. Two waits never deliver the same event: the rename decides. A delivered file stays in `delivered/`, so a coordinator that ended before handling it can be recovered from there.

## metrics.jsonl

One record per session that the loop launched, written when the loop stops the session or the session ends by itself. It is read from the session's transcript and its subagents' transcripts.

| Field | Content |
|---|---|
| `name`, `stage`, `task`, `pr`, `account`, `sessionId` | The session, its row and its account alias |
| `models` | The model ids seen in the transcript |
| `effort`, `autocompact` | The settings it launched with, from its session record (`autocompact` is null for a merge); null for a session the batch adopted rather than launched |
| `startedAt`, `endedAt` | The first and last transcript timestamps |
| `activeSeconds` | The gaps between API requests, each capped at 300 s, summed |
| `requests` | API requests, deduplicated by message id |
| `tokens` | `{ input, output, cacheWrite, cacheRead }`, deduplicated by message id |
| `costUsd` | Claude Code's own cost figure, or null |
| `peakContext` | The largest input plus cache tokens of one request |
| `compactions` | `[{ at, trigger, pre, post }]`: each compaction with the tokens before and after |
| `goal` | `{ met, notMet }`: `/goal` checks |
| `rateLimits`, `apiErrors` | API error messages, split by their `error` field (`rate_limit` or other) |
| `denials` | Tool calls refused for permission |
| `outcome` | `fact reached`, `retried`, `judgment` or `removed` |

v1 writes no record for the coordinator session. `/dev-review-pr` runs Codex with `--ephemeral`, so no Codex session file records the reviewer phases' usage; `dev-review-pr` publishes each phase's usage in the `USAGE` field of its report signature instead, and the review record copies it once it reads that field.

Claude Code deletes transcripts after `cleanupPeriodDays` (30 days by default); `setup` raises it to 365, so the records can be re-read from them.

## summary.json

Written once, when every row is ✅ or ⏭️. Durations are in seconds.

| Field | Content |
|---|---|
| `tasks` | Per task and stage: from the stage's first `launch` to its first `stage-done` |
| `stages` | Per stage: `{ mean, median }` of those durations |
| `costPerMergedPr` | The sum of `costUsd` over every record, divided by the merged PRs |
| `measures.mergedPrs` | PRs merged |
| `measures.implementSessions`, `measures.implementSessionsGoalMet` | Implement sessions, and those with at least one met `/goal` check |
| `measures.goalNotMetContinuations` | Unmet `/goal` checks, summed over implement sessions |
| `measures.refineToFirstMerge`, `measures.refineToLastMerge` | `{ mean, median }` per task, from the refine launch to its first and last merge |
| `measures.costPerSessionByStage`, `measures.cacheReadsPerSessionByStage` | Means per stage |
| `measures.compactionsPerImplementSession` | Mean |
| `measures.goalMetRateWithCompaction`, `measures.goalMetRateWithoutCompaction` | Share of implement sessions that met their goal, with and without a compaction |

Not computable from these files alone: task to dispatch, which needs each issue's creation time, and hours idle on a usage limit, which need the usage windows. The final roll call and the `batch-complete` event show the headline: merged PRs, the median from refine to last merge, and the cost per merged PR.
