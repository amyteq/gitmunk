# Install gitmunk

This guide covers installing, updating and removing the gitmunk plugins in Claude Code and Codex, and where the Ask workflows are set up. The README's [Install](../README.md#install) section keeps only the shortest commands.

gitmunk is one marketplace with two plugins: `dev-skills` (ten skills, for Claude Code and Codex) and `dev-hooks` (guardrail hooks, for Claude Code only). Both come from one of two channels: stable from the head of `main`, and beta from the head of `develop`.

## Installer

Run it with Node.js 20 or later. It changes nothing until you confirm:

```bash
npx --allow-git=root github:amyteq/gitmunk
```

npm 12 runs a package straight from a git repository only with `--allow-git=root`, and otherwise stops with `EALLOWGIT`; npm 11 accepts the flag too. Nothing is published to npm.

It asks three questions. Press Enter to take the default:

1. **Channel:** `stable` (default) or `beta`.
2. **Scope:** `user` (default), `project` or `local`, which says where Claude Code records the plugins; see [Scopes](#scopes).
3. **Agents:** `claude`, `codex` or both. The default is every one of the two CLIs it finds on `PATH`.

It then prints every command and settings change as a numbered plan, asks once (`[Y/n]`) and runs the steps in order. It stops at the first step that fails.

- It installs `dev-skills`. `dev-hooks` is opt-in through `--with-hooks`, for Claude Code only, because its hooks currently block the Claude Code phases of `dev-review-pr`.
- A beta install also sets the stable plugin ids to `false` at the same scope, as the beta template does, so no skill loads twice.
- Codex installs plugins per user, so the installer sets up Codex only at user scope; at project or local scope it prints a note and skips Codex. It also runs the `npm ci` step that Codex skips.
- A second run changes nothing.

For scripts and CI, `--yes` runs without questions and without the confirmation, using the flags and the defaults. `--dry-run` prints the plan and stops. Without `--yes`, the installer stops when stdin is not a terminal.

```bash
npx --allow-git=root github:amyteq/gitmunk --yes --channel beta --scope project --agents claude
```

That run's plan, as `--dry-run` prints it:

```text
gitmunk installer: channel beta, scope project, agents claude
Plan:
  1. claude plugin marketplace add https://raw.githubusercontent.com/amyteq/gitmunk/develop/channels/beta/.claude-plugin/marketplace.json --scope project
  2. claude plugin install dev-skills@gitmunk-beta --scope project
  3. set enabledPlugins["dev-skills@gitmunk"] to false in <project>/.claude/settings.json
```

For every flag, run `npx --allow-git=root github:amyteq/gitmunk --help`.

## Claude Code

### Scopes

| Scope | Settings file | Applies to |
| --- | --- | --- |
| `user` | `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set | You, in every project |
| `project` | `.claude/settings.json` in the repository | Everyone who works in the repository, once the file is committed |
| `local` | `.claude/settings.local.json` in the repository | Only you, in this repository; the file is meant to stay uncommitted |

Project settings win over user settings: a project that declares `gitmunk` itself uses its own entry, and cloud sessions, teammates and CI see only what the repository declares.

### Channels

Stable is the marketplace `gitmunk`, at the head of `main`. Beta is the marketplace `gitmunk-beta`, at the head of `develop`. The two need different names because Claude Code registers one source per marketplace name for the whole machine, so one name cannot serve `main` in your user settings and `develop` in a project. A beta install therefore sets the stable plugin ids, `dev-skills@gitmunk` and `dev-hooks@gitmunk`, to `false` at its scope, so a user-level stable install does not load the same skills twice. The README's [Channels](../README.md#channels) table lists the plugin ids of each.

### Templates

Instead of running commands, merge a template into a settings file:

- [`templates/claude/settings.json`](../templates/claude/settings.json) is stable: it declares `gitmunk` with `autoUpdate` on, enables `dev-skills@gitmunk` and `dev-hooks@gitmunk`, and adds a few `permissions.deny` rules. Merge it into the project's `.claude/settings.json` to share it with the team, or its `extraKnownMarketplaces` and `enabledPlugins` blocks into your user settings.
- [`templates/claude/settings.beta.json`](../templates/claude/settings.beta.json) is beta: it declares `gitmunk-beta` with `autoUpdate` on, enables the `@gitmunk-beta` plugins and sets both stable ids to `false`. Merge it into `.claude/settings.local.json` (only you) or `.claude/settings.json` (the whole team).

Teammates are prompted to trust a project's marketplace on first run. The stable template enables `dev-hooks`, while the installer installs it only with `--with-hooks`; drop the `dev-hooks` line if you do not want the hooks.

### Manual commands

Stable, at a scope `S` of `user`, `project` or `local` (`--scope` defaults to `user`):

```bash
claude plugin marketplace add amyteq/gitmunk#main --scope S
claude plugin install dev-skills@gitmunk --scope S
claude plugin install dev-hooks@gitmunk --scope S      # optional
```

Beta, at a scope `S`. The beta catalog sits at a path inside the repository, which the CLI cannot name, so it is added by its raw URL:

```bash
claude plugin marketplace add https://raw.githubusercontent.com/amyteq/gitmunk/develop/channels/beta/.claude-plugin/marketplace.json --scope S
claude plugin install dev-skills@gitmunk-beta --scope S
claude plugin install dev-hooks@gitmunk-beta --scope S      # optional
```

Then add the stable `false` lines to `enabledPlugins` in the settings file of `S` by hand, the `dev-hooks` one only if you installed `dev-hooks`:

```json
"enabledPlugins": {
  "dev-skills@gitmunk": false,
  "dev-hooks@gitmunk": false
}
```

`claude plugin disable dev-skills@gitmunk --scope S` cannot write these lines: when the stable plugin is not enabled at any scope, it exits with `already_in_goal_state` and writes nothing.

Skills keep their bare names, such as `/dev-review-pr`, unless another installed skill has the same name; see [Troubleshooting](#troubleshooting).

## Codex

Codex has no scope option: plugins install per user, under `$CODEX_HOME` (`~/.codex` by default). It uses one marketplace name, `gitmunk`, for both channels, and `--ref` picks the branch: `main` for stable, `develop` for beta.

```bash
codex plugin marketplace add amyteq/gitmunk --ref main      # beta: --ref develop
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

The `dev-skills` helpers need one locked npm package. Claude Code installs it from the plugin's `package-lock.json`, but Codex does not install plugin npm dependencies, so run `npm ci --prefix` for the installed folder; `<version>` is the version that `codex plugin list` shows. Run it again after every later `codex plugin add`, which copies the plugin again and deletes its `node_modules`.

To move to the other branch, remove the marketplace first, as in [Moving from beta to stable](#moving-from-beta-to-stable): adding it again with another `--ref` fails with "already added from a different source".

`dev-hooks` is for Claude Code only. Codex lists the skills with the plugin prefix, as `dev-skills:dev-review-pr`.

## Ask workflows

The Ask workflows are not a plugin: a repository copies a thin caller workflow from [`templates/github/`](../templates/github). Each agent stays off until its repository variable, `CLAUDE_ACTION_ENABLED` or `CODEX_ACTION_ENABLED`, is `true` and its secret is set: `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code, and `CODEX_AUTH_JSON` or `OPENAI_API_KEY` for Codex. The steps are in [Set up a repository](../scripts/github-agent/README.md#set-up-a-repository).

## Updating

An installed plugin updates only when its `version` in `.claude-plugin/plugin.json` changes. Every change on `develop` meant for users bumps the version, with no pre-release suffix: beta installs get it from `develop`, stable installs when a release brings it to `main`. See [CHANGELOG.md](../CHANGELOG.md) for what changed.

### Claude Code

Claude Code first refreshes the marketplace, then updates the plugins whose `version` changed.

- **At start-up:** a marketplace entry with `"autoUpdate": true`, as in both templates, is refreshed when Claude Code starts. `claude plugin marketplace add`, and so the installer, records the marketplace without `autoUpdate`; add `"autoUpdate": true` to its entry under `extraKnownMarketplaces` to get the same.
- **By hand,** then restart Claude Code:

  ```bash
  claude plugin marketplace update gitmunk                # or gitmunk-beta
  claude plugin update dev-skills@gitmunk --scope S       # or @gitmunk-beta
  ```

### Codex

```bash
codex plugin marketplace upgrade gitmunk
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

`upgrade` refreshes the catalog, and `codex plugin add` copies the plugin from it again. That deletes `node_modules`, so `npm ci` runs again, for the folder of the version `codex plugin list` now shows.

### Moving from beta to stable

When a beta becomes a release, `develop` is merged into `main`. A beta install can then move back to stable.

Claude Code, at the scope `S` that holds the beta:

```bash
claude plugin uninstall dev-skills@gitmunk-beta --scope S
claude plugin uninstall dev-hooks@gitmunk-beta --scope S      # if installed
claude plugin marketplace remove gitmunk-beta --scope S
```

Then delete the stable `false` lines from the settings file of `S` (see [Uninstalling](#uninstalling)), and install stable with the [manual commands](#manual-commands) unless a stable install at another scope already covers you. With templates, replace the beta template's entries with the stable template's.

Codex:

```bash
codex plugin marketplace remove gitmunk
codex plugin marketplace add amyteq/gitmunk --ref main
codex plugin add dev-skills@gitmunk
npm ci --prefix "${CODEX_HOME:-$HOME/.codex}/plugins/cache/gitmunk/dev-skills/<version>"
```

### Pinning

Each release since 0.3.0 is tagged `vX.Y.Z`. To stay on one release, put its tag where the branch goes: `claude plugin marketplace add amyteq/gitmunk#v0.3.0 --scope S`, or `codex plugin marketplace add amyteq/gitmunk --ref v0.3.0`. To pin a commit, use its full 40-character SHA; the README's [Versions](../README.md#versions) section shows which Claude Code versions accept a SHA there, the `git-subdir` form for older ones, and the form for the Ask workflow.

## Uninstalling

### Claude Code

At a scope `S`, uninstall each plugin, then remove its marketplace:

```bash
claude plugin uninstall dev-skills@gitmunk --scope S
claude plugin uninstall dev-hooks@gitmunk --scope S      # if installed
claude plugin marketplace remove gitmunk --scope S
```

For beta, use `@gitmunk-beta` and `gitmunk-beta`. Without `--scope`, `claude plugin marketplace remove` removes the marketplace from every scope.

`claude plugin uninstall` removes the plugin's own `enabledPlugins` line, but a beta install's stable `false` lines, `"dev-skills@gitmunk": false` and, with `dev-hooks`, `"dev-hooks@gitmunk": false`, stay in the settings file of that scope. Delete them by hand; while they stay, they also switch off a stable install from another scope in that project.

A project that merged a template removes the merged entries instead: `gitmunk` or `gitmunk-beta` under `extraKnownMarketplaces`, and the `@gitmunk` or `@gitmunk-beta` lines under `enabledPlugins`.

### Codex

```bash
codex plugin remove dev-skills@gitmunk
codex plugin marketplace remove gitmunk
```

`codex plugin remove` also deletes the plugin's cached folder, `node_modules` included.

## Fewer prompts

One account was measured for 48 hours: 183 Claude Code sessions in `auto` mode, with the Bash sandbox on. 299 tool calls stopped for a human answer, and three quarters of them were `dev-hooks` asks. Every one of those asks was approved, so they added friction and caught nothing (#61):

| Source of the prompt | Prompts |
| --- | --- |
| `dev-hooks`: "A substitution or variable decides what this command runs or reads" | 194 |
| `dev-hooks`: "File deletion outside /tmp or $TMPDIR", for a variable holding a temp path | 21 |
| `dev-hooks`: quoting it could not read, in long scripts | 7 |
| `dev-hooks`: a push with `git -c` | 1 |
| A user `ask` rule `Bash(rm *)`, mostly for `$TMPDIR` scratch | 38 |
| A user `ask` rule `Bash(gh release*)`, for read-only calls | 15 |
| A project `ask` rule for a paid run, half of them for a `grep` of its literal string | 19 |
| `EnterWorktree` outside `.claude/worktrees` | 2 |

User-level hooks that pointed at project files also failed 13,051 times in the same window.

`dev-hooks` 0.2.2 handles the first three rows itself. It reads each simple command on its own, resolves a variable assigned a literal earlier in the same command (`S=$TMPDIR/run; cat $S/a.log`), and skips the ask for read programs when the settings show that the call runs sandboxed. For the rest:

- **Keep `auto` mode.** It ran 98% of the measured calls without a prompt; the other modes prompt more, deny instead of asking, or drop the classifier.
- **Remove user-level hooks that point at project files.** A hook in `~/.claude/settings.json` that runs `"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.py` fails with exit 127 or 126 in every project without that file. Declare it in that project's `.claude/settings.json`, or ship it in a plugin.
- **Narrow broad `ask` rules.** `Bash(gh release*)` also stops `gh release list` and `gh release view`. Ask for the writes only: `Bash(gh release create *)`, `Bash(gh release delete *)`, `Bash(gh release upload *)` and `Bash(gh release edit *)`. A rule for a paid run should match the command that starts it, not every `grep` for its name.
- **Leave `rm` asks to the hook.** With `dev-hooks` installed, drop a `Bash(rm *)` ask rule. The hook asks before deletion outside `/tmp` and `$TMPDIR` and allows temp paths, also through a variable assigned one earlier in the same command.

### When the read skip applies

The hook input does not say whether a call runs sandboxed, so `dev-hooks` reads the settings files the hook can see: the user file (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`), the project's `.claude/settings.json` and `.claude/settings.local.json`, and the managed `managed-settings.json` and `managed-settings.d/*.json` in `/etc/claude-code` (Linux) or `/Library/Application Support/ClaudeCode` (macOS). It skips the substitution ask for `cat`, `head`, `grep` and the other read programs only when all of these hold, and asks as before otherwise:

- The platform is Linux or macOS, and the call does not set `dangerouslyDisableSandbox`.
- `HOME` and `CLAUDE_PROJECT_DIR` are absolute paths, and so is `CLAUDE_CONFIG_DIR` when it is set.
- Every settings file that exists is valid JSON with an object where the settings expect one.
- After precedence (managed over local over project over user, and the last `managed-settings.d` file over the earlier managed ones), `sandbox.enabled` and `sandbox.failIfUnavailable` are `true`, and neither `sandbox.filesystem.disabled` nor `sandbox.enableWeakerNestedSandbox` is `true`. A value that is not `true` or `false` counts against.
- No `sandbox.excludedCommands` entry starts with a program the call runs. An entry that starts with a wildcard counts as every program.
- Reads are denied for each of the 22 protected paths: `secrets`, `.ssh`, `.aws`, `.config/gcloud`, `.config/gh/hosts.yml`, `.netrc`, `id_rsa`, `id_ed25519`, `.env.production`, `.env.test` and `hosts.yml`, under the home directory and under the project directory. A `sandbox.filesystem.denyRead` entry, or a `sandbox.credentials.files` entry with `"mode": "deny"`, covers the path itself and everything beneath it. Only an absolute or `~/` entry without wildcards counts. An `allowRead` entry equal to a protected path, beneath it, or between it and its deny re-opens it, and an `allowRead` entry with a wildcard or a relative path turns the skip off.

For example, the home paths in `~/.claude/settings.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "filesystem": {
      "denyRead": ["~/secrets", "~/.ssh", "~/.aws", "~/.config/gcloud", "~/.config/gh/hosts.yml", "~/.netrc",
                   "~/id_rsa", "~/id_ed25519", "~/.env.production", "~/.env.test", "~/hosts.yml"]
    }
  }
}
```

and the project paths, which must be absolute, in the project's `.claude/settings.local.json`, since an absolute path belongs to one machine:

```json
{
  "sandbox": {
    "filesystem": {
      "denyRead": ["/path/to/project/secrets", "/path/to/project/.ssh", "/path/to/project/.aws",
                   "/path/to/project/.config/gcloud", "/path/to/project/.config/gh/hosts.yml",
                   "/path/to/project/.netrc", "/path/to/project/id_rsa", "/path/to/project/id_ed25519",
                   "/path/to/project/.env.production", "/path/to/project/.env.test", "/path/to/project/hosts.yml"]
    }
  }
}
```

The hook cannot see `--settings`, `--setting-sources`, server-managed settings or macOS managed preferences. If you start Claude Code with one of them, make sure it does not loosen what the files say. The [`dev-hooks` README](../plugins/dev-hooks/README.md#failure-policy) lists the rules that keep their checks with the skip on.

## Troubleshooting

**A skill's name clashes with another plugin's skill.** Claude Code shows a skill by its bare name, such as `/dev-review-pr`, unless another installed skill has the same name. Call it with the plugin prefix instead: `/dev-skills:dev-review-pr`. Codex always shows the prefix, as `dev-skills:dev-review-pr`.

**A marketplace under an old name is still there.** gitmunk was called `dev-lite` before 0.2.0. A leftover `dev-lite` or `dev-lite-beta` marketplace with its `*@dev-lite` plugins still enabled loads an old copy of the skills next to gitmunk's, so names clash. Remove it with `claude plugin marketplace remove dev-lite` (and `dev-lite-beta`), then delete the `*@dev-lite` and `*@dev-lite-beta` lines from `enabledPlugins` and the `dev-lite` and `dev-lite-beta` entries from `extraKnownMarketplaces`, as the [0.2.0 notes](../CHANGELOG.md#020) say. For Codex, run `codex plugin marketplace remove dev-lite` and add `gitmunk` as in [Codex](#codex).

**A `dev-skills` helper fails in Codex with a missing npm package,** such as `Cannot find package 'mdast-util-from-markdown'`. Codex did not install the helpers' npm package, or a later `codex plugin add` deleted it. Run the `npm ci --prefix` step from [Codex](#codex).

**npm refuses to run the installer with `EALLOWGIT`.** npm 12 runs a package from a git repository only when allowed. Add `--allow-git=root`: `npx --allow-git=root github:amyteq/gitmunk`.

**Codex refuses to add the marketplace: "already added from a different source".** The `gitmunk` marketplace is already there with another `--ref`. Run `codex plugin marketplace remove gitmunk` first, then add it again with the `--ref` you want.
