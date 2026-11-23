<!-- dev-refine-issue:task repo=example-org/example-repo issue=102 revision=1 -->
## Task — drop the `legacy_sessions` table

**Repository:** `example-org/example-repo` · **Issue:** [#102](https://github.com/example-org/example-repo/issues/102) · **Owner/reviewer:** owner: the issue author; reviewer: the repository's PR review · **Revision:** 1

Prepared and not dispatched.

### Goal

One PR into `main` removes the `legacy_sessions` table: a migration drops it and no code refers to it. Completion artifact: the open PR whose head meets AC-1 and AC-2, or, at owner gate G1, its question posted on the issue.

### Read first

- The repository's `AGENTS.md` and `CLAUDE.md`, then `docs/database.md`.
- [Issue #102](https://github.com/example-org/example-repo/issues/102): the request and owner gate G1.

### Scope and deliverables

Base: `main`. Write boundary: `migrations/`, `src/db/` and `test/db/`. Non-goals: archiving the rows, and other tables.

Owner gate G1: dropping the table deletes its rows. Before the migration is committed, post on the issue the question whether any reader outside this repository still uses the table, then end the session. The drop waits for the owner's answer and a new dispatch.

### Implementation instructions

1. Retrieve this task and verify the issue still points to this revision; reconcile any disagreement before acting.
2. Confirm current authorization, this contract and readiness. This comment alone does not satisfy these prerequisites.
3. Create a clean worktree on a task branch from `main` and record base and HEAD.
4. Remove the code in `src/db/` that refers to the table, push the branch, then ask the owner gate G1 question and end the session.
5. After the owner confirms and the task is dispatched again, add the migration and its test, run the repository's tests at the exact HEAD and open one PR into `main`. The owner merges.

### Acceptance criteria

<!-- acs:begin -->
- **AC-1**: a migration drops `legacy_sessions`. Shown at: PR head.
  - (a) After `migrate up`, the schema test finds no `legacy_sessions` table. Evidence: a test in `test/db/schema.test.js`.
  - (b) After `migrate down`, the table exists again and is empty. Evidence: the same test.
- **AC-2**: no code refers to the table. Shown at: PR head.
  - (a) A search of `src/` and `test/` for `legacy_sessions` finds only the migration and its test. Evidence: the search command and its output in the PR body.
<!-- acs:end -->

### Validation and evidence

| AC | Check | Evidence |
|---|---|---|
| AC-1 | `npm test` at the PR head | The test names and exit 0 |
| AC-2 | The search at the PR head | Its output in the PR body |

All evidence is offline. A skipped or failed check is never reported as passed.

### Authorization and boundaries

The owner's request in the issue covers edits, commits, a pushed task branch and one PR into `main`, and the owner gate G1 question on the issue. Committing the drop before the owner's answer, merging and label changes are not allowed. Refinement does not dispatch this task.

### Stop conditions and closeout

- Success: the PR into `main` is open and AC-1 and AC-2 hold at its head. Handed on, not goal conditions: the PR's review and merge.
- Blocked: owner gate G1, a needed change outside the write boundary or a missing permission prevents the next step. Preserve progress, post the question on the issue and end the session without waiting for the answer; posting it ends the goal.
- Cancellation or budget: stop within the bound, push the task branch and leave a continuation note on the issue; this ends the goal without a question.

Closeout: base and final HEAD, branch, PR link or the owner gate G1 question, the AC-to-evidence map, changed paths, each command's outcome and the remaining gates (G1 if unanswered, review, merge).
