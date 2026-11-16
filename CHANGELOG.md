# Changelog

## 0.2.0

Breaking: the repository is renamed to `gitmunk` and every plugin id changes. Replace `dev-skills@dev-lite`, `dev-planning@dev-lite` and `dev-hooks@dev-lite` with `dev-skills@gitmunk` and `dev-hooks@gitmunk`, using the updated [`templates/claude/settings.json`](templates/claude/settings.json), or `claude plugin marketplace add https://github.com/amyteq/gitmunk.git#main`.

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
