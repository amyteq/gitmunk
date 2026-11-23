## Request

`sync` changes files right away. Add a dry run that shows what it would change.

<!-- AUTO:BEGIN -->
<!-- dev-refine-issue:body -->
## Issue refinement

### Goal and scope

One PR into `main` adds `--dry-run` to the example CLI's `sync` command: it prints the changes `sync` would make and writes nothing. Non-goals: dry runs for other commands, and changing what a real `sync` does.

### Contract and dependencies

The approved task is this issue's request. Base branch `main`; owner: the issue author; reviewer: the repository's PR review; the owner merges. No dependency. Write boundary: `src/sync.js`, `test/sync.test.js` and `docs/cli.md`.

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

### Plan, validation and evidence

Add the flag, its tests and its help text, then run the repository's tests. AC-1 is shown offline at the PR head; AC-2 is handed to the review and AC-3 to the owner.

### Authority and open items

The owner asked for this change in the request above. No decision is open.

## Execution

**Current task:** [Task instructions, revision 1](https://github.com/example-org/example-repo/issues/101#issuecomment-9101).

Ready for explicit dispatch: the scope, base, write boundary and three closed acceptance criteria are set, and no decision is open. Publishing this region and the task comment does not start implementation.

**Goal prompt**, only where supported and after readiness:

```text
/goal Execute from https://github.com/example-org/example-repo/issues/101#issuecomment-9101. Add the --dry-run flag to the sync command, on a task branch from main with one PR into main. Continue until that PR is open and AC-1 holds at its head, or, at a stop condition, until its question is posted on issue #101. Handed on, not goal conditions: AC-2 (review), AC-3 (owner).
```

**Plain-language prompt**, the same task and authority:

```text
Execute from https://github.com/example-org/example-repo/issues/101#issuecomment-9101. Add the --dry-run flag to the sync command, on a task branch from main with one PR into main. Continue until that PR is open and AC-1 holds at its head, or, at a stop condition, until its question is posted on issue #101. Handed on, not goal conditions: AC-2 (review), AC-3 (owner).
```

The receiving session must retrieve the task and canonical sources and verify their current authority. A slash command supplies no authorization or readiness transition.
<!-- AUTO:END -->
