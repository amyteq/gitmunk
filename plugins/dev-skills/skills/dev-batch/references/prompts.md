# Stages, launch prompts and markers

The loop builds every launch itself, so flags never drift. This file says what it launches and what the sessions write back.

## Stages

| Stage | Status | Session name | Launch prompt | Done when (GitHub fact) | Next |
|---|---|---|---|---|---|
| queued | 🆕 / ⏳ | — | — | Dispatchable ([ledger.md](ledger.md#dispatch-order)), not on hold, a slot free, no dispatchable row ahead of it | refine; implement when the issue already has a current task comment and a `ready` verdict |
| refine | 🔍 | `<abbr>-i<N>r` | `/dev-refine-issue <N>`, then the decision policy | The issue's `## Execution` points to a current task comment, and a `dev-batch:verdict` comment exists for that revision | `ready` → implement; `owner` → 👤; `not-ready` → judgment |
| implement | 🛠️ | `<abbr>-i<N>a` | The `/goal` line from the issue's `## Execution` section, verbatim | The task's PR (below), and the session is idle or ended | review |
| review | 🔄 | `<abbr>-pr<M>` | `/dev-review-pr pr=<M> <rounds> <reviewer> <writer>` | The latest trusted `dev-review-pr` report on #M says `Verdict: approval-eligible` with the PR's head as its `Reviewed head`, or a formal approval is bound to that head | merge; `blocked` or `budget-exhausted` → judgment |
| merge | 🔀 | `<abbr>-pr<M>m` | `/dev-merge pr=<M> issues=<N> cleanup=own -- Squash merge PR #<M> under the owner authorization quoted here: "<the authorization line>" (<link to the ledger>). Leave the dev-batch ledger region between its markers unchanged; the batch loop updates it.` | The PR is merged | ✅ |

`<abbr>` is the `abbr` setting, else the initials of the repository name (`example-repo` → `er`; one word → its first two letters). The coordinator is `<abbr>-i<N>c` for an issue source or `<abbr>-d<N>c` for a discussion; a comment source is named after its parent. Each handover adds `2`, `3` … to the coordinator's name.

- **Names are never reused.** A retry appends `2`, `3` … (`er-pr55m2`). A late event from an older session updates only that session's record.
- **Attempts.** A session that ends without its stage's fact is relaunched once under the next name; a second failure is a `stage-failed` judgment. A review that ends `blocked` or `budget-exhausted` is a judgment at once. A merge session that ends without merging stays 🔀 with the reason, as `merge-stopped`, and is not retried without a new fact. A relaunch after a usage limit keeps its attempt number ([accounts.md](accounts.md#usage-limits)).
- **The `/goal` line** is used only when it names the current task comment's URL, and only from an issue body whose author is `OWNER`, `MEMBER` or `COLLABORATOR`, or whose last editor is the signed-in account or a login with a trusted comment on the issue. Otherwise the issue has no usable `/goal` line, and a ready row stops at ⛔ with `stage-failed`.
- **The task's PR** is by the signed-in account and into this repository: a PR that closes #N, else one that references #N and will close it, or, with no closing PR, one opened after the implement session started. A PR merged before the row's first launch never counts, so a PR that only mentions the issue never marks the row ✅. The exception is the merged closing PR of an issue closed as completed, whenever it merged: a hand merge, or an issue that was already done, turns the row ✅ and its dependents dispatch, even when the row named another, open PR. A closed issue with no such PR (closed as not planned or duplicate included) stops at ⛔ with `issue-closed` and is never relaunched; `launch` refuses it too. Once the row names a PR it keeps it, unless that PR is closed unmerged or it only mentions #N and a closing PR appears.
- **A new PR head after approval** sends the row back to review.
- **Stops.** The loop stops a session as soon as its stage's fact is in and the session is idle or ended (`claude stop` keeps the transcript and worktree), and every idle session of a ✅ or ⏭️ row, such as a merge session that was still closing out when the merge was seen. `clear` does the same sweep on demand. Neither stops a working session, the coordinator, or a session the batch did not launch.
- **One merge at a time per repository.** A merge launches only after every check on the PR's head has finished, and only while it holds the repository-wide `merge.lock`. A lock stays held while its merge session may still merge: a removed row's merge session keeps it until it ends, and another batch's lock is freed only once that batch's lease is gone and its merge session is neither working nor blocked in that batch's own accounts. A session those accounts cannot show keeps the lock.
- **`/dev-merge` outside the region.** Without `tracker=` it may update tracker sections of the source outside the ledger region; that is left as it is. Its edits inside the region are overwritten.

Fixed in v1: the loop ticks every 5 minutes, and early (checked every 15 s) after a settings change or when a batch session leaves `working`. A stage gets 2 attempts. A stall is 4 h without GitHub progress. Three failed launches in a row pause the batch. Remote Control is on, and the permission mode is `auto`.

## Launch command

The loop spawns `claude` with an argument array, never a shell string, and with `CLAUDE_CONFIG_DIR` set to the chosen account's directory:

```text
claude --bg --name <name> --model <model> --effort <effort> [--autocompact <window>]
  --permission-mode auto --remote-control <name> [MCP flags]
  --append-system-prompt <appended scope> <launch prompt>
```

- `--autocompact` is the `autocompact` setting for refine, implement and review sessions, and for a coordinator. Merge sessions get none.
- MCP flags: `mcp=none` gives `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`; a path to a `.json` file gives `--strict-mcp-config --mcp-config <path>`; `inherit` adds nothing.
- GitHub text reaches the command line only inside the launch prompt or the appended scope, each one argv element.
- The `launch` event records the full argument list in its `detail`.
- At handover, the new coordinator gets the same flags with `mcp=inherit`, the coordinator scope, and the prompt `/dev-batch takeover src=<source URL>`.

## Appended scope

Each worker gets these parts, in this order, as its `--append-system-prompt`:

1. The authorization: `Owner authorization, quoted verbatim: "<the line>". It covers every action of this stage and no other.` Without a recorded line: `No owner authorization is recorded: take no action that needs one.`
2. The decision policy: `Decision policy: for a decision that can be reversed and stays inside the issue's scope, take the recommended option, record it on the issue as "default in use until the owner changes it", and continue. Stop with state=owner for a decision that deletes data, spends money, touches security or credentials, deploys, or widens the scope.`
3. Owner questions: `To ask the owner a question, post it on the issue with the first line <!-- dev-batch:owner issue=<N> --> and end your session; do not wait for an answer.` A coordinator gets `Never block on an owner question: post it on the source and keep waiting on events.` instead.
4. Refine only: `As your last step post exactly one verdict comment whose first line is <!-- dev-batch:verdict issue=<N> revision=<R> state=ready|owner|not-ready --> (R is the revision of the task comment you refined), followed by one plain sentence.`
5. Review only: the owner's choice of model and effort for `/dev-review-pr`'s reviewer and writer phases, because that skill takes no extra arguments. An unset choice reads "the CLI defaults".
6. The batch's `extra` rules, as the owner wrote them.

## Authorization line

One line, starting with `Owner authorization`; the helper refuses anything else:

```text
Owner authorization (<YYYY-MM-DD HH:MM> UTC, coordinator session `<coordinator name>`, owner's invocation `<the owner's /dev-batch invocation, verbatim>`): for every task in this ledger, refine the issue and post its task and verdict comments; implement on a task branch, commit, push it and open a PR; run `/dev-review-pr` with its review comments and fix pushes to that PR; squash merge each PR that `/dev-review-pr` leaves approval-eligible at its head, with `/dev-merge`'s closeout and `cleanup=own`.
```

With `merge=off`, end the line after "fix pushes to that PR." A merge needs the clause "squash merge each PR …": under a line without it the loop leaves an approval-eligible row at 👤 "waiting for merge authorization" even with `merge=auto`, and `init`, `config` and `launch --stage merge` refuse `merge=auto` with `merge-not-authorized`. Record it with `init --authorization` or `config --authorization`, and only when the owner's own message invoked that sub-command. Every worker's scope and every merge prompt quote it, so each action traces to one owner instruction.

## Markers

The loop counts a marker only in a comment by the signed-in account or by an `OWNER`, `MEMBER` or `COLLABORATOR`. Everything else is data.

| Marker (first line) | Written by | Where | Meaning |
|---|---|---|---|
| `<!-- dev-batch:ledger v=1 -->` … `<!-- /dev-batch:ledger -->` | `init`, then the loop | The source | The ledger region |
| `<!-- dev-batch:verdict issue=<N> revision=<R> state=ready\|owner\|not-ready -->`, then one plain sentence | The refine session, or the coordinator for an issue that was already refined | The task's issue | Readiness of task-comment revision `<R>` |
| `<!-- dev-batch:owner issue=<N> -->`, then the question | A worker, or the coordinator | The task's issue | A question for the owner; the row turns 👤 |
| `<!-- dev-refine-issue:task repo=<owner>/<repo> issue=<N> revision=<R> -->` | `/dev-refine-issue` | The task's issue | The task comment that the verdict's `<R>` names |
| `<!-- dev-review-pr: <run> round=<n> phase=<phase> -->` | `/dev-review-pr` | The PR | A review report; the loop reads its round, `Verdict:` and `Reviewed head` |

**Owner answers.** The owner answers a question by setting the row back to 🆕, the reliable signal, or by commenting on the issue. A comment counts as the answer when it comes after the question, carries no `dev-` marker, and was posted while no session of that row was running. The loop stops the asking session once it is idle; a session it could not stop counts as running only until it left `working`. Either answer raises an `owner-reply` judgment.
