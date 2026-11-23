# Changelog

## Unreleased

- `dev-skills` 0.3.2: `dev-refine-issue`'s `/goal` completion condition names only the acceptance criteria shown offline at the PR head (#57). For a task delivered as a PR, each criterion now ends its first line with `Shown at: PR head.`, `Shown at: review.` or `Shown at: owner.`. A criterion shown by the review or by the owner is listed after `Handed on, not goal conditions:` with its stage, because the implement session cannot meet it. A named owner gate or another blocker ends the goal once its question is posted on the issue, and the session then ends without waiting; a cancellation or budget stop ends it without a question. The plain-language prompt is the `/goal` line without `/goal `. The `/goal` line stays one line in the same place, so `dev-batch` reads and launches it as before. Tasks not delivered as a PR keep the earlier completion condition, and task comments already published are not rewritten. Two fixtures and their tests cover both cases.
- `dev-skills` 0.3.1: `dev-review-pr` Codex phases work with Codex's standalone installer (#23). That installer puts `codex` inside its login directory (`~/.codex/packages/standalone/releases/<release>/bin/codex`), where the bounded worker mounted nothing, so every command failed and the phase was still recorded `completed`. When the first `codex` on `PATH` resolves to exactly that layout, the helper now mounts that one release directory read-only and starts every Codex call with the resolved binary. The rest of the login directory, its credentials, sessions and configuration included, stays unmounted. Before every Codex phase the helper also runs `codex sandbox` with `true` under the phase's permission profile, and refuses the phase with a `bounded-tools` blocker naming the cause unless it exits 0. A probe timeout ends the phase as `timeout`. A `codex` anywhere else inside the login directory is refused there, and the helper never falls back to Codex's built-in read-only sandbox.
- `dev-batch` skill (#44, #45): runs a batch of issues through refine, implement, review and squash merge as background sessions across accounts, with one ledger in the source issue or discussion and merges only under the owner's authorization line. A free slot goes to the issue with the highest priority label (`P0`, `priority:high` and similar; none ranks as P2), then the lowest Batch, then row order. `dev-skills` 0.3.0 (ten skills). The translations in `i18n/` follow in their own update.
- `dev-skills` 0.2.4: `dev-track` links each processed discussion back to its tracker (#48). Under the invisible done mark, `H body` adds one visible line, `> 📋 Registered in tracker [#N · <tracker title>](<tracker URL>)`, or `已登记到台账` for a Chinese discussion, in both the default and `meetings` playbooks. It is skipped when the part of the body that stays visible already has a `>` line linking the tracker URL, so a hand-made back-ref is not doubled. The tracker title and URL come from `locate.json` as files (`--tracker-title @…`, `--tracker-url @…`). A URL other than `https://<host>/<owner>/<repo>/discussions/N` is refused, and `[`, `]` and `\` in the title are escaped. Discussions processed earlier keep their bodies, because a `redo` still never rewrites one.
- `dev-skills` 0.2.3: `dev-track`'s `meetings` digest gives every TODO row a permanent ID, `D<discussion>-T<k>` (#47). The `ID` column comes first in the English and the Chinese TODO table, also with one row, and `k` counts from 1 in row order. A redraft keeps every published ID, a new row takes the next `k`, and a number is never reused or renumbered. A tracker item's source link names its row (`[MM-DD D39-T2](meeting link)`), one link per row, so a digest row leads to its item through the Tracker column and an item back to its rows. Earlier digests and source links stay as they are, and a `redo` still never changes a body.

## 0.5.1

- `dev-skills` 0.2.2 (released from 0.2.2-beta.1): new `dev-interview` (#50). It collects the owner's pending decisions (`type=OD|SD|ALL`) on one issue, PR or discussion, and with `linked` on its open sub-issues and the threads its body links, then asks them in rounds of up to four popups. The recommended option comes first. After each round, before the next, it records every answer where its item sits: the item's status mark and a row in one decisions block of that body or comment, or a reply when the place cannot be edited. Free-text answers are kept verbatim, partial answers stay partly open, and requested work is listed as a follow-up, never done. `DEV_INTERVIEW_ASK_LANG` sets the popup language (default: the session's language) and `DEV_INTERVIEW_NOTE_LANG` the language written back (default: each source's language); both fall back to `zh-CN`. `dry-run` prints the plan only.
- `dev-merge`'s guarded `edit` also writes discussion bodies and comments, and `dev-explain`'s argument parsing is shared with `dev-interview`. Neither skill's behaviour changes.

## 0.5.0

- Ask workflow reactions (#41): once a mention is authorized, a new `react` job adds a reaction to the triggering comment, issue, pull request or discussion, 🚀 `rocket` for Claude and 👀 `eyes` for Codex, as the retired pipeline did. `CLAUDE_ACTION_REACTION` / `CODEX_ACTION_REACTION` choose another of GitHub's reactions (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`); any other value warns and keeps the default. The job has `issues`, `pull-requests` and `discussions` write, which the caller templates already grant; it never delays or fails the agent run. Plugins unchanged.

## 0.4.0

- README (#32): a badge row, Quick start, How it works, a Skills table, FAQ, Documentation, Contributing, Sponsors, Star history and License sections. Numbers, Before / after and Built with gitmunk are marked placeholders until there are facts to show. The Install section is unchanged.
- 🐿️ starts every plugin description, in both plugin manifests and in both marketplace catalogs.
- `.github/FUNDING.yml` names the `amyteq` organisation on GitHub Sponsors. The Sponsor button works once that profile is approved.
- Installer (#33): `npx --allow-git=root github:amyteq/gitmunk` asks for the channel (stable or beta), the scope (user, project or local) and the agents (Claude Code, Codex), prints every step, asks once, and then runs the `claude plugin` and `codex plugin` commands.
  - For Codex it also runs the `npm ci` step that Codex skips.
  - A beta install sets the stable plugin ids to `false` at the same scope. `dev-hooks` is installed only with `--with-hooks`.
  - `--yes` runs without questions and `--dry-run` only prints the plan; a second run changes nothing.
  - It is a dependency-free `bin` in a root `package.json`; nothing is published to npm. npm 12 needs `--allow-git=root` to run a package from git.
- Install guide (#36): [`docs/install.md`](docs/install.md) explains the installer, Claude Code scopes, channels and templates, Codex with its `npm ci` step, where the Ask workflows are set up, updating, moving from beta to stable, pinning, uninstalling and troubleshooting. The README's Install section now keeps only the installer one-liner and the shortest manual commands, and the `dev-skills` and Ask agent READMEs link to the guide. Plugins unchanged.
- README translations (#37): [`i18n/`](i18n) holds the README in 简体中文, 日本語, 한국어, Español, Français, العربية and Русский, and a language bar under the title of all eight pages links them. Each translation names the English README commit it was translated from, so drift shows; the Arabic page reads right to left. Plugins unchanged.
- `dev-skills` 0.2.1 and `dev-hooks` 0.2.1: only the description changes, so installed copies show the new one.

## 0.3.0

Breaking for private repositories that relied on the unset default: the Ask workflows now start an agent only when its variable `CLAUDE_ACTION_ENABLED` / `CODEX_ACTION_ENABLED` is `true` and its secret reaches the workflow. Set the variable to keep an agent answering.

- Ask workflows are off by default in every repository (#26). An unset variable no longer means on in private repositories, and a run whose agent has no `CLAUDE_CODE_OAUTH_TOKEN` (Claude) or no `CODEX_AUTH_JSON` or `OPENAI_API_KEY` (Codex) stops at routing with the reason in the log, before any model job. A switched-off agent, including a variable that is empty or only whitespace, skips cleanly without rendering or checking any variable.
- This repository ignores `.claude/worktrees/`, where agent sessions keep their worktrees.
- Release workflow (#28): a PR into `main` fails its check unless the top `CHANGELOG.md` section is a plain `## X.Y.Z`, no plugin, package or marketplace version carries a pre-release suffix such as `-beta.N`, and the tag `vX.Y.Z` does not exist yet. Each push to `main` then creates the tag `vX.Y.Z` and a GitHub release with that section as its notes; a push whose tag exists changes nothing.
- Plugins unchanged: `dev-skills` 0.2.0 and `dev-hooks` 0.2.0, so installed copies stay as they are.

## 0.2.0

Breaking: the repository is renamed to `gitmunk` and every plugin id changes. Replace `dev-skills@dev-lite`, `dev-planning@dev-lite` and `dev-hooks@dev-lite` with `dev-skills@gitmunk` and `dev-hooks@gitmunk`. To migrate, either merge the updated [`templates/claude/settings.json`](templates/claude/settings.json) into the settings file that enabled `dev-lite`, or run all three commands in the README's [Claude Code install](README.md#claude-code) section (`marketplace add` alone enables no plugin). Then, in the settings file that enabled `dev-lite`, delete the three `*@dev-lite` keys from `enabledPlugins` (or set them to `false`) and the `dev-lite` key from `extraKnownMarketplaces`, so only `dev-skills@gitmunk` and `dev-hooks@gitmunk` stay enabled.

- Renamed `dev-lite` to 🐿️ `gitmunk` (#19): the marketplace is `gitmunk`, the beta marketplace `gitmunk-beta`, and every URL, template and Ask caller points at `amyteq/gitmunk`.
- Channels are branches: stable is the head of `main` and beta the head of `develop`. The settings template, the Ask callers (`ask-agent.yml@main`) and the install commands reference `main`; the `v0` tag they named was never created.
- `dev-planning` is merged into `dev-skills`: `dev-analyse-rp`, `dev-refine-story` and the work-model reference now ship in `dev-skills`, which has all eight skills.
- This repository no longer installs its own plugins at project level.
- `dev-skills` 0.2.0 (released from 0.2.0-beta.1):
  - New `dev-merge`: squash merge one reviewed PR on the owner's explicit request, verify the merged tree, clean up, post a closeout in the PR body's language and update linked issues and trackers (#15). The PR's base branch replaces a hard-coded `main`. A saved cleanup plan runs only in the repository and Git storage it was made for; the closing-keyword lint covers the squash subject and full issue URLs; moved-base verification runs the checks the repository's `AGENTS.md` requires. A whole-section tracker replacement carries the section text it was drafted from and stops for redrafting when that section changed, so concurrent edits survive.
  - New `dev-track`: register every unprocessed discussion of one category (the `meetings` playbook digests meeting notes in place and merges their TODOs) in that category's tracker discussion. It replaces the planned `dev-meeting-notes` (#16). Its helper, including the bounded `.docx`/`.pptx` text reader for meeting attachments, is Node only: no skill needs `python3`. The helper also downloads meeting attachments, reading `gh auth token` itself so the token never appears in a command line or log.
  - `dev-review-pr`: published reports follow the PR body's language with the `Base:`, `Reviewed head:` and `Verdict:` labels kept in English for `dev-merge`; selecting the skill grants no write permission.
- Beta channel: the `gitmunk-beta` marketplace (`channels/beta/`) serves the plugins from the head of `develop`; projects opt in with `templates/claude/settings.beta.json`.
- `dev-hooks` 0.2.0: renamed links and hook description only.

## 0.1.0

- Marketplace `dev-lite` with plugins `dev-skills`, `dev-planning` and `dev-hooks`.
- Reusable `ask-agent.yml` workflow with caller templates for Claude Code and Codex.
- Consumer template for `.claude/settings.json`.
