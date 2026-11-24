# dev-skills

Ten agent skills for GitHub-centred work in Claude Code and Codex.

| Skill | Use it to |
| --- | --- |
| `dev-review-pr` | Run bounded review and fix rounds on a PR with independent Codex or Claude Code sessions, evidence-linked dispositions and a final full review before approval. |
| `dev-refine-issue` | Turn an existing issue into a bounded work order with observable acceptance criteria, a task comment and copyable launch prompts. |
| `dev-explain` | Explain pending human decisions on an issue, PR or discussion comment and append one result comment. It decides nothing. |
| `dev-interview` | Ask the owner's pending decisions on an issue, PR or discussion (optionally its sub-issues and linked threads) in rounds of popups, and record each answer where its item sits before the next round. It never acts on a decision. |
| `dev-compact` | Compress a long issue, PR or discussion thread into a summary and archive parts, after an explicit request. |
| `dev-merge` | Squash merge one reviewed PR when the owner explicitly asks: gate on the reviewed head, verify the merged tree, clean up branches and worktrees, post a closeout in the PR's language and update linked issues and trackers. Otherwise it runs as a dry run. |
| `dev-track` | Register every unprocessed discussion of one category (such as meeting notes) in that category's tracker discussion: digest it in place, merge its TODOs, mark it done and close it. Drafts by default; writes only with `--apply`. |
| `dev-analyse-rp` | Analyse a requirements programme into a reviewed proposal of feats and stories, then, on explicit authorization, materialize the docs, labels and tracking issues in one docs PR. |
| `dev-refine-story` | Create the issue for one `STY_<n>` story from its doc, then hand it to `dev-refine-issue`. |
| `dev-batch` | Run a batch of issues through refine, implement, review and squash merge as background sessions across accounts, with one ledger in the source issue or discussion. Merges only under the owner's authorization line. |

`dev-analyse-rp` and `dev-refine-story` follow the `ft-sty` work model: feats (`docs/feats/FT_<n>_<slug>.md`) and stories (`docs/stories/STY_<n>_<slug>.md`) are source-controlled, and each feat has a GitHub tracking issue with sub-issues and labels. Decisions go in `docs/adrs/`, designs in `docs/specs/`. Paths, labels and key formats are fixed to the `ft-sty` defaults; see [`references/work-model.md`](references/work-model.md).

Each skill reads the consuming repository's `AGENTS.md` / `CLAUDE.md` for project rules.

**Authority.** A user's explicit request for a skill authorizes the bounded writes that skill describes (comments, issue edits, commits on the PR branch). A skill the model picks on its own writes nothing without asking. `dev-review-pr` runs the writer and reviewer on different providers; a same-provider pair runs only when the owner chooses it.

## Setup

To install the plugin in Claude Code or Codex, see the [install guide](../../docs/install.md). The helper scripts need Node.js 20+ and one locked npm package. Claude Code installs it from the plugin's `package-lock.json` when the plugin is installed. Codex does not; run the `npm ci --prefix` step in the install guide's [Codex](../../docs/install.md#codex) section after installing or updating.

The skills also need `gh` (authenticated), and `dev-review-pr` needs the `claude` and/or `codex` CLI for the sessions it launches. `dev-merge` reads `dev-review-pr`'s review reports (or a formal approval) as its merge evidence; `dev-hooks`' `guard_pr_merge` still blocks merging a PR the signed-in account did not author.

## Check quoted evidence

To find several literal quotations in saved evidence, write a nonempty JSON array to `checks.json` in the run's private scratch directory.

```json
[
  {"file": "review.md", "literal": "Acceptance criteria"},
  {"file": "review.md", "literal": "Integration tests passed"}
]
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-text.mjs" --input "/path/to/run/checks.json"
```

Each `file` is a regular UTF-8 file beneath the directory containing the manifest. Use relative paths. The manifest and the entries below its directory must not be symlinks. Each `literal` is a nonempty, single-line string.

The helper returns one `{file, literal, lines}` object per request in a JSON array, preserving order and duplicates. `lines` lists every line that contains the quote, numbered from 1; a missing quote has `lines: []`. Exit 0 means every quote matched exactly one line. Exit 1 returns the full results when at least one quote is missing or ambiguous (on more than one line); lengthen an ambiguous quote until it is unique. Exit 2 indicates invalid input or a file error. For a quote that could appear in any of several snapshots, list each file explicitly and use the per-file matches.

## Test

```bash
npm ci && npm test
```
