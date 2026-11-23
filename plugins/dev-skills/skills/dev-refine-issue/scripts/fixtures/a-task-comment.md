<!-- dev-refine-issue:task repo=example-org/example-repo issue=101 revision=1 -->
## Task — `--dry-run` for the `sync` command

**Repository:** `example-org/example-repo` · **Issue:** [#101](https://github.com/example-org/example-repo/issues/101) · **Owner/reviewer:** owner: the issue author; reviewer: the repository's PR review · **Revision:** 1

Prepared and not dispatched.

### Goal

One PR into `main` adds `--dry-run` to `sync`: it prints the changes `sync` would make and writes nothing. Completion artifact: the open PR whose head meets AC-1.

### Read first

- The repository's `AGENTS.md` and `CLAUDE.md`, then `docs/cli.md`.
- [Issue #101](https://github.com/example-org/example-repo/issues/101): the request.

### Scope and deliverables

Base: `main`. Write boundary: `src/sync.js`, `test/sync.test.js` and `docs/cli.md`. Non-goals: dry runs for other commands, and changing what a real `sync` does.

### Implementation instructions

1. Retrieve this task and verify the issue still points to this revision; reconcile any disagreement before acting.
2. Confirm current authorization, this contract and readiness. This comment alone does not satisfy these prerequisites.
3. Create a clean worktree on a task branch from `main` and record base and HEAD.
4. Add the flag to `src/sync.js`, its tests to `test/sync.test.js` and its help text to `docs/cli.md`.
5. Run the repository's tests at the exact HEAD, push the branch and open one PR into `main`. The owner merges.

### Acceptance criteria

<!-- acs:begin -->
- **AC-1**: `sync --dry-run` reports and writes nothing. Shown at: PR head.
  - (a) With one changed file, it prints `would update docs/a.md`, exits 0 and leaves the file unchanged. Evidence: a test in `test/sync.test.js`.
  - (b) With no change, it prints `nothing to sync` and exits 0. Evidence: the same test file.
- **AC-2**: the help text of `--dry-run` follows the style of the other flags in `docs/cli.md`. Shown at: review.
  - (a) The PR review confirms the wording. Evidence: the review comment.
- **AC-3**: a live dry run lists the files the next real sync changes. Shown at: owner.
  - (a) After the release, the owner runs `sync --dry-run` and then `sync` against the staging mirror; both list the same files. Evidence: the owner's note on this issue.
<!-- acs:end -->

### Validation and evidence

| AC | Check | Evidence |
|---|---|---|
| AC-1 | `npm test` at the PR head | The test names and exit 0 |
| AC-2 | The PR review | Handed to the review |
| AC-3 | A live run after the release | Handed to the owner |

All of the implement session's evidence is offline. A skipped or failed check is never reported as passed.

### Authorization and boundaries

The owner's request in the issue covers edits, commits, a pushed task branch and one PR into `main`. Merging, releases and label changes stay with the owner. Refinement does not dispatch this task.

### Stop conditions and closeout

- Success: the PR into `main` is open and AC-1 holds at its head. Handed on, not goal conditions: AC-2 (review), AC-3 (owner).
- Blocked: a needed change outside the write boundary or a missing permission prevents the next step. Preserve progress, post the question on the issue and end the session without waiting for the answer; posting it ends the goal.
- Cancellation or budget: stop within the bound, push the task branch and leave a continuation note on the issue; this ends the goal without a question.

Closeout: base and final HEAD, branch, PR link, the AC-to-evidence map, changed paths, each command's outcome and the remaining gates (AC-2 review, AC-3 owner, merge).
