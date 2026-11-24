import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Launches one dev-review-pr phase on an explicitly selected route and writes its phase record.
// Exit 0: the phase completed and its observed profile matches the request. Exit 1: refused,
// blocked, timed out or failed, and the record says which. Exit 2: the helper did not run.

const PROBE_SECONDS = 60;
// A role session is a fresh host process, not part of the coordinator's Claude Code or Codex session, so it receives no
// variable of either. A Claude child keeps the ones that locate its login or select the provider its CLI is configured for.
const SESSION_VARIABLE = /^(?:CLAUDE|CODEX_COMPANION_)/;
// shortcut: keeps only login and CLAUDE_CODE_USE_* provider switches; widen it when another env-configured route needs more.
const CLAUDE_ROUTE = /^(?:CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z0-9_]+)$/;
const GRACE_MS = 2000;
const STREAM_LIMIT = 4 << 20;
// A detached group survives its launcher, so a signal to the helper stops every group still live.
const groups = new Set();
// An expired subprocess answers nothing, so its phase ends as a timeout instead of continuing from a missing answer.
const timeouts = [];
const killGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch { /* the group has already gone */ } };
const stopGroups = (signal) => { for (const pid of groups) killGroup(pid, 'SIGKILL'); process.exit(signal === 'SIGINT' ? 130 : 143); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopGroups);

const ROUTES = {
  codex: { cli: 'codex' },
  claude: { cli: 'claude' },
};
const PHASES = { reviewer: ['review', 'closing-review', 'final-review'], writer: ['writer', 'closing-writer'] };
const QUOTE_HANDOFF = 'For line-number checks on known quotes in saved evidence, return candidates for the coordinator to verify with check-text.mjs. '
  + 'In the relevant finding or disposition, give the snapshot-relative file and an exact single-line literal that occurs on only one line of it. '
  + 'Skip inline lookup loops and leave the manifest to the coordinator. Pass this rule to any reader already authorized to supply evidence. Do not start subagents.';

// Hands each stdout line to onLine as it arrives, so the capture cap never hides a later event. A line longer than the cap
// is not kept and arrives as null.
function lineReader(onLine) {
  let parts = [];
  let size = 0;
  const add = (piece) => { size += piece.length; if (size <= STREAM_LIMIT) parts.push(piece); };
  const emit = () => { onLine(size > STREAM_LIMIT ? null : Buffer.concat(parts).toString('utf8')); parts = []; size = 0; };
  return {
    write(chunk) {
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; start = end + 1, end = chunk.indexOf(10, start)) { add(chunk.subarray(start, end)); emit(); }
      add(chunk.subarray(start));
    },
    end() { if (size) emit(); },
  };
}

// Every probe and phase runs as its own process group, so a timeout, or the end of the phase,
// stops the whole tree, including children that outlive their parent.
function runBounded(command, args, { cwd, env, promptPath, timeoutSeconds, label, onLine }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;
    const lines = onLine && lineReader(onLine);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [promptPath ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    groups.add(child.pid);
    const signalGroup = (signal) => killGroup(child.pid, signal);
    const finish = (fields) => {
      if (settled) return;
      settled = true;
      lines?.end();
      clearTimeout(timer); groups.delete(child.pid);
      if (timedOut) timeouts.push(`${label} timed out after ${Math.round((Date.now() - started) / 1000)}s`);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        timedOut, elapsedMs: Date.now() - started, ...fields });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => {
        signalGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, GRACE_MS).unref();
    }, timeoutSeconds * 1000);
    // Each stream is capped, so a flooding or malfunctioning CLI cannot exhaust the helper before its timeout.
    const capture = (sink) => { let size = 0; return (chunk) => { if (size > STREAM_LIMIT) return; size += chunk.length;
      sink.push(size <= STREAM_LIMIT ? chunk : Buffer.concat([chunk.subarray(0, STREAM_LIMIT + chunk.length - size), Buffer.from('\n[stream truncated]\n')])); }; };
    const keep = capture(out);
    child.stdout.on('data', (chunk) => { lines?.write(chunk); keep(chunk); });
    child.stderr.on('data', capture(err));
    child.on('error', (error) => finish({ code: null, signal: null, spawnError: error.code ?? error.message }));
    child.on('exit', () => signalGroup('SIGKILL'));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (promptPath) {
      child.stdin.on('error', () => {});
      const prompt = createReadStream(promptPath);
      prompt.on('error', () => child.stdin.end());
      prompt.on('end', () => child.stdin.end(`\n\n${QUOTE_HANDOFF}\n`));
      prompt.pipe(child.stdin, { end: false });
    }
  });
}

const git = async (worktree, args, timeoutSeconds) => {
  const result = await runBounded('git', ['-C', worktree, ...args], { env: process.env, timeoutSeconds, label: `git ${args[0]}` });
  return result.code === 0 ? result.stdout.trim() : null; };

// ---- The bounded worker: every model-directed read, edit and command runs apart from the logged-in CLI. ----

export const BOUNDED_SHELL = fileURLToPath(new URL('./bounded-shell.sh', import.meta.url));
const real = (path) => { try { return realpathSync(path); } catch { return null; } };
const covers = (outer, inner) => outer === inner || inner.startsWith(`${outer}/`);

// Read-only toolchain mounts: each absolute PATH directory and, for a `bin` directory deeper than a home subdirectory such
// as ~/.local, its installation prefix. A directory that is or holds the home directory or a CLI login is never mounted.
export function toolchainDirs(path, env) {
  const home = real(env.HOME || homedir());
  const logins = [real(env.CODEX_HOME || join(home ?? '/', '.codex')), real(env.CLAUDE_CONFIG_DIR || join(home ?? '/', '.claude'))].filter(Boolean);
  const dirs = new Set();
  for (const dir of path.split(':').filter(isAbsolute).map(real)) {
    if (!dir || !statSync(dir).isDirectory()) continue;
    const shallow = home && [dirname(dir), dirname(dirname(dir))].includes(home);
    for (const candidate of basename(dir) === 'bin' && !shallow ? [dir, dirname(dir)] : [dir]) {
      if (candidate !== '/' && ![home, ...logins].some((guarded) => guarded && covers(candidate, guarded))
        && !logins.some((login) => covers(login, candidate))) dirs.add(candidate);
    }
  }
  return [...dirs];
}

// The first executable `codex` on PATH after symlinks, and its release directory when it sits where Codex's standalone
// installer puts it, inside the login directory. Codex's sandbox runs its own binary again for every command, so that one
// directory is mounted read-only; only this exact layout qualifies, so no other part of the login is ever exposed.
// As in toolchainDirs, relative and empty PATH components are skipped: they resolve against a working directory that may
// hold PR content, so they never select the CLI that runs outside the worker.
export function resolveCodex(path, env) {
  const exe = path.split(':').filter(isAbsolute).map((dir) => real(join(dir, 'codex')))
    .find((file) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } }) ?? null;
  const login = real(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'));
  const release = exe && dirname(dirname(exe));
  return { exe, release: login && exe?.endsWith('/bin/codex') && dirname(release) === join(login, 'packages/standalone/releases') ? release : null };
}

// The worktree's `.git` entry locates the repository every later Git command trusts, so a phase may not change it.
const gitLink = (worktree) => { const path = join(worktree, '.git');
  try { return lstatSync(path).isFile() ? readFileSync(path, 'utf8') : lstatSync(path).isDirectory() ? 'directory' : 'other'; } catch { return 'missing'; } };

const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const toml = (value) => (isTable(value) ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(', ')}}`
  : JSON.stringify(value));

// Reads the TOML that config.toml holds into null-prototype tables: tables and arrays of tables, dotted and quoted keys,
// strings, numbers, booleans, arrays and inline tables, across lines and comments. A multi-line string or any other value
// kept only as text reads as null and is never passed on; anything unreadable throws, so the phase refuses, not guesses.
export function readToml(text) {
  let at = 0;
  const fail = () => { throw new Error(`unreadable TOML at offset ${at}`); };
  const eat = (pattern) => { pattern.lastIndex = at; const match = pattern.exec(text); if (match) at = pattern.lastIndex; return match; };
  const must = (pattern) => eat(pattern) ?? fail();
  const gap = () => eat(/(?:[ \t\r\n]|#[^\n]*)*/y);
  const space = () => eat(/[ \t]*/y);
  const table = () => Object.create(null);
  const string = () => {
    if (eat(/"""(?:[^"\\]|\\[\s\S]|"(?!""))*"""|'''[\s\S]*?'''/y)) return null;
    const basic = eat(/"((?:[^"\\\n]|\\.)*)"/y);
    if (basic) { try { return JSON.parse(`"${basic[1].replace(/\t/g, '\\t')}"`); } catch { return fail(); } }
    return eat(/'([^'\n]*)'/y)?.[1];
  };
  const key = () => { const parts = []; do {
    space(); let part = string(); if (part === undefined) part = eat(/[A-Za-z0-9_-]+/y)?.[0];
    parts.push(typeof part === 'string' ? part : fail()); space(); } while (eat(/\./y)); return parts; };
  const walk = (from, path) => path.reduce((node, part) => {
    if (!Object.hasOwn(node, part)) node[part] = table();
    const next = Array.isArray(node[part]) ? node[part].at(-1) : node[part];
    return isTable(next) ? next : fail(); }, from);
  const assign = (target, path) => { must(/=/y); space(); walk(target, path.slice(0, -1))[path.at(-1)] = value(); };
  const sequence = (close, item) => { for (;;) { gap(); if (eat(close)) return; item(); gap(); if (!eat(/,/y)) { gap(); must(close); return; } } };
  const value = () => {
    const quoted = string();
    if (quoted !== undefined) return quoted;
    if (eat(/\[/y)) { const list = []; sequence(/\]/y, () => list.push(value())); return list; }
    if (eat(/\{/y)) { const inline = table(); sequence(/\}/y, () => assign(inline, key())); return inline; }
    const word = must(/[^\s,\]}#"']+/y)[0];
    return word === 'true' || word === 'false' ? word === 'true'
      : /^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/.test(word) ? Number(word.replace(/_/g, '')) : null;
  };
  const root = table();
  let current = root;
  for (;;) {
    gap();
    if (at >= text.length) return root;
    if (eat(/\[\[/y)) {
      const path = key(); must(/\]\]/y);
      const parent = walk(root, path.slice(0, -1));
      if (!Object.hasOwn(parent, path.at(-1))) parent[path.at(-1)] = [];
      if (!Array.isArray(parent[path.at(-1)])) fail();
      parent[path.at(-1)].push(current = table());
    } else if (eat(/\[/y)) { const path = key(); must(/\]/y); current = walk(root, path); } else assign(current, key());
    space(); eat(/#[^\n]*/y);
    if (at < text.length) must(/\r?\n/y);
  }
}

// A Codex role session never loads config.toml, whose MCP servers, apps, hooks and project trust would run beside the CLI,
// outside the sandbox. It inherits only the model settings, the selected provider's definition and where the login is
// stored, passed explicitly. A profile or provider that sets anything else cannot be honoured safely, so the phase refuses.
const MODEL_SETTING = /^model(?:_(?!providers$)[a-z_]+)?$/;
// A provider's literal `http_headers` or bearer token would put a credential on the command line, so neither is passed.
const PROVIDER_SETTINGS = new Set(['name', 'base_url', 'env_key', 'env_key_instructions', 'wire_api', 'query_params', 'env_http_headers',
  'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']);
const plain = (value) => ['string', 'number', 'boolean'].includes(typeof value) || (isTable(value) && Object.values(value).every(plain));

function codexSettings(home, request) {
  const path = join(home, 'config.toml');
  let config;
  try { config = existsSync(path) ? readToml(readFileSync(path, 'utf8')) : {}; } catch (error) {
    return { blocker: `codex-config: ${path} cannot be read (${error.message}), so its model settings cannot be honoured` }; }
  const name = request.profile ?? config.profile;
  const profile = name === undefined ? {} : config.profiles?.[name];
  if (!isTable(profile)) return { blocker: `codex-profile: ${JSON.stringify(name)} is not a profile in ${path}` };
  const extra = Object.keys(profile).filter((key) => !MODEL_SETTING.test(key));
  if (extra.length) return { blocker: `codex-profile: ${name} also sets ${extra.join(', ')}; a role session honours only model settings` };
  const settings = { ...Object.fromEntries(Object.entries(config).filter(([key]) => MODEL_SETTING.test(key) || key === 'cli_auth_credentials_store')),
    ...profile };
  if (request.model) delete settings.model;
  if (request.effort) delete settings.model_reasoning_effort;
  const named = (value) => typeof value === 'string' && value !== '';
  const provider = settings.model_provider;
  if (provider !== undefined && !named(provider)) return { blocker: `codex-provider: model_provider in ${path} is not a provider name` };
  const definition = typeof provider === 'string' ? config.model_providers?.[provider] : undefined;
  if (definition !== undefined) {
    const unsafe = isTable(definition) ? Object.keys(definition).filter((key) => !PROVIDER_SETTINGS.has(key)) : ['its definition'];
    if (unsafe.length || !/^[A-Za-z0-9_-]+$/.test(provider)) {
      return { blocker: `codex-provider: ${provider} sets ${unsafe.join(', ') || 'an unquotable name'}, which a role session does not pass on` }; }
    settings[`model_providers.${provider}`] = definition;
  }
  const unreadable = Object.keys(settings).filter((key) => !plain(settings[key]));
  if (unreadable.length) return { blocker: `codex-config: ${unreadable.join(', ')} in ${path} cannot be passed on as a literal value` };
  // Under --json the CLI reports no model, provider or effort, so the phase records the values passed here.
  const model = request.model ?? settings.model;
  const effort = request.effort ?? settings.model_reasoning_effort;
  if (!named(model)) return { blocker: `codex-model: no model is pinned; pass --model, or set model in ${path} or the selected profile` };
  if (effort !== undefined && !named(effort)) return { blocker: `codex-config: model_reasoning_effort in ${path} is not an effort name` };
  return { settings, identity: { provider: provider === undefined ? 'openai (default)' : `${provider} (requested)`, model: `${model} (requested)`,
    effort: effort === undefined ? 'N/A (not emitted)' : `${effort} (requested)` } };
}

// Provider credentials stay in the installed CLI's own process; model-directed tools reach only the bounded worker. Optional
// model/effort arguments, and a Codex profile's model settings, select existing capabilities without copying configuration.
function launchCommand(request, bounds, settings = {}) {
  const write = request.role === 'writer';
  if (request.provider === 'claude') {
    // Bash is the only tool, and the trusted shell prefix runs every command in bounded-shell.sh. Native file tools would
    // run inside the logged-in CLI, so none is offered: reads, diffs, edits and checks all go through the bounded shell.
    return { env: { CLAUDE_CODE_SHELL_PREFIX: BOUNDED_SHELL, BOUNDED_WORKTREE: request.worktree,
      BOUNDED_MODE: write ? 'write' : 'read', BOUNDED_SCRATCH: bounds.scratch, BOUNDED_READ: bounds.read.join('\n'),
      BOUNDED_GIT: bounds.git.join('\n'), BOUNDED_PATH: bounds.path, TMPDIR: bounds.scratch },
    args: ['-p', ...(request.model ? ['--model', request.model] : []), ...(request.effort ? ['--effort', request.effort] : []),
      '--permission-mode', 'dontAsk', '--allowedTools', 'Bash', '--no-session-persistence',
      // The worktree's `.claude/settings*.json` is PR content: its hooks, permissions and environment never load.
      '--setting-sources', 'user',
      '--output-format', 'json', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] }; }
  // Codex's own Linux sandbox applies a named permission profile to every command it runs: no network, a cleared environment,
  // read access to the system minimum, the toolchain and Git metadata, and the worktree writable only for a writer.
  // Git directories come last and are the most specific entries, so a worktree's own `.git` stays read-only.
  const filesystem = { ':minimal': 'read', ...Object.fromEntries(bounds.read.map((dir) => [dir, 'read'])),
    ':workspace_roots': write ? 'write' : 'read', [bounds.scratch]: 'write', ...Object.fromEntries(bounds.git.map((dir) => [dir, 'read'])) };
  // The sandbox probe runs under these same overrides, so it tests the profile the phase gets.
  const profile = ['-c', 'default_permissions="bounded"', '-c', `permissions.bounded.filesystem=${toml(filesystem)}`,
    '-c', 'permissions.bounded.network.enabled=false'];
  return { env: {}, profile, args: ['exec', '--color', 'never', '-C', request.worktree,
    // As in the GitHub pipeline: no user configuration or rules load, so no configured integration starts (see codexSettings).
    '--ignore-user-config', '--ignore-rules', ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
    ...(request.model ? ['-m', request.model] : []), ...(request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ...profile, '-c', 'shell_environment_policy.inherit="none"',
    '-c', `shell_environment_policy.set=${toml({ PATH: bounds.path, LANG: 'C.UTF-8', HOME: bounds.scratch, TMPDIR: bounds.scratch })}`,
    // Stdout carries JSONL events and -o the last message, written by the CLI itself outside the worker.
    '-c', 'approval_policy="never"', '--json', '-o', bounds.last, '--ephemeral', '-'] };
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;
// Each row is [input, cached_input, cache_write, output, reasoning] as the CLI reports them, reasoning optional. One missing
// or invalid count makes the whole usage malformed, because a partial sum would understate it. Usage never decides a status.
function usageOf(rows, fields) {
  if (rows === null) return { usage: null, usage_reason: 'malformed' };
  if (!rows.length) return { usage: null, usage_reason: 'not-reported' };
  if (!rows.every((row) => row.slice(0, 4).every(count) && (row[4] === undefined || count(row[4])))) return { usage: null, usage_reason: 'malformed' };
  const sum = (index) => rows.reduce((total, row) => total + (row[index] ?? 0), 0);
  return { usage: { input: sum(0), cached_input: sum(1), cache_write: sum(2), output: sum(3),
    ...(rows.some((row) => row[4] !== undefined) ? { reasoning: sum(4) } : {}), ...fields }, usage_reason: undefined };
}

// Codex --json events, read as each stdout line arrives. Only a whole line that is a JSON object is an event; an agent
// message's text is a string inside its item, so no line it contains is ever read as one.
function codexEvents() {
  const events = { threads: [], turns: [], errors: [], malformed: false };
  events.line = (line) => {
    let event = null;
    try { event = JSON.parse(line); } catch { /* not an event */ }
    if (!isTable(event)) events.malformed = true;
    else if (event.type === 'thread.started') events.threads.push(event.thread_id);
    else if (event.type === 'turn.completed') events.turns.push(isTable(event.usage) ? event.usage : {});
    else if (event.type === 'error' || event.type === 'turn.failed') {
      const message = event.type === 'error' ? event.message : event.error?.message;
      if (typeof message === 'string' && events.errors.length < 3) events.errors.push(message.slice(0, 240));
    }
  };
  return events;
}

// A Codex phase's model, provider and effort are its launch values; its session id is the one thread.started event's.
// No stderr line is read as metadata.
function codexObserved(events, identity) {
  const [thread, ...more] = events.threads;
  return { ...identity, context: 'N/A (not emitted)', session: !more.length && typeof thread === 'string' && thread ? thread : null, sandbox: null,
    completed: true, tokens: usageOf(events.malformed ? null : events.turns.map((u) =>
      [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens]),
    { cost_usd: null, source: 'codex:turn.completed' }) };
}

// Claude's input counts cache reads and writes as well, so the record's input adds them; cost is the run's total_cost_usd.
function claudeUsage(stdout, result) {
  if (!isTable(result)) return usageOf(stdout.trim() ? null : [], {});
  const entries = isTable(result.modelUsage) ? Object.values(result.modelUsage) : [];
  const keys = ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'];
  if (!entries.some((entry) => keys.some((key) => entry?.[key] !== undefined)) || result.total_cost_usd === undefined) return usageOf([], {});
  if (!(Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0)) return usageOf(null, {});
  const tokens = usageOf(entries.map((entry) => [...keys, 'thinkingTokens'].map((key) => entry?.[key])),
    { cost_usd: result.total_cost_usd, source: 'claude:modelUsage' });
  if (tokens.usage) tokens.usage.input += tokens.usage.cached_input + tokens.usage.cache_write;
  return tokens;
}

function deniedOperation({ tool_name: tool, tool_input: input }) {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit';
  const command = tool === 'Bash' ? String(input?.command ?? '') : '';
  return /\bgit\b[^;&|]*\bpush\b/.test(command) ? 'push' : /\bgit\b[^;&|]*\bcommit\b/.test(command) ? 'commit' : tool;
}

function claudeObserved(stdout, stderr, request) {
  let result;
  try { result = JSON.parse(stdout); } catch { result = null; }
  const usage = result?.modelUsage ?? {};
  const names = Object.keys(usage);
  // A single reported usage entry identifies the model. Keep canonical identity separately
  // when this CLI emits it; do not require a source-machine-specific model or context window.
  const model = names.length === 1 ? names[0] : null;
  return { provider: 'claude', model: usage[model]?.canonicalModel ?? model,
    reported_model: model, context: usage[model]?.contextWindow ?? 'N/A (not emitted)',
    effort: /Unknown --effort value/.test(stderr) ? 'rejected' : request.effort ? `${request.effort} (requested)` : 'N/A (not emitted)',
    session: result?.session_id ?? null, completed: result?.subtype === 'success' && result?.is_error === false,
    denied: (result?.permission_denials ?? []).map(deniedOperation), text: result?.result, tokens: claudeUsage(stdout, result) };
}

// The Codex CLI writes the last message to -o without the newline its human-mode stdout adds, so the report restores it.
// Only a regular file counts; a link or any other node there is not what the CLI wrote.
function lastMessage(path) {
  let text = '';
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (fstatSync(fd).isFile()) text = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  } catch { /* missing */ }
  return text ? { text: `${text}\n` } : { blocker: 'report: the Codex last-message file is missing, empty or not a regular file' };
}

// The report the coordinator publishes is the result text with exactly one outer fence removed: a fence line is three
// or more backticks or tildes, an accepted opener carries no info string or `markdown`/`md`, and its closer is a bare
// fence of the same character at least as long. Any other wrapper, a second one, or a missing result stops the phase.
function unwrapReport(text) {
  if (typeof text !== 'string') return { blocker: 'report: the result field is missing or not a string' };
  const lines = text.split(/(?<=\n)/);
  const first = lines.findIndex((line) => line.trim());
  const open = first < 0 ? null : lines[first].trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!open) return { text };
  const last = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim());
  const closed = last > first && new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}$`).test(lines[last].trimEnd());
  if (!['', 'markdown', 'md'].includes(open[2].trim()) || !closed) return { blocker: 'report: the result is wrapped in an unrecognised code fence' };
  const inner = lines.filter((_, index) => index !== first && index !== last).join('');
  return /^ {0,3}(`{3,}|~{3,})/.test(inner.split(/(?<=\n)/).find((line) => line.trim())?.trimEnd() ?? '')
    ? { blocker: 'report: the result is wrapped in two code fences' } : { text: inner };
}

const writable = (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } };

// Each writer operation is checked before its phase is spent, and recorded as what the check established, not as a
// permission the helper cannot observe. A writer's Git metadata is read-only in the bounded worker, so the coordinator
// commits its change. No local check
// reaches a push transport, so a push is never reported as permitted. Only an unwritable worktree refuses.
async function writerPermissions(request, probeSeconds) {
  const remote = request.push && await git(request.worktree, ['remote', 'get-url', '--push', request.push], probeSeconds);
  return { edit: writable(request.worktree) ? 'writable' : 'not-writable', commit: 'coordinator-required',
    push: !request.push ? 'not-granted' : remote ? 'granted-transport-unverified' : 'no-such-remote' };
}

// Compare what the session reported with what was requested; any gap blocks the phase.
function verify(request, requested, observed) {
  const blockers = [];
  if (!observed.session) blockers.push('session id not observed');
  if (!observed.model) blockers.push('model not observed unambiguously');
  else if (requested.model && ![requested.model, `${requested.model} (requested)`].includes(observed.model)) {
    blockers.push(`model mismatch: requested ${requested.model}, observed ${observed.model}`);
  }
  if (!observed.provider) blockers.push('provider not observed');
  if (observed.effort === null) observed.effort = requested.effort ? `${requested.effort} (requested)` : 'N/A (not emitted)';
  if (observed.effort === 'rejected' || (requested.effort && ![requested.effort, `${requested.effort} (requested)`].includes(observed.effort))) {
    blockers.push(`effort mismatch: requested ${requested.effort ?? 'CLI default'}, observed ${observed.effort}`);
  }
  return blockers;
}

// Only the CLI's own log lines count: stderr also carries the transcript, which may quote "error".
const errorLines = (stderr) => stderr.split(/\r\n|\n|\r/)
  .filter((line) => /^(?:\S+Z\s+)?ERROR\b|^Error:|stream disconnected|error sending request/.test(line)).slice(0, 3).map((line) => line.slice(0, 240));

async function runPhase(request) {
  const route = ROUTES[request.provider];
  const probeSeconds = Math.min(PROBE_SECONDS, request.timeout);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !SESSION_VARIABLE.test(name) || (route.cli === 'claude' && CLAUDE_ROUTE.test(name))));
  const record = { run_id: request.runId, round: request.round, phase: request.phase, attempt: request.attempt,
    role: request.role, provider: route.cli, route: request.profile ? `profile:${request.profile}` : 'cli-configured', worktree: request.worktree,
    requested: { model: request.model ?? null, effort: request.effort ?? null, profile: request.profile ?? null },
    started_at: new Date().toISOString(), blockers: [], coordinator: [], usage: null, usage_reason: 'not-run' };
  const secrets = Object.entries(env).filter(([name, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(name) && value.length >= 8).map(([, value]) => value);
  let scratch;
  let lastDir;
  const finish = (status, fields = {}) => {
    for (const dir of [scratch, lastDir]) if (dir) rmSync(dir, { recursive: true, force: true });
    if (timeouts.length) { status = 'timeout'; fields = { timeouts, transport_failure: timeouts[0], ...fields }; }
    Object.assign(record, fields, { status, ended_at: new Date().toISOString() });
    return { status, record, secrets }; };

  record.head_before = await git(request.worktree, ['rev-parse', 'HEAD'], probeSeconds);
  if (record.head_before !== request.expectedHead) {
    record.blockers.push(`head-mismatch: worktree HEAD ${record.head_before ?? 'unreadable'} differs from expected ${request.expectedHead}`);
  } else if ((await git(request.worktree, ['status', '--porcelain'], probeSeconds)) !== '') {
    record.blockers.push('dirty-worktree: the worktree has uncommitted changes or its status is unreadable');
  }
  // The bounded worker is built on Linux namespaces, bubblewrap for Claude and Codex's Linux sandbox; elsewhere no role runs.
  if (process.platform !== 'linux') record.blockers.push(`bounded-tools: role tools run only in the Linux bounded worker, not on ${process.platform}`);
  const codex = route.cli === 'codex' ? codexSettings(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), request) : {};
  if (codex.blocker) record.blockers.push(codex.blocker);
  if (!record.blockers.length && request.role === 'writer') record.permissions = await writerPermissions(request, probeSeconds);
  if (record.permissions?.edit === 'not-writable') record.blockers.push('writer-permission: the worktree is not writable, so the phase could produce no change');
  if (timeouts.length || record.blockers.length) return finish('refused');

  // Every Codex call starts the binary resolved here, so an update that switches releases mid-launch cannot swap it.
  const resolved = route.cli === 'codex' ? resolveCodex(env.PATH ?? '', env) : {};
  // Without one, a PATH lookup of `codex` would search the relative components resolveCodex skips.
  if (resolved.exe === null) { record.blockers.push('codex: no executable codex in an absolute PATH directory; check the installed CLI'); return finish('refused'); }
  const cli = resolved.exe ?? route.cli;
  const version = await runBounded(cli, ['--version'], { env, timeoutSeconds: probeSeconds, label: `${route.cli} --version` });
  record.cli_version = version.code === 0 ? version.stdout.trim().split('\n').at(-1) : 'unverified';
  if (timeouts.length) return finish('timeout');
  if (version.code !== 0) { record.blockers.push(`${route.cli}: version probe failed; check the installed CLI`); return finish('refused'); }
  scratch = mkdtempSync(join(tmpdir(), 'dev-review-pr-'));
  const gitDirs = await git(request.worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], probeSeconds);
  const bounds = { scratch, path: env.PATH ?? '', read: [...toolchainDirs(env.PATH ?? '', process.env), ...(resolved.release ? [resolved.release] : [])],
    git: [...new Set((gitDirs ?? '').split('\n').filter(Boolean))] };
  if (route.cli === 'codex') {
    // The CLI writes -o as a host process, so a path the worker could reach would let a role plant the report or redirect the write.
    lastDir = mkdtempSync(join(tmpdir(), 'dev-review-pr-last-'));
    bounds.last = join(lastDir, 'last-message.md');
    const inside = [request.worktree, scratch, ...bounds.read, ...bounds.git].map(real).find((mount) => mount && covers(mount, real(lastDir)));
    if (inside) { record.blockers.push(`bounded-tools: the last-message directory lies inside the worker mount ${inside}; set TMPDIR outside it`); return finish('refused'); }
  }
  const { args, env: workerEnv, profile } = launchCommand(request, bounds, codex.settings);
  const phaseEnv = { ...env, ...workerEnv };
  if (route.cli === 'claude') {
    const probe = await runBounded(BOUNDED_SHELL, ['true'], { cwd: request.worktree, env: phaseEnv, timeoutSeconds: probeSeconds, label: 'bounded-shell probe' });
    if (timeouts.length) return finish('timeout');
    if (probe.code !== 0) {
      record.blockers.push(`bounded-shell: the worker could not start (${probe.stderr.trim().split('\n')[0]?.slice(0, 160) || `exit ${probe.code}`}); it needs bubblewrap and unprivileged user namespaces`);
      return finish('refused');
    }
  } else {
    // `codex sandbox` has no --ignore-user-config, so it gets an empty CODEX_HOME: configuration the phase ignores cannot
    // change its result. Only exit 0 lets the phase start, so a CLI whose `codex sandbox` differs fails closed.
    const home = mkdtempSync(join(tmpdir(), 'dev-review-pr-codex-home-'));
    const probe = await runBounded(cli, ['sandbox', ...profile, '--', 'true'], { cwd: request.worktree, env: { ...phaseEnv, CODEX_HOME: home },
      timeoutSeconds: probeSeconds, label: 'codex sandbox probe' });
    rmSync(home, { recursive: true, force: true });
    if (timeouts.length) return finish('timeout');
    if (probe.code !== 0) {
      // Codex warns first when CODEX_HOME is a temporary directory, so the first line that is not a warning follows the first line.
      const lines = probe.stderr.trim().split('\n');
      const cause = [...new Set([lines[0], lines.find((line) => !line.startsWith('WARNING:'))])].filter(Boolean)
        .map((line) => line.slice(0, 160)).join('; ') || `exit ${probe.code}`;
      record.blockers.push(`bounded-tools: codex sandbox could not run a command under the phase's permission profile (${cause})`);
      return finish('refused');
    }
  }
  const link = gitLink(request.worktree);
  record.started_at = new Date().toISOString();
  const events = route.cli === 'codex' ? codexEvents() : null;
  const phase = await runBounded(cli, args, { cwd: request.worktree, env: phaseEnv, promptPath: request.prompt,
    timeoutSeconds: request.timeout, label: `the ${request.role} phase`, onLine: events?.line });
  record.ended_at = new Date().toISOString();
  record.elapsed_seconds = Math.round(phase.elapsedMs / 1000);
  record.exit_code = phase.code;
  // Codex reports no denials; its uncommitted change is the coordinator's to commit, never a denial.
  const { denied = [], text, tokens, ...observed } = events ? codexObserved(events, codex.identity) : claudeObserved(phase.stdout, phase.stderr, request);
  record.observed = observed;
  Object.assign(record, tokens);
  // A failed --json run reports its cause as events and may leave stderr empty.
  record.errors = [...(events?.errors ?? []), ...errorLines(phase.stderr)].slice(0, 3);
  if (gitLink(request.worktree) !== link) {
    record.blockers.push('git-metadata: the phase changed the worktree\'s .git entry, so no Git command runs in it; inspect it before any commit');
    return { ...finish('blocked'), output: { output: phase.stdout, meta: phase.stderr } };
  }
  record.head_after = await git(request.worktree, ['rev-parse', 'HEAD'], probeSeconds);
  record.dirty_after = (await git(request.worktree, ['status', '--porcelain'], probeSeconds)) !== '';
  record.commits = record.head_after && record.head_after !== record.head_before
    ? ((await git(request.worktree, ['log', '--format=%H%x09%an <%ae>%x09%cn <%ce>', `${record.head_before}..${record.head_after}`], probeSeconds)) ?? '')
      .split('\n').filter(Boolean).map((line) => { const [sha, author, committer] = line.split('\t'); return { sha, author, committer }; }) : [];
  record.denied = denied;
  const output = { output: phase.stdout, meta: phase.stderr };

  if (phase.timedOut) return { ...finish('timeout', { transport_failure: `timeout after ${record.elapsed_seconds}s` }), output };
  if (phase.spawnError || phase.code !== 0 || !observed.completed) {
    return { ...finish('failed', { transport_failure: record.errors[0] ?? phase.spawnError ?? `exit ${phase.code}${phase.signal ? ` (${phase.signal})` : ''}` }), output };
  }
  record.blockers.push(...verify(request, record.requested, observed));
  const report = events ? lastMessage(bounds.last) : unwrapReport(text);
  if (report.blocker) record.blockers.push(report.blocker); else output.report = report.text;
  if (request.role === 'reviewer' && (record.head_after !== record.head_before || record.dirty_after)) record.blockers.push('read-only violation: the reviewer changed the worktree');
  return { ...finish(record.blockers.length ? 'blocked' : 'completed'), output };
}

// A coordinator commit or push is recorded against the writer phase, so the ledger never
// credits the writer with Git operations it could not perform.
async function attribute({ record: path, operation, sha }) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.role !== 'writer' || typeof record.head_before !== 'string' || !Array.isArray(record.coordinator)) {
    return [false, [`${path} is not a writer phase record`]];
  }
  const descends = await runBounded('git', ['-C', record.worktree, 'merge-base', '--is-ancestor', record.head_before, sha],
    { env: process.env, timeoutSeconds: PROBE_SECONDS, label: 'git merge-base' });
  if (descends.code !== 0) return [false, [timeouts[0] ?? `${sha} is not a commit descending from ${record.head_before}`]];
  record.coordinator.push({ actor: 'coordinator', operation, sha, recorded_at: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return [true, [`${path}: coordinator ${operation} ${sha}`]];
}

// ---- One input boundary: every flag is checked here and nothing downstream re-checks. ----

class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
const FLAGS = {
  run: ['provider', 'role', 'phase', 'run-id', 'round', 'attempt', 'worktree', 'expected-head', 'prompt', 'output', 'meta', 'record', 'report', 'timeout'],
  attribute: ['record', 'operation', 'sha'],
};
const positive = (value, flag) => (/^[1-9]\d*$/.test(value) ? Number(value) : fail(`--${flag} must be a positive integer`));
const absolute = (value, flag) => (isAbsolute(value) ? value : fail(`--${flag} must be an absolute path`));
// Checked before the phase is spent, because a destination that fails only at the final write loses the whole record.
const destination = (value, flag) => { const path = absolute(value, flag);
  const exists = existsSync(path);
  if (exists && statSync(path).isDirectory()) fail(`--${flag} must name a file, not a directory`);
  try { accessSync(exists ? path : dirname(path), constants.W_OK); } catch { fail(`--${flag} must name a writable file in an existing directory`); }
  return value; };

function readInput(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(FLAGS, command ?? '')) fail('unknown or missing command');
  const given = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = String(args[index]).replace(/^--/, '');
    const allowed = [...FLAGS[command], ...(command === 'run' ? ['model', 'effort', 'profile', 'push'] : [])];
    if (!args[index].startsWith('--') || !allowed.includes(flag) || Object.hasOwn(given, flag) || index + 1 >= args.length) {
      fail(`${command} does not accept ${args[index]} here`);
    }
    given[flag] = args[index + 1];
  }
  for (const flag of FLAGS[command]) if (!Object.hasOwn(given, flag)) fail(`${command} requires --${flag}`);
  if (command === 'attribute') {
    if (!['commit', 'push'].includes(given.operation)) fail('--operation must be commit or push');
    if (!/^[0-9a-f]{40}$/.test(given.sha)) fail('--sha must be a full 40-character commit SHA');
    return { command, record: absolute(given.record, 'record'), operation: given.operation, sha: given.sha };
  }
  if (!Object.hasOwn(ROUTES, given.provider)) fail(`unknown provider "${given.provider}": use codex or claude`);
  if (!Object.hasOwn(PHASES, given.role)) fail('--role must be reviewer or writer');
  if (!PHASES[given.role].includes(given.phase)) fail(`--phase for a ${given.role} must be ${PHASES[given.role].join(', ')}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(given['run-id'])) fail('--run-id must be 1-64 letters, digits, dots, dashes or underscores');
  if (!/^[0-9a-f]{40}$/.test(given['expected-head'])) fail('--expected-head must be a full 40-character commit SHA');
  if (!existsSync(absolute(given.worktree, 'worktree')) || !statSync(given.worktree).isDirectory()) fail('--worktree must be an existing directory');
  if (!existsSync(absolute(given.prompt, 'prompt')) || !statSync(given.prompt).isFile()) fail('--prompt must be an existing file');
  if (given.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(given.model)) fail('--model must be one installed CLI model identifier');
  if (given.effort !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(given.effort)) fail('--effort must be one installed CLI effort value');
  if (given.profile !== undefined && (given.provider !== 'codex' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(given.profile))) fail('--profile names one existing Codex configuration profile');
  if (Object.hasOwn(given, 'push') && (given.role !== 'writer' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(given.push))) fail('--push names one remote a writer phase is authorized to push to');
  return { command, provider: given.provider, role: given.role, phase: given.phase, runId: given['run-id'],
    round: positive(given.round, 'round'), attempt: positive(given.attempt, 'attempt'), timeout: positive(given.timeout, 'timeout'),
    worktree: given.worktree, expectedHead: given['expected-head'], prompt: given.prompt, push: given.push,
    output: destination(given.output, 'output'), meta: destination(given.meta, 'meta'), record: destination(given.record, 'record'),
    report: destination(given.report, 'report'),
    model: given.model, effort: given.effort, profile: given.profile };
}

const redact = (text, secrets) => secrets.reduce((value, secret) => value.split(secret).join('<redacted>'), text);

async function main(argv) {
  let request;
  try {
    request = readInput(argv);
    if (request.command === 'attribute') {
      const [ok, lines] = await attribute(request);
      for (const line of lines) (ok ? console.log : console.error)(line);
      return ok ? 0 : 1;
    }
    const { status, record, secrets, output } = await runPhase(request);
    if (output) {
      writeFileSync(request.output, redact(output.output, secrets));
      writeFileSync(request.meta, redact(output.meta, secrets));
      if (output.report !== undefined) writeFileSync(request.report, redact(output.report, secrets));
    }
    writeFileSync(request.record, redact(`${JSON.stringify(record, null, 2)}\n`, secrets));
    console.log(JSON.stringify({ status, record: request.record, blockers: redact(JSON.stringify(record.blockers), secrets) }));
    return status === 'completed' ? 0 : 1;
  } catch (error) {
    // A usage, read or write failure is a phase that did not run, never a pass.
    console.error(`launch-phase: ${error.message}`);
    if (error instanceof InputError) {
      console.error(`Usage: node launch-phase.mjs run ${FLAGS.run.map((flag) => `--${flag} VALUE`).join(' ')} [--model MODEL] [--effort LEVEL] [--profile CODEX_PROFILE] [--push REMOTE]`);
      console.error('       node launch-phase.mjs attribute --record PATH --operation commit|push --sha SHA');
    }
    return 2;
  }
}

// Only a direct run executes the CLI; an importing caller gets the module and nothing else.
const isDirectInvocation = () => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isDirectInvocation()) process.exitCode = await main(process.argv.slice(2));
