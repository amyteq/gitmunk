## Request

Nothing in this repository uses the `legacy_sessions` table any more. Drop it.

<!-- AUTO:BEGIN -->
<!-- dev-refine-issue:body -->
## Issue refinement

### Goal and scope

One PR into `main` removes the `legacy_sessions` table: a migration drops it and no code refers to it. Dropping the table deletes its rows, so owner gate G1 comes before the drop. Non-goals: archiving the rows, and other tables.

### Contract and dependencies

The approved task is this issue's request. Base branch `main`; owner: the issue author; reviewer: the repository's PR review; the owner merges. No dependency. Write boundary: `migrations/`, `src/db/` and `test/db/`.

### Acceptance criteria

<!-- acs:begin -->
- **AC-1**: a migration drops `legacy_sessions`. Shown at: PR head.
  - (a) After `migrate up`, the schema test finds no `legacy_sessions` table. Evidence: a test in `test/db/schema.test.js`.
  - (b) After `migrate down`, the table exists again and is empty. Evidence: the same test.
- **AC-2**: no code refers to the table. Shown at: PR head.
  - (a) A search of `src/` and `test/` for `legacy_sessions` finds only the migration and its test. Evidence: the search command and its output in the PR body.
<!-- acs:end -->

### Plan, validation and evidence

Remove the code that refers to the table, ask the owner gate G1 question, and after the owner's answer add the migration and its test. Both criteria are shown offline at the PR head.

### Authority and open items

The owner asked for this change in the request above. Owner gate G1: dropping the table deletes data, so before the migration is committed the owner confirms that no reader outside this repository still uses the table.

## Execution

**Current task:** [Task instructions, revision 1](https://github.com/example-org/example-repo/issues/102#issuecomment-9102).

Ready for explicit dispatch: the scope, base, write boundary, owner gate G1 and two closed acceptance criteria are set. Publishing this region and the task comment does not start implementation.

**Goal prompt**, only where supported and after readiness:

```text
/goal Execute from https://github.com/example-org/example-repo/issues/102#issuecomment-9102. Drop the unused legacy_sessions table, on a task branch from main with one PR into main. Continue until that PR is open and AC-1 and AC-2 hold at its head, or, at owner gate G1 or another stop condition, until its question is posted on issue #102. Handed on, not goal conditions: the PR's review and merge.
```

**Plain-language prompt**, the same task and authority:

```text
Execute from https://github.com/example-org/example-repo/issues/102#issuecomment-9102. Drop the unused legacy_sessions table, on a task branch from main with one PR into main. Continue until that PR is open and AC-1 and AC-2 hold at its head, or, at owner gate G1 or another stop condition, until its question is posted on issue #102. Handed on, not goal conditions: the PR's review and merge.
```

The receiving session must retrieve the task and canonical sources and verify their current authority. A slash command supplies no authorization or readiness transition.
<!-- AUTO:END -->
