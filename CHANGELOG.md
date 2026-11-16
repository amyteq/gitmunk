# Changelog

## Unreleased

- README (#32): a badge row, Quick start, How it works, a Skills table, FAQ, Documentation, Contributing, Sponsors, Star history and License sections. Numbers, Before / after and Built with gitmunk are marked placeholders until there are facts to show. The Install section is unchanged.
- 🐿️ starts every plugin description, in both plugin manifests and in both marketplace catalogs.
- `.github/FUNDING.yml` names the `amyteq` organisation on GitHub Sponsors. The Sponsor button works once that profile is approved.
- Installer (#33): `npx --allow-git=root github:amyteq/gitmunk` asks for the channel (stable or beta), the scope (user, project or local) and the agents (Claude Code, Codex), prints every step, asks once, and then runs the `claude plugin` and `codex plugin` commands.
  - For Codex it also runs the `npm ci` step that Codex skips.
  - A beta install sets the stable plugin ids to `false` at the same scope. `dev-hooks` is installed only with `--with-hooks`.
  - `--yes` runs without questions and `--dry-run` only prints the plan; a second run changes nothing.
  - It is a dependency-free `bin` in a root `package.json`; nothing is published to npm. npm 12 needs `--allow-git=root` to run a package from git.
- Install guide (#36): [`docs/install.md`](docs/install.md) explains the installer, Claude Code scopes, channels and templates, Codex with its `npm ci` step, where the Ask workflows are set up, updating, moving from beta to stable, pinning, uninstalling and troubleshooting. The README's Install section now keeps only the installer one-liner and the shortest manual commands, and the `dev-skills` and Ask agent READMEs link to the guide. Plugins unchanged.
- `dev-skills` 0.2.1-beta.1 and `dev-hooks` 0.2.1-beta.1: only the description changes, so installed copies show the new one.

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
