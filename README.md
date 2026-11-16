# 🐿️ gitmunk

A pocket-sized toolkit of agent skills, guardrail hooks and GitHub workflows for small teams that work with Claude Code and Codex. One marketplace, two plugins; install only what a project needs.

| Plugin | What it adds |
| --- | --- |
| [`dev-skills`](plugins/dev-skills) | `dev-review-pr` (bounded review/fix rounds with independent sessions), `dev-refine-issue` (issue → bounded work order), `dev-explain` (explain pending decisions), `dev-compact` (compress an issue, PR or discussion thread), `dev-merge` (squash merge a reviewed PR and close it out), `dev-track` (register a discussion series such as meeting notes in its tracker), `dev-analyse-rp` and `dev-refine-story` (feature/story planning with `FT_`/`STY_` docs, tracking issues and labels) |
| [`dev-hooks`](plugins/dev-hooks) | Guardrail and audit hooks for Claude Code |

GitHub Actions: a reusable "Ask agent" workflow ([`.github/workflows/ask-agent.yml`](.github/workflows/ask-agent.yml)) lets Claude Code or Codex answer mentions in issues, PRs and discussions. Copy the thin callers from [`templates/github/`](templates/github).

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
