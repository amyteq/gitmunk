# Accounts and usage

## Accounts

- **`accounts`** (`DEV_BATCH_ACCOUNTS`) lists Claude config directories: a JSON array of paths or of `{ "alias": "A1", "dir": "<config dir>" }` objects, or a comma-separated list of paths. They are shown as A1, A2, … in that order unless an entry names its alias. The default is the current `CLAUDE_CONFIG_DIR`, else `~/.claude`. The list is fixed at `init` and changes only through `config`.
- Only aliases reach GitHub; directories stay in the local state.
- **Validity** is `claude auth status --json` run with that `CLAUDE_CONFIG_DIR`, reading only `loggedIn`. `init` warns about an account that is not logged in, `handover` refuses one, and the loop checks before an account's first launch each hour.
- An account whose `claude agents --json --all` fails is **unreadable**. Its sessions show as unknown until it answers, nothing relaunches over them, and one `account-unreadable` event is logged.

## Usage snapshots

Each account's status line writes `<config dir>/dev-batch-usage.json` at every refresh:

```json
{ "at": 1763460000000, "five_hour": { "used_percentage": 42, "resets_at": 1763470800 }, "seven_day": { "used_percentage": 18, "resets_at": 1763900000 } }
```

`at` is in epoch milliseconds and `resets_at` in epoch seconds. A window missing from Claude Code's status-line input keeps its previous value. The status line prints the owner's previous status line first, if any, then `5h 42% · 7d 18%`.

Reading a snapshot: a window whose `resets_at` has passed counts as 0%. Otherwise the last value stands; usage can only have risen since, so it is a lower bound. An account with no snapshot is unknown.

## Account choice

Before each launch, skipping accounts that are logged out, unreadable or cooling:

1. the coordinator's own account, when its highest window is below `usage_cap`;
2. otherwise the known account with the lowest usage below `usage_cap`;
3. otherwise an unknown account, one session at a time until a snapshot appears;
4. otherwise no launch and one `accounts-at-cap` judgment. Later ticks try again, and launches resume once a capped window resets or a cooling ends.

Codex usage is not read in v1. A review blocked by a Codex limit surfaces as a judgment event.

## Usage limits

- A session whose job turns `blocked` with a usage-limit message in `claude logs` becomes `limited`. Its account cools until the reset time the message states, or for one hour, and a `limit` event is logged.
- A limited session resumes by itself after its reset. So the loop launches a replacement in another account under the next session name, continuing from the pushed branch, and then stops the limited session. The relaunch keeps the attempt number: a usage limit is not a failed attempt.
- The loop recognises a message by "hit your … limit" and reads the cooling end from "resets [<D>, ]<T> (<TZ>)". A message with no reset time, or with an unknown time zone, cools for one hour.

The shapes seen in real transcripts, normalized: `<T>` is a clock time such as `4:50pm` or `4pm`, `<TZ>` an IANA time zone, and `<D>` a month and day such as `Nov 20`.

- `You've hit your session limit · resets <T> (<TZ>)` (the most common)
- `You've hit your 5-hour limit · resets <T> (<TZ>)`
- `You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets <T> (<TZ>)`
- `You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your weekly limit resets <D>, <T> (<TZ>)`
- `You've hit your individual spend limit · … · your weekly limit resets <T> (<TZ>)`
- `You've hit your monthly spend limit. /model to switch models.` (no reset time, so one hour)

## Setup

The status line is a standalone script, [`scripts/statusline.mjs`](../scripts/statusline.mjs), with only `node:` imports. `setup` copies it into each config directory as `dev-batch-statusline.mjs`, because the plugin cache path changes with every plugin version.

`B setup` changes each chosen account's user `settings.json`:

- `statusLine` becomes `{ "type": "command", "command": "node \"<config dir>/dev-batch-statusline.mjs\"" }`. An existing status-line command is kept as `chain` in `<config dir>/dev-batch-statusline.json` and still runs, its output above the usage text.
- `env` gains the `DEV_BATCH_*` values the owner chose, given as `key=value` words.
- `cleanupPeriodDays` is raised to 365 when it is lower or unset, so transcripts survive for evaluation.

Without `--apply` it only lists the changes per account. With `--apply` it first copies `settings.json` to `settings.json.dev-batch-backup-<YYYYMMDDhhmmss>` beside it, then writes. It changes nothing already in place, so a second run lists no changes. A `settings.json` that is not a JSON object is refused with `unreadable-settings`; the owner fixes it by hand first.

To do it by hand for one account:

1. Copy `${CLAUDE_SKILL_DIR}/scripts/statusline.mjs` to `<config dir>/dev-batch-statusline.mjs`.
2. To keep an existing status line, write `{ "chain": "<its command>" }` to `<config dir>/dev-batch-statusline.json`.
3. In `<config dir>/settings.json`, set `"statusLine": { "type": "command", "command": "node \"<config dir>/dev-batch-statusline.mjs\"" }` and `"cleanupPeriodDays": 365`.
