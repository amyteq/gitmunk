# 🐿️ gitmunk

[![CI](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml/badge.svg)](https://github.com/amyteq/gitmunk/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/amyteq/gitmunk?style=flat-square&label=release)](https://github.com/amyteq/gitmunk/releases)
[![MIT licence](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

A pocket-sized toolkit of agent skills, guardrail hooks and GitHub workflows for small teams that work with Claude Code and Codex. One marketplace, two plugins; install only what a project needs.

| Plugin | What it adds |
| --- | --- |
| [`dev-skills`](plugins/dev-skills) | Eight agent skills for GitHub work: refine issues into work orders, review and merge PRs, explain pending decisions, compact long threads, track discussion series, and plan features and stories. See [Skills](#skills). |
| [`dev-hooks`](plugins/dev-hooks) | Guardrail and audit hooks for Claude Code |

GitHub Actions: a reusable "Ask agent" workflow ([`.github/workflows/ask-agent.yml`](.github/workflows/ask-agent.yml)) lets Claude Code or Codex answer mentions in issues, PRs and discussions. Copy the thin callers from [`templates/github/`](templates/github).

## Quick start

1. Install the plugins as shown in [Install](#install).
2. In a checkout of a GitHub repository, with the GitHub CLI (`gh`) signed in, turn an issue into a work order:

   ```text
   /dev-refine-issue 42
   ```

   In Codex, call it as `$dev-refine-issue 42`. The skill reads the issue and the repository's `AGENTS.md`, then posts a task comment with acceptance criteria and copyable launch prompts. It does not implement the issue.

## How it works

- **One marketplace, two plugins.** This repository is a plugin marketplace ([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)) that lists `dev-skills` and `dev-hooks`. Claude Code and Codex install each plugin into their own plugin cache, so nothing is copied into your repository.
- **Skills** are instructions with small Node.js helpers. The agent loads one when you call it by name, reads your repository's `AGENTS.md` and `CLAUDE.md` for project rules, and makes only the writes the skill describes.
- **Hooks** (`dev-hooks`, Claude Code only) are Python scripts that run around tool calls. They deny or ask about destructive and secret-reading calls, block merging someone else's PR and log redacted events.
- **The Ask workflow** is a reusable GitHub Actions workflow that lets Claude Code or Codex answer `@claude` and `@codex` mentions in issues, PRs and discussions. A repository copies a thin caller from [`templates/github/`](templates/github), and each agent runs only when its repository variable is `true` and its secret is set.
- **Channels** are branches: stable comes from `main` and beta from `develop`, under two marketplace names. See [Versions](#versions).

## Skills

| Skill | What it does |
| --- | --- |
| [`dev-refine-issue`](plugins/dev-skills/skills/dev-refine-issue/SKILL.md) | Refines an existing issue into a bounded work order with observable acceptance criteria, a standalone task comment and copyable launch prompts. It never implements the issue. |
| [`dev-review-pr`](plugins/dev-skills/skills/dev-review-pr/SKILL.md) | Runs bounded PR review and fix rounds with independent Codex or Claude Code sessions, evidence-linked dispositions and a final full review before approval. |
| [`dev-merge`](plugins/dev-skills/skills/dev-merge/SKILL.md) | Squash merges one reviewed PR when the owner explicitly asks, verifies the merged tree, cleans up, posts a closeout and updates linked issues and trackers. It never merges on its own initiative. |
| [`dev-explain`](plugins/dev-skills/skills/dev-explain/SKILL.md) | Explains pending human decisions on one issue, PR or discussion, with background, examples, a recommendation and the options compared, then appends one result comment. It decides nothing. |
| [`dev-compact`](plugins/dev-skills/skills/dev-compact/SKILL.md) | Compacts one issue, PR or discussion by level: keeps the key points in the body, moves details verbatim into new comments and appends one result comment. AUTO regions and acceptance criteria stay byte-identical. |
| [`dev-track`](plugins/dev-skills/skills/dev-track/SKILL.md) | Collects every unprocessed discussion of one category, such as meeting notes, into that category's tracker discussion, merges their TODOs, marks each one done and closes it. It drafts by default and writes only with `--apply`. |
| [`dev-analyse-rp`](plugins/dev-skills/skills/dev-analyse-rp/SKILL.md) | Analyses one request pack (a local path, an issue or a discussion) into a planning-only proposal with a story map, delivery slices, candidate units, a dependency graph and an independent review. Only on explicit authorization does it open one PR of feat and story docs, with labels and tracking issues. |
| [`dev-refine-story`](plugins/dev-skills/skills/dev-refine-story/SKILL.md) | Resolves a `STY_<n>` story to exactly one GitHub issue, then hands off to `dev-refine-issue`. It never implements the story. |

## Install

Run the installer (Node.js 20 or later). It changes nothing until you confirm:

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 runs a package straight from a git repository only with `--allow-git=root`; npm 11 accepts the flag too.

It asks three questions, each with a default:

- **channel:** stable `gitmunk` at `main` (default), or beta `gitmunk-beta` at `develop`;
- **scope:** user (default), project or local, which says where Claude Code records the plugins;
- **agents:** Claude Code, Codex, or both; the default is every one it finds on `PATH`.

It then prints every command and settings change, asks once, and runs them.

- It installs `dev-skills`. `dev-hooks` is opt-in through `--with-hooks`, because its hooks currently block the Claude Code phases of `dev-review-pr`.
- A beta install also sets the stable plugin ids to `false` at the same scope, as the [beta template](templates/claude/settings.beta.json) does, so no skill loads twice.
- Codex installs plugins per user, so the installer sets up Codex only at user scope. It also runs the `npm ci` step that Codex skips.
- A second run changes nothing. To move Codex to the other channel, run `codex plugin marketplace remove gitmunk` first.

Flags: `--channel stable|beta`, `--scope user|project|local`, `--agents claude,codex`, `--with-hooks`, `--yes` (no questions: flags and defaults, for scripts and CI), `--dry-run` (print the plan only) and `--help`.

To install by hand instead, use the commands below.

### Claude Code

Per project (shared with the team): merge [`templates/claude/settings.json`](templates/claude/settings.json) into the project's `.claude/settings.json`. Teammates are prompted to trust the marketplace on first run.

Per user (every project on this machine): run the commands below, or merge the same `extraKnownMarketplaces` and `enabledPlugins` blocks into your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when you set that variable). Project settings win over user settings: a project that declares `gitmunk` itself uses its own entry, and cloud sessions, teammates and CI see only what the repository declares.

```bash
claude plugin marketplace add https://github.com/amyteq/gitmunk.git#main
claude plugin install dev-skills@gitmunk
claude plugin install dev-hooks@gitmunk
```

Skills keep their bare names (`/dev-review-pr`) unless another installed skill has the same name; then use `/dev-skills:dev-review-pr`.

### Codex

```bash
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
```

Codex lists plugin skills as `dev-skills:dev-review-pr`. Codex does not install plugin npm dependencies: run `npm ci --prefix "<installed plugin folder>"` once for `dev-skills` (Claude Code does this automatically).

## Versions

Channels are branches: `main` is stable and `develop` is beta. Each plugin's `version` in `.claude-plugin/plugin.json` must change for installed copies to update. See [CHANGELOG.md](CHANGELOG.md).

### Channels

| Channel | Marketplace | Ref | Plugin ids | Template |
| --- | --- | --- | --- | --- |
| Stable (default) | `gitmunk` | the head of `main` | `dev-skills@gitmunk`, `dev-hooks@gitmunk` | [`templates/claude/settings.json`](templates/claude/settings.json) |
| Beta | `gitmunk-beta` ([catalog](channels/beta/.claude-plugin/marketplace.json)) | the head of `develop`, versions like `0.3.0-beta.1` | `dev-skills@gitmunk-beta`, `dev-hooks@gitmunk-beta` | [`templates/claude/settings.beta.json`](templates/claude/settings.beta.json) |

A project opts into beta by merging the beta template into its `.claude/settings.local.json` (only you) or `.claude/settings.json` (the whole team). The two marketplaces have different names because Claude Code registers one source per marketplace name for the whole machine; the beta template also sets the stable plugins to `false`, so a user-level stable install does not load the same skills twice in that project. Codex has no second channel: point the project's `[marketplaces.gitmunk]` `ref` in `.codex/config.toml` at `develop` instead of `main`. When a beta becomes a release, its plugins' versions drop the `-beta.N` suffix, `develop` is merged into `main`, and beta projects can drop the beta template. The [release workflow](.github/workflows/release.yml) fails a PR into `main` unless the top `CHANGELOG.md` section is a plain `## X.Y.Z`, no version carries a pre-release suffix and `vX.Y.Z` is not tagged yet; the merge then tags `vX.Y.Z` and publishes a GitHub release with that section as its notes.

To pin a commit, use the full 40-character SHA where each tool accepts one:

- **Claude Code** before v2.1.324 reads the `#…` suffix of a marketplace URL, and a marketplace `ref`, as a branch or tag only; a SHA there fails as a missing branch (v2.1.324 and later also accept a full SHA as a marketplace `ref`). To support older versions, pin each plugin instead, in a marketplace of your own (for example a project `.claude-plugin/marketplace.json`), with a `git-subdir` source and its `sha`:

  ```json
  { "name": "dev-skills", "source": { "source": "git-subdir", "url": "https://github.com/amyteq/gitmunk.git", "path": "plugins/dev-skills", "sha": "<full commit SHA>" } }
  ```

- **Codex** accepts a SHA as the marketplace ref: `codex plugin marketplace add amyteq/gitmunk --ref <full commit SHA>`.
- **The Ask workflow** accepts a SHA after `@` in the caller's `uses:`.

## FAQ

**Why are there two marketplace names?** Claude Code registers one source per marketplace name for the whole machine, so one name cannot serve `main` in your user settings and `develop` in a project. Stable is `gitmunk` (from `main`) and beta is `gitmunk-beta` (from `develop`). See [Channels](#channels).

**A skill's name clashes with another plugin's skill. How do I call it?** Add the plugin prefix: `/dev-skills:dev-review-pr` in Claude Code. Codex always lists plugin skills with the prefix, as `dev-skills:dev-review-pr`.

**Why does Codex need `npm ci --prefix`?** The `dev-skills` helper scripts need one locked npm package. Claude Code installs it from the plugin's `package-lock.json`, but Codex does not install plugin npm dependencies, so run `npm ci --prefix "<installed plugin folder>"` once after installing or updating.

**How do I pin a version?** Use a full 40-character commit SHA where each tool accepts one; [Versions](#versions) shows the form for Claude Code, Codex and the Ask workflow. Each release is also tagged `vX.Y.Z`.

**Are the Ask workflows on by default?** No. Since 0.3.0 an agent runs only when its repository variable (`CLAUDE_ACTION_ENABLED` or `CODEX_ACTION_ENABLED`) is `true` and its secret reaches the workflow; otherwise the run stops at routing with the reason in the log. See [setting up a repository](scripts/github-agent/README.md#set-up-a-repository).

## Numbers

> **Placeholder:** no measurements yet. This section will show results from runs with and without the skills once there are some.

## Before / after

> **Placeholder:** no worked example yet. This section will show one task done with and without a skill.

## Built with gitmunk

> **Placeholder:** no public projects are listed yet. Projects that use gitmunk and want to be named will be added here.

## Documentation

| Document | What it covers |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | Changes in each release, with migration notes |
| [AGENTS.md](AGENTS.md) | Rules for working in this repository |
| [`dev-skills`](plugins/dev-skills/README.md) | The eight skills, their authority and their setup |
| [Work model](plugins/dev-skills/references/work-model.md) | The `ft-sty` feat and story model that `dev-analyse-rp` and `dev-refine-story` follow |
| [`dev-hooks`](plugins/dev-hooks/README.md) | Each hook, what it denies or asks about, and its failure policy |
| [Ask agent](scripts/github-agent/README.md) | Setting up the Ask workflow in a repository |
| [`templates/claude/`](templates/claude) | Settings templates for the stable and beta channels |
| [`templates/github/`](templates/github) | The Ask caller workflows |

An install guide (`docs/install.md`) is planned for after the `npx` installer. Until then, see [Install](#install).

## Develop

```bash
node scripts/sync-shared.mjs            # copy shared/ helpers into each plugin
node scripts/sync-shared.mjs --check    # CI: fail on drift
(cd plugins/dev-skills && npm ci && npm test)
python3 -m unittest discover -s plugins/dev-hooks/tests
python3 -m unittest discover -s scripts/github-agent/tests
python3 -m unittest discover -s scripts/release/tests
```

Edit shared helpers in `shared/` only; plugins carry synced copies because each plugin is installed as its own cache.

## Contributing

Changes land on `develop`, the beta channel; `main` receives only releases from `develop`. Work on a task branch and open a focused PR into `develop`. Follow the rules in [AGENTS.md](AGENTS.md): public content only, shared helpers edited in `shared/` only, and a plugin change that consumers should receive bumps that plugin's version as `X.Y.Z-beta.N` with a `CHANGELOG.md` entry. Run the checks in [Develop](#develop) before you push.

## Sponsors

Sponsorship goes through GitHub Sponsors for the `amyteq` organisation, which [`.github/FUNDING.yml`](.github/FUNDING.yml) names. The repository's Sponsor button works once the organisation's Sponsors profile is approved; until then it leads nowhere.

## Star history

<a href="https://www.star-history.com/?repos=amyteq%2Fgitmunk&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
    <img alt="gitmunk star history" src="https://api.star-history.com/chart?repos=amyteq/gitmunk&amp;type=date" />
  </picture>
</a>

## License

[MIT](LICENSE)
