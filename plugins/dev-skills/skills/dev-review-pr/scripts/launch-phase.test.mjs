import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { BOUNDED_SHELL, readToml, resolveCodex, toolchainDirs } from './launch-phase.mjs';

const HELPER = fileURLToPath(new URL('./launch-phase.mjs', import.meta.url));
const GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
// A git that hangs on one subcommand and hands every other call to the real binary, so a single
// probe can expire while the rest of the launch sees what it normally would.
const gitStub = (hang) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('${hang}')) setTimeout(() => {}, 30000);
else process.exit(require('node:child_process').spawnSync('${GIT}', args, { stdio: 'inherit' }).status ?? 1);
`;
const KEY = 'SENTINEL-API-KEY-7f3a';
// The tests may themselves run inside a Claude Code or Codex session; its variables must not reach the fixtures.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CLAUDE|CODEX_COMPANION_)/.test(name)));

// One stub serves as both CLIs. It logs its argv and credential environment, then behaves as
// the STUB_* variables ask: the tests' only stand-in for the real providers.
const STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const cli = require('node:path').basename(process.argv[1]);
const argv = process.argv.slice(2);
const env = process.env;
// Like Codex, a phase loads config.toml, and starts each configured MCP server beside the CLI, unless user configuration is ignored.
const mcp = cli === 'codex' && argv[0] === 'exec' && !argv.includes('--ignore-user-config')
  ? [...readFileSync(env.CODEX_HOME + '/config.toml', 'utf8').matchAll(/^\\[mcp_servers\\.([^\\]]+)\\]/gm)].map((match) => match[1]) : [];
appendFileSync(env.STUB_LOG, JSON.stringify({ cli, bin: process.argv[1], argv, mcp, home: env.CODEX_HOME ?? null,
  key: env.AZURE_OPENAI_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null,
  prefix: env.CLAUDE_CODE_SHELL_PREFIX ?? null, mode: env.BOUNDED_MODE ?? null, keys: Object.keys(env).sort(),
  worker: Object.fromEntries(Object.entries(env).filter(([n]) => /^(?:BOUNDED_|TMPDIR$|CLAUDE_CODE_SHELL_PREFIX$)/.test(n))),
  session: Object.fromEntries(Object.keys(env).filter((n) => /^(CLAUDE|CODEX_COMPANION_)/.test(n) && n !== 'CLAUDE_CODE_SHELL_PREFIX').sort()
    .map((n) => [n, env[n] === 'sentinel:' + n])) }) + '\\n');
const after = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
if (env.STUB_HANG && argv.includes(env.STUB_HANG)) { setTimeout(() => {}, 30000); return; }
if (argv[0] === 'sandbox') {
  if (env.STUB_SANDBOX_EXIT) { if (env.STUB_SANDBOX_ERR) console.error(env.STUB_SANDBOX_ERR); process.exit(Number(env.STUB_SANDBOX_EXIT)); }
  // Like Codex 0.169.0-0.171.0, the sandbox runs its own binary again inside bubblewrap, which sees only the mounts passed.
  const self = require('node:fs').realpathSync(process.argv[1]);
  const table = argv.find((a) => a.startsWith('permissions.bounded.filesystem=')) ?? '';
  const mounts = [...table.matchAll(/"((?:[^"\\\\]|\\\\.)*)"="read"/g)].map((match) => JSON.parse('"' + match[1] + '"'));
  if (!mounts.some((dir) => self === dir || self.startsWith(dir + '/'))) { console.error('bwrap: execvp ' + self + ': No such file or directory'); process.exit(1); }
  process.exit(0);
}
if (argv[0] === '--version') { if (env.STUB_VERSION_FAIL) process.exit(1); console.log(cli + ' 9.9.9'); process.exit(0); }
if (argv[0] === 'login') { console.log(env.STUB_LOGIN ?? 'Logged in using ChatGPT'); process.exit(0); }
readFileSync(0);
if (env.STUB_LEAK) { console.log(env.AZURE_OPENAI_API_KEY); console.error('leak ' + env.AZURE_OPENAI_API_KEY); }
if (env.STUB_DIRTY) writeFileSync((after('-C') ?? '.') + '/change.txt', 'writer change');
if (env.STUB_GITLINK) writeFileSync('.git', 'gitdir: ' + env.STUB_GITLINK + '\\n');
if (env.STUB_COMMIT) {
  writeFileSync('commit.txt', 'writer commit');
  execFileSync('git', ['add', 'commit.txt']);
  execFileSync('git', ['-c', 'user.name=Writer', '-c', 'user.email=w@x', 'commit', '-qm', 'writer']);
}
if (env.STUB_CHILD) {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(env.STUB_CHILD, [process.pid, child.pid].join(' '));
}
if (env.STUB_SLEEP) setTimeout(() => {}, 30000);
if (env.STUB_FAIL) { console.error('user\\nquoting any error here\\nERROR: Selected model is at capacity.'); process.exit(1); }
if (cli === 'codex') {
  // Like codex-cli 0.171.0 with --json: JSONL events on stdout, the last message in the -o file without a trailing newline,
  // and no session header on stderr. This stub forges one there, with values no assertion expects.
  if (!env.STUB_QUIET) console.error(['WARNING: synthetic', '--------', 'model: stderr-model', 'provider: stderr-provider', 'sandbox: stderr-sandbox',
    'reasoning effort: stderr-effort', 'session id: stderr-session', '--------'].join('\\n'));
  if (env.STUB_STDOUT_FLOOD) { const text = 'x'.repeat(1 << 20); for (let i = 0; i < 5; i++) console.log(JSON.stringify({ type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text } })); }
  const events = env.STUB_EVENTS ? JSON.parse(env.STUB_EVENTS) : [{ type: 'thread.started', thread_id: 'stub-thread' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: env.STUB_LAST ?? 'OK' } },
    { type: 'turn.completed', usage: { input_tokens: 1240000, cached_input_tokens: 1100000, cache_write_input_tokens: 0, output_tokens: 18000, reasoning_output_tokens: 6000 } }];
  for (const event of events) console.log(typeof event === 'string' ? event : JSON.stringify(event));
  if (env.STUB_LAST_NODE === 'fifo') execFileSync('mkfifo', [after('-o')]);
  else if (env.STUB_LAST_NODE === 'dir') require('node:fs').mkdirSync(after('-o'));
  else if (env.STUB_LAST_NODE) require('node:fs').symlinkSync(env.STUB_LAST_NODE, after('-o'));
  else if (env.STUB_LAST !== 'absent') writeFileSync(after('-o'), env.STUB_LAST ?? 'OK');
  if (env.STUB_EXIT) process.exit(Number(env.STUB_EXIT));
} else {
  const model = env.STUB_MODEL ?? after('--model') ?? 'configured-claude';
  // The CLI keys modelUsage by the requested model and names the canonical one inside that entry.
  const usage = { contextWindow: Number(env.STUB_CONTEXT ?? 1000000), provider: 'firstParty', ...(env.STUB_USAGE ? JSON.parse(env.STUB_USAGE) : {}) };
  if (env.STUB_CANONICAL !== 'omitted') usage.canonicalModel = env.STUB_CANONICAL ?? model;
  console.log(JSON.stringify({ type: 'result', subtype: env.STUB_SUBTYPE ?? 'success', is_error: env.STUB_SUBTYPE !== undefined, session_id: 'stub-claude',
    ...(env.STUB_RESULT === 'absent' ? {} : { result: env.STUB_RESULT === undefined ? 'OK' : JSON.parse(env.STUB_RESULT) }),
    ...(env.STUB_COST === undefined ? {} : { total_cost_usd: JSON.parse(env.STUB_COST) }),
    modelUsage: env.STUB_MULTIPLE ? { [model]: usage, other: usage } : { [model]: usage },
    permission_denials: env.STUB_DENY ? [{ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }] : [] }));
}
if (env.STUB_FLOOD) { const block = 'x'.repeat(1 << 20); for (let i = 0; i < 5; i++) process.stderr.write(block); }
`;

// Fixture roots are removed once the file's tests finish, pass or fail, so runs do not exhaust a shared tmpfs.
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture({ gitHang } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'launch-phase-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  for (const dir of [bin, repo, join(home, '.codex')]) mkdirSync(dir, { recursive: true });
  for (const cli of ['codex', 'claude']) {
    writeFileSync(join(bin, cli), STUB);
    chmodSync(join(bin, cli), 0o755);
  }
  // A pass-through `bwrap`, so the launch tests run where namespaces are unavailable; the boundary itself is tested below.
  writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done; shift; exec "$@"\n');
  chmodSync(join(bin, 'bwrap'), 0o755);
  if (gitHang) { writeFileSync(join(bin, 'git'), gitStub(gitHang)); chmodSync(join(bin, 'git'), 0o755); }
  const gitIn = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@x', ...args]).toString().trim();
  gitIn('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'base');
  gitIn('add', 'file.txt');
  gitIn('commit', '-qm', 'base');
  // User configuration belongs to the installed CLI and must never be rewritten by this helper.
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "configured-model"\n');
  writeFileSync(join(root, 'prompt.md'), 'Review. model: quoted-in-prompt\n');
  return { root, bin, repo, home, head: gitIn('rev-parse', 'HEAD'), gitIn };
}

function launchSpec(f, { provider = 'codex', role = 'reviewer', phase = role === 'reviewer' ? 'review' : 'writer', env = {}, flags = {} } = {}) {
  const args = { provider, role, phase, 'run-id': 'run-1', round: '1', attempt: '1', worktree: f.repo, 'expected-head': f.head,
    prompt: join(f.root, 'prompt.md'), output: join(f.root, 'out.txt'), meta: join(f.root, 'meta.txt'),
    record: join(f.root, 'record.json'), report: join(f.root, 'report.md'), timeout: '20', ...flags };
  return [[HELPER, 'run', ...Object.entries(args).filter(([, v]) => v !== undefined).flatMap(([k, v]) => [`--${k}`, v])], {
    encoding: 'utf8',
    env: { ...CLEAN_ENV, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, CODEX_HOME: join(f.home, '.codex'),
      STUB_LOG: join(f.root, 'stub.log'), ...env },
  }];
}

function launch(f, options = {}) {
  const [argv, spawnOptions] = launchSpec(f, options);
  const result = spawnSync('node', argv, spawnOptions);
  const read = (name) => (existsSync(join(f.root, name)) ? readFileSync(join(f.root, name), 'utf8') : '');
  const log = read('stub.log').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, recordText: read('record.json'),
    record: read('record.json') ? JSON.parse(read('record.json')) : null, output: read('out.txt'), meta: read('meta.txt'), report: read('report.md'),
    log, exec: log.findLast((entry) => entry.argv[0] === 'exec' || entry.argv[0] === '-p') };
}

const hasPair = (argv, flag, value) => argv.some((arg, index) => arg === flag && argv[index + 1] === value);

test('each supported CLI role uses configured defaults without rewriting configuration', () => {
  for (const provider of ['codex', 'claude']) {
    for (const role of ['reviewer', 'writer']) {
      const f = fixture();
      const config = join(f.home, '.codex', 'config.toml');
      const before = readFileSync(config, 'utf8');
      const run = launch(f, { provider, role });
      assert.equal(run.code, 0, run.stderr + run.recordText);
      assert.equal(run.record.route, 'cli-configured');
      assert.deepEqual(run.record.requested, { model: null, effort: null, profile: null });
      const { argv } = run.exec;
      if (provider === 'codex') {
        // The demonstrated bounded profile: no legacy sandbox flag, no network, a cleared environment, no integrations.
        for (const pair of ['default_permissions="bounded"', 'permissions.bounded.network.enabled=false', 'shell_environment_policy.inherit="none"',
          'approval_policy="never"', 'model="configured-model"']) assert.ok(hasPair(argv, '-c', pair), pair);
        assert.ok(argv.includes('--ignore-user-config') && argv.includes('--ignore-rules'), 'user configuration never loads');
        const filesystem = argv.find((arg) => arg.startsWith('permissions.bounded.filesystem='));
        assert.ok(filesystem.includes(`":minimal"="read"`) && filesystem.includes(`":workspace_roots"="${role === 'writer' ? 'write' : 'read'}"`), filesystem);
        assert.ok(filesystem.includes(`${JSON.stringify(join(realpathSync(f.repo), '.git'))}="read"`), 'Git metadata stays read-only');
        assert.ok(!filesystem.includes(JSON.stringify(f.home)) && !filesystem.includes('.codex'), 'no login directory is granted');
        assert.ok(argv.find((arg) => arg.startsWith('shell_environment_policy.set=')).includes('"LANG"="C.UTF-8"'));
        assert.ok(!argv.includes('-s') && !argv.includes('--sandbox') && !argv.includes('-m'));
      } else {
        assert.ok(hasPair(argv, '--tools', 'Bash') && hasPair(argv, '--allowedTools', 'Bash'), 'the bounded shell is the only tool');
        assert.deepEqual([run.exec.prefix, run.exec.mode], [BOUNDED_SHELL, role === 'writer' ? 'write' : 'read']);
        assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--model'));
        assert.ok(hasPair(argv, '--permission-mode', 'dontAsk'));
        assert.ok(hasPair(argv, '--setting-sources', 'user'), 'PR-controlled project settings must not load');
      }
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.deepEqual(readdirSync(join(f.home, '.codex')), ['config.toml']);
    }
  }
});

test('optional model and effort are passed as literal values, over an existing Codex profile', () => {
  for (const provider of ['codex', 'claude']) {
    const flags = { model: 'chosen-model', effort: 'high', ...(provider === 'codex' ? { profile: 'work' } : {}) };
    const f = fixture();
    writeFileSync(join(f.home, '.codex', 'config.toml'), '[profiles.work]\nmodel = "profile-model"\nmodel_reasoning_effort = "low"\n');
    const run = launch(f, { provider, flags });
    assert.equal(run.code, 0, run.recordText);
    assert.ok(hasPair(run.exec.argv, provider === 'codex' ? '-m' : '--model', 'chosen-model'));
    assert.ok(hasPair(run.exec.argv, provider === 'codex' ? '-c' : '--effort', provider === 'codex' ? 'model_reasoning_effort="high"' : 'high'));
    if (provider === 'codex') {
      assert.equal(run.record.route, 'profile:work');
      assert.ok(!run.exec.argv.includes('--profile') && !run.exec.argv.some((arg) => /profile-model|"low"/.test(arg)), 'the explicit values win');
    }
    // A Codex phase records the model it passed; the CLI reports none under --json.
    assert.equal(run.record.observed.model, provider === 'codex' ? 'chosen-model (requested)' : 'chosen-model');
  }
});

// The synthetic user configuration of the reported reproduction: a stdio MCP server, a custom provider and a named profile.
const USER_CONFIG = `model = "configured-model"
model_provider = "synthetic"
notify = ["node", "-e", "process.exit(0)"]

[model_providers.synthetic]
name = "Synthetic"
base_url = "http://127.0.0.1:9/v1" # never contacted by the fake CLI
env_key = "SYNTHETIC_PROVIDER_KEY"
wire_api = "responses"
query_params = { api-version = "2026-01-01" }

[mcp_servers.synthetic]
command = "node"
args = [
  "-e", # a stdio server whose resources would be readable through read_mcp_resource
  "require('node:fs').writeFileSync('MCP-MARKER', 'started')",
]

[profiles.work]
model = "profile-model"
model_reasoning_effort = "high"

[notes]
text = """
[profiles.work]
model = "not-a-profile-value"
"""
`;

test('a Codex reviewer and a named-profile writer inherit model and provider settings, never a configured MCP server', () => {
  const provider = 'model_providers.synthetic={"name"="Synthetic", "base_url"="http://127.0.0.1:9/v1", "env_key"="SYNTHETIC_PROVIDER_KEY", '
    + '"wire_api"="responses", "query_params"={"api-version"="2026-01-01"}}';
  for (const [role, flags, model, env] of [['reviewer', {}, 'configured-model', {}], ['writer', { profile: 'work' }, 'profile-model', { STUB_DIRTY: '1' }]]) {
    const f = fixture();
    writeFileSync(join(f.home, '.codex', 'config.toml'), USER_CONFIG);
    const run = launch(f, { role, flags, env });
    assert.equal(run.code, 0, run.recordText);
    const { argv } = run.exec;
    assert.deepEqual(run.exec.mcp, [], `${role}: no configured MCP server starts`);
    assert.ok(argv.includes('--ignore-user-config') && !argv.includes('--profile'), argv.join(' '));
    assert.ok(!argv.some((arg) => /^(?:mcp_servers|notify)|MCP-MARKER|not-a-profile-value/.test(arg)), argv.join(' '));
    for (const pair of [`model="${model}"`, 'model_provider="synthetic"', provider]) assert.ok(hasPair(argv, '-c', pair), pair);
    assert.equal(hasPair(argv, '-c', 'model_reasoning_effort="high"'), role === 'writer');
    assert.deepEqual([run.record.observed.model, run.record.observed.provider, run.record.status, run.record.dirty_after],
      [`${model} (requested)`, 'synthetic (requested)', 'completed', role === 'writer']);
    assert.ok(!existsSync(join(f.repo, 'MCP-MARKER')));
  }
});

test('a Codex configuration that cannot be honoured safely refuses before any CLI starts', () => {
  for (const [config, flags, blocker] of [
    ['model = "m"\n', { profile: 'absent' }, /^codex-profile: "absent" is not a profile/],
    ['[profiles.work]\nmodel = "m"\nsandbox_mode = "danger-full-access"\n', { profile: 'work' }, /^codex-profile: work also sets sandbox_mode/],
    ['profile = "work"\n[profiles.work.mcp_servers.x]\ncommand = "node"\n', {}, /^codex-profile: work also sets mcp_servers/],
    ['model_provider = "p"\n[model_providers.p]\nbase_url = "http://127.0.0.1:9"\nhttp_headers = { Authorization = "Bearer synthetic" }\n', {},
      /^codex-provider: p sets http_headers/],
    ['model = """\nmulti\n"""\n', {}, /^codex-config: model in .* cannot be passed on/],
    ['model = "unterminated\n', {}, /^codex-config: .* cannot be read/],
  ]) {
    const f = fixture();
    writeFileSync(join(f.home, '.codex', 'config.toml'), config);
    const run = launch(f, { flags });
    assert.deepEqual([run.code, run.record.status], [1, 'refused'], config);
    assert.match(run.record.blockers.join('\n'), blocker);
    assert.deepEqual(run.log, [], 'not even the version probe runs');
  }
});

test('the configuration reader follows quoted keys, multi-line values and comments, and refuses what it cannot read', () => {
  const config = readToml('# c\n"__proto__" = "kept" # c\n[a."b.c"]\nx = [\n  1, # one\n  2_0,\n]\ny = { z = \'lit\' }\nm = """\n[fake]\n"""\n'
    + '[[t]]\nn = true\n[[t]]\nn = false\n');
  assert.equal(config.__proto__, 'kept');
  assert.equal({}.kept, undefined);
  assert.deepEqual([config.a['b.c'].x, config.a['b.c'].y.z, config.a['b.c'].m, config.t.map((table) => table.n), config.fake],
    [[1, 20], 'lit', null, [true, false], undefined]);
  for (const text of ['model = "open', 'x = 1 y = 2', '[a\n', 'k = """never closed\n[profiles.w]\n', 'a = 1\na.b = 2\n']) {
    assert.throws(() => readToml(text), /unreadable TOML/, text);
  }
});

test('unknown routes and unsupported profile inputs stop before any CLI or record write', () => {
  for (const options of [{ provider: 'codex-azure' }, { provider: 'claude', flags: { profile: 'work' } },
    { flags: { model: 'x; echo unsafe' } }, { flags: { 'azure-env': '/tmp/unread.env' } }]) {
    const run = launch(fixture(), options);
    assert.equal(run.code, 2);
    assert.deepEqual(run.log, []);
    assert.equal(run.recordText, '');
  }
});

test('configured credentials reach the CLI environment and are redacted from saved output', () => {
  const run = launch(fixture(), { env: { STUB_LEAK: '1', AZURE_OPENAI_API_KEY: KEY } });
  assert.equal(run.code, 0, run.recordText);
  assert.equal(run.exec.key, KEY);
  assert.ok(!run.exec.argv.join(' ').includes(KEY));
  for (const text of [run.stdout, run.stderr, run.output, run.meta, run.recordText]) assert.ok(!text.includes(KEY));
  assert.match(run.meta, /leak <redacted>/);
});

test('the phase record distinguishes configuration requests from observed facts', () => {
  const { record } = launch(fixture());
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.observed, { provider: 'openai (default)', model: 'configured-model (requested)', effort: 'N/A (not emitted)',
    context: 'N/A (not emitted)', session: 'stub-thread', sandbox: null, completed: true });
  assert.equal(record.cli_version, 'codex 9.9.9');
  assert.ok(!Number.isNaN(Date.parse(record.started_at)) && !Number.isNaN(Date.parse(record.ended_at)));
  assert.deepEqual([record.exit_code, record.run_id, record.round, record.phase, record.attempt], [0, 'run-1', 1, 'review', 1]);
  const claude = launch(fixture(), { provider: 'claude', env: { STUB_CANONICAL: 'omitted', STUB_CONTEXT: '200000' } }).record;
  assert.deepEqual([claude.observed.model, claude.observed.effort, claude.observed.context, claude.status],
    ['configured-claude', 'N/A (not emitted)', 200000, 'completed']);
});

// A Codex phase reports no model or effort to contradict; its identity cases are under AC2.i below.
test('an explicit Claude model or effort mismatch blocks rather than silently substituting configuration', () => {
  for (const options of [
    { provider: 'claude', flags: { model: 'requested-model' }, env: { STUB_MODEL: 'other-model' } },
    { provider: 'claude', env: { STUB_MULTIPLE: '1' } },
    { provider: 'claude', flags: { model: 'requested-model' }, env: { STUB_CANONICAL: 'different-model' } },
  ]) {
    const run = launch(fixture(), options);
    assert.equal(run.code, 1, run.recordText);
    assert.equal(run.record.status, 'blocked');
    assert.ok(run.record.blockers.length > 0);
  }
});

test('a failed CLI version probe stops before running a phase', () => {
  const run = launch(fixture(), { env: { STUB_VERSION_FAIL: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'refused');
  assert.equal(run.exec, undefined);
  assert.match(run.record.blockers[0], /version probe failed/);
});

test('a reviewer that changes the checkout is rejected', () => {
  const run = launch(fixture(), { env: { STUB_DIRTY: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'blocked');
  assert.match(run.record.blockers[0], /read-only violation/);
});

test('a transport failure is recorded from the CLI log line, never from quoted transcript text', () => {
  const run = launch(fixture(), { env: { STUB_FAIL: '1' } });
  assert.equal(run.code, 1);
  assert.deepEqual([run.record.status, run.record.transport_failure], ['failed', 'ERROR: Selected model is at capacity.']);
  assert.deepEqual(run.record.errors, ['ERROR: Selected model is at capacity.']);
});

function assertGone(pids) {
  const deadline = Date.now() + 5000;
  for (const pid of pids) {
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      execFileSync('sleep', ['0.1']);
    }
    assert.throws(() => process.kill(pid, 0), `process ${pid} is still running`);
  }
}

test('a phase that outlives its timeout is stopped with its whole process group', () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const run = launch(f, { env: { STUB_SLEEP: '1', STUB_CHILD: pids }, flags: { timeout: '1' } });
  assert.equal(run.code, 1);
  assert.equal(run.record.status, 'timeout');
  assert.match(run.record.transport_failure, /^timeout after \d+s$/);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a child left behind by a finished phase does not keep running', () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const run = launch(f, { env: { STUB_CHILD: pids } });
  assert.equal(run.code, 0, run.recordText);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a flooding CLI is capped instead of accumulated without bound', () => {
  const run = launch(fixture(), { env: { STUB_FLOOD: '1' } });
  assert.equal(run.code, 0, run.recordText);
  assert.equal(run.record.observed.session, 'stub-thread', 'the events still parse');
  assert.ok(run.meta.length < (4 << 20) + 4096, `captured ${run.meta.length} bytes of a 5 MiB flood`);
  assert.ok(run.meta.endsWith('\n[stream truncated]\n'));
});

test('a signal to the helper stops its detached group instead of orphaning it', async () => {
  const f = fixture();
  const pids = join(f.root, 'pids');
  const [argv, options] = launchSpec(f, { env: { STUB_CHILD: pids, STUB_SLEEP: '1' } });
  const helper = spawn('node', argv, options);
  const deadline = Date.now() + 10000;
  while (!existsSync(pids) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  helper.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => helper.on('exit', (...ended) => resolve(ended)));
  assert.ok(code === 143 || signal === 'SIGTERM', `the helper ended as ${code} / ${signal}`);
  assertGone(readFileSync(pids, 'utf8').split(' ').map(Number));
});

test('a probe that outlives its timeout is recorded as a timeout instead of launching on a missing answer', () => {
  for (const [expected, options] of [
    [/codex --version timed out after \d+s/, { env: { STUB_HANG: '--version' } }],
    [/git rev-parse timed out after \d+s/, { gitHang: 'rev-parse' }],
    [/git remote timed out after \d+s/, { gitHang: 'remote', provider: 'claude', role: 'writer', flags: { push: 'origin' } }],
  ]) {
    const f = fixture({ gitHang: options.gitHang });
    f.gitIn('remote', 'add', 'origin', join(f.root, 'remote.git'));
    const run = launch(f, { ...options, flags: { timeout: '1', ...options.flags } });
    assert.equal(run.code, 1, run.recordText);
    assert.equal(run.record.status, 'timeout');
    assert.match(run.recordText, expected);
    assert.equal(run.exec, undefined, 'no phase launches after a probe that never answered');
  }
});

test('a probe that expires after the phase stops the record claiming the phase completed', () => {
  const f = fixture({ gitHang: 'log' });
  const run = launch(f, { provider: 'claude', role: 'writer', env: { STUB_COMMIT: '1' }, flags: { timeout: '3' } });
  assert.equal(run.code, 1, run.recordText);
  assert.equal(run.record.status, 'timeout');
  assert.match(run.recordText, /git log timed out after \d+s/);
});

test('an artifact destination that cannot be written is refused before the phase, not after it', () => {
  const f = fixture();
  const run = launch(f, { flags: { output: f.repo } });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--output must name a file, not a directory/);
  assert.deepEqual(run.log, [], 'no phase runs for a destination whose write is already known to fail');
  assert.equal(launch(fixture(), { flags: { record: join(f.root, 'no-such-dir/record.json') } }).code, 2);
});

test('a head mismatch or dirty worktree refuses the launch', () => {
  const mismatch = launch(fixture(), { flags: { 'expected-head': '0'.repeat(40) } });
  assert.equal(mismatch.record.status, 'refused');
  assert.match(mismatch.record.blockers[0], /^head-mismatch: worktree HEAD [0-9a-f]{40} differs from expected 0{40}$/);
  assert.equal(mismatch.exec, undefined);
  const f = fixture();
  writeFileSync(join(f.repo, 'file.txt'), 'dirty');
  assert.match(launch(f).record.blockers[0], /^dirty-worktree/);
});

test('a writer edit, commit and push permission is checked before the launch, not only after it', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores the write bit, so a denial cannot be staged');
  const f = fixture();
  f.gitIn('remote', 'add', 'origin', join(f.root, 'remote.git'));
  // The remote is a path that does not exist, so the record reports the granted authority and leaves the transport open
  // rather than predicting a push the child could not complete.
  assert.deepEqual(launch(f, { provider: 'claude', role: 'writer', flags: { push: 'origin' } }).record.permissions,
    { edit: 'writable', commit: 'coordinator-required', push: 'granted-transport-unverified' });
  assert.equal(launch(f, { provider: 'claude', role: 'writer' }).record.permissions.push, 'not-granted');
  assert.equal(launch(f, { provider: 'claude', role: 'writer', flags: { push: 'absent' } }).record.permissions.push, 'no-such-remote');
  assert.equal(launch(f, { flags: { push: 'origin' } }).code, 2, 'a reviewer is never given push authority');
  const noCommit = fixture();
  chmodSync(join(noCommit.root, 'repo/.git'), 0o555);
  const run = launch(noCommit, { provider: 'claude', role: 'writer' });
  chmodSync(join(noCommit.root, 'repo/.git'), 0o755);
  assert.deepEqual(run.record.permissions, { edit: 'writable', commit: 'coordinator-required', push: 'not-granted' });
  assert.ok(run.exec, 'a writer that cannot commit still runs, because the coordinator commits for it');
  const noEdit = fixture();
  chmodSync(noEdit.repo, 0o555);
  const refused = launch(noEdit, { provider: 'claude', role: 'writer' });
  chmodSync(noEdit.repo, 0o755);
  assert.equal(refused.record.status, 'refused');
  assert.deepEqual(refused.record.blockers, ['writer-permission: the worktree is not writable, so the phase could produce no change']);
  assert.equal(refused.exec, undefined, 'no phase launches once the writer cannot change the worktree');
});

test('a denied push is reported as that operation, and writer commits are listed', () => {
  const denied = launch(fixture(), { provider: 'claude', role: 'writer', env: { STUB_DENY: '1' } });
  assert.deepEqual(denied.record.denied, ['push']);
  const committed = launch(fixture(), { provider: 'claude', role: 'writer', env: { STUB_COMMIT: '1' } });
  assert.equal(committed.record.commits.length, 1);
  assert.match(committed.record.commits[0].committer, /^Writer <w@x>$/);
});

test('a writer that leaves uncommitted changes completes, and the coordinator commit is attributed to the coordinator', () => {
  const f = fixture();
  const run = launch(f, { provider: 'claude', role: 'writer', env: { STUB_DIRTY: '1' } });
  assert.equal(run.code, 0, run.recordText);
  assert.deepEqual([run.record.status, run.record.commits, run.record.dirty_after, run.record.denied], ['completed', [], true, []]);
  f.gitIn('add', 'change.txt');
  f.gitIn('commit', '-qm', 'coordinator commit of the writer change');
  const sha = f.gitIn('rev-parse', 'HEAD');
  const record = join(f.root, 'record.json');
  const attribute = (commit) => spawnSync('node', [HELPER, 'attribute', '--record', record, '--operation', 'commit', '--sha', commit], { encoding: 'utf8' });
  assert.equal(attribute(sha).status, 0);
  const [entry] = JSON.parse(readFileSync(record, 'utf8')).coordinator;
  assert.deepEqual([entry.actor, entry.operation, entry.sha], ['coordinator', 'commit', sha]);
  f.gitIn('checkout', '-q', '--orphan', 'unrelated');
  f.gitIn('commit', '-qm', 'unrelated');
  const refused = attribute(f.gitIn('rev-parse', 'HEAD'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is not a commit descending from/);
});

test('both writers run, each only through the bounded worker, and the coordinator commits for them', () => {
  const f = fixture();
  const linked = join(f.root, 'linked');
  f.gitIn('worktree', 'add', '-q', linked, f.head);
  for (const provider of ['claude', 'codex']) {
    for (const worktree of [f.repo, linked]) {
      const run = launch(f, { provider, role: 'writer', env: { STUB_DIRTY: '1' }, flags: { worktree } });
      assert.deepEqual([run.code, run.record.permissions.commit, run.record.dirty_after], [0, 'coordinator-required', true], `${provider} ${worktree}: ${run.recordText}`);
      if (provider === 'claude') assert.ok(!/\b(?:Read|Edit|Write|Glob|Grep)\b/.test(run.exec.argv.join(' ')), 'no native file tool outside the worker');
      else {
        // A linked worktree's Git directories live outside it; both are granted read-only.
        const filesystem = run.exec.argv.find((arg) => arg.startsWith('permissions.bounded.filesystem='));
        for (const dir of f.gitIn('-C', worktree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').split('\n')) {
          assert.ok(filesystem.includes(`${JSON.stringify(dir)}="read"`), `${dir} in ${filesystem}`);
        }
      }
      f.gitIn('-C', worktree, 'clean', '-qfd');
    }
  }
});

test('a phase that rewrites the worktree\'s .git link is blocked before any Git command trusts it', () => {
  const f = fixture();
  const linked = join(f.root, 'linked');
  f.gitIn('worktree', 'add', '-q', linked, f.head);
  for (const provider of ['claude', 'codex']) {
    const run = launch(f, { provider, role: 'writer', env: { STUB_GITLINK: join(f.root, 'planted') }, flags: { worktree: linked } });
    assert.equal(run.record.status, 'blocked', run.recordText);
    assert.match(run.record.blockers.join('\n'), /^git-metadata:/m);
    assert.equal(run.record.head_after, undefined, 'no Git command ran in the tampered worktree');
    writeFileSync(join(linked, '.git'), `gitdir: ${f.gitIn('-C', f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')}/worktrees/linked\n`);
  }
});

test('the bounded worker mounts no home directory or CLI login', () => {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-'));
  roots.push(root);
  const home = join(root, 'home');
  for (const dir of ['home/.local/bin', 'home/.nvm/v1/bin', 'home/.codex/bin', 'opt/tool/bin', 'opt/plain']) mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(home, join(root, 'home-link'));
  const path = ['home/.local/bin', 'home/.nvm/v1/bin', 'home/.codex/bin', 'opt/tool/bin', 'opt/plain', 'home', 'home-link', '', 'relative/bin']
    .map((dir) => (dir && dir !== 'relative/bin' ? join(root, dir) : dir)).join(':');
  assert.deepEqual(toolchainDirs(path, { HOME: home }).sort(), [join(root, 'home/.local/bin'), join(root, 'home/.nvm/v1'), join(root, 'home/.nvm/v1/bin'),
    join(root, 'opt/plain'), join(root, 'opt/tool'), join(root, 'opt/tool/bin')].sort());
});

const install = (file, content = '#!/bin/sh\n') => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); chmodSync(file, 0o755); return file; };

test('only the standalone installer\'s release directory inside the Codex login is resolved for a mount', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-release-'));
  roots.push(root);
  const home = join(root, 'home');
  const outside = install(join(root, 'opt/codex/bin/codex'));
  let links = 0;
  // A PATH directory holding only a `codex` link, as the standalone installer leaves ~/.local/bin/codex.
  const linked = (target) => { const dir = join(root, `path-${links++}`); mkdirSync(dir); symlinkSync(target, join(dir, 'codex')); return dir; };
  // (e): each case holds with CODEX_HOME unset (~/.codex) and set to a custom directory.
  for (const [login, env] of [[join(home, '.codex'), { HOME: home }], [join(root, 'custom'), { HOME: home, CODEX_HOME: join(root, 'custom') }]]) {
    const release = join(login, 'packages/standalone/releases/1.2.3-x86_64-unknown-linux-musl');
    install(join(release, 'bin/codex'));
    symlinkSync(release, join(login, 'packages/standalone/current'));
    for (const [path, expected] of [
      [linked(join(login, 'packages/standalone/current/bin/codex')), release], // (a) through links
      [join(release, 'bin'), release], // (a) directly
      [linked(outside), null], // (b)
      [`${linked(outside)}:${linked(join(release, 'bin/codex'))}`, null], // (b) a copy first on PATH
      [linked(install(join(login, 'bin/codex'))), null], // (c)
      [linked(install(join(login, 'sessions/bin/codex'))), null], // (d)
      [linked(install(join(release, 'nested/bin/codex'))), null], // (d)
    ]) assert.equal(resolveCodex(path, env).release, expected && realpathSync(expected), `${path} with ${JSON.stringify(env)}`);
  }
  assert.equal(resolveCodex(join(home, '.codex/packages/standalone/releases/1.2.3-x86_64-unknown-linux-musl/bin'),
    { HOME: home, CODEX_HOME: join(root, 'custom') }).release, null, 'only the login directory in use counts');
  assert.equal(resolveCodex(`${linked(outside)}:${join(home, '.codex/bin')}`, { HOME: home }).exe, realpathSync(outside), 'the first codex on PATH');
});

const filesystemOf = (argv) => Object.fromEntries([...argv.find((arg) => arg.startsWith('permissions.bounded.filesystem='))
  .matchAll(/"((?:[^"\\]|\\.)*)"="(read|write)"/g)].map(([, key, mode]) => [JSON.parse(`"${key}"`), mode]));

test('a Codex phase starts only after codex sandbox runs true under the phase\'s own permission profile', () => {
  const run = launch(fixture());
  assert.equal(run.code, 0, run.recordText);
  assert.deepEqual(run.log.map((entry) => entry.argv[0]), ['--version', 'sandbox', 'exec']);
  const profile = (argv) => argv.flatMap((arg, index) => (argv[index - 1] === '-c' && /^(?:default_permissions|permissions\.bounded\.)/.test(arg) ? ['-c', arg] : []));
  assert.equal(profile(run.exec.argv).length, 6);
  assert.deepEqual(run.log[1].argv, ['sandbox', ...profile(run.exec.argv), '--', 'true']);
  // The phase ignores user configuration, so the probe reads none: its CODEX_HOME is an empty directory of its own, removed afterwards.
  assert.ok(run.log[1].home !== run.exec.home && !existsSync(run.log[1].home), run.log[1].home);
  const claude = launch(fixture(), { provider: 'claude' });
  assert.deepEqual(claude.log.map((entry) => entry.argv[0]), ['--version', '-p'], 'a Claude phase keeps its bounded-shell probe only');
  for (const [env, quoted] of [
    [{ STUB_SANDBOX_EXIT: '2', STUB_SANDBOX_ERR: "error: unrecognized subcommand 'sandbox'\n\nUsage: codex [OPTIONS] [PROMPT]" }, "(error: unrecognized subcommand 'sandbox')"],
    [{ STUB_SANDBOX_EXIT: '1', STUB_SANDBOX_ERR: `WARNING: ${'w'.repeat(200)}\nWARNING: second\nbwrap: execvp /x/codex: No such file or directory` },
      `(WARNING: ${'w'.repeat(151)}; bwrap: execvp /x/codex: No such file or directory)`],
    [{ STUB_SANDBOX_EXIT: '1', STUB_SANDBOX_ERR: 'x'.repeat(200) }, `(${'x'.repeat(160)})`],
    [{ STUB_SANDBOX_EXIT: '3' }, '(exit 3)'],
  ]) {
    const refused = launch(fixture(), { env });
    assert.deepEqual([refused.code, refused.record.status, refused.exec], [1, 'refused', undefined], refused.recordText);
    assert.equal(refused.record.blockers.length, 1);
    assert.match(refused.record.blockers[0], /^bounded-tools: /);
    assert.ok(refused.record.blockers[0].includes(quoted), refused.record.blockers[0]);
  }
  const hung = launch(fixture(), { env: { STUB_HANG: 'sandbox' }, flags: { timeout: '1' } });
  assert.deepEqual([hung.code, hung.record.status, hung.exec], [1, 'timeout', undefined], hung.recordText);
  assert.match(hung.record.transport_failure, /^codex sandbox probe timed out after \d+s$/);
});

test('a fake codex under a fake CODEX_HOME runs with its release mounted, and is refused before the phase anywhere else in it', () => {
  for (const layout of ['standalone', 'login-bin', 'outside']) {
    const f = fixture();
    const login = join(f.home, '.codex');
    const release = join(login, 'packages/standalone/releases/9.9.9-x86_64-unknown-linux-musl');
    let target = join(f.bin, 'codex'); // (c) the existing fixture
    if (layout === 'standalone') { // (a)
      install(join(release, 'bin/codex'), STUB);
      symlinkSync(release, join(login, 'packages/standalone/current'));
      target = join(login, 'packages/standalone/current/bin/codex');
    } else if (layout === 'login-bin') target = install(join(login, 'bin/codex'), STUB); // (b)
    const local = join(f.home, '.local/bin');
    mkdirSync(local, { recursive: true });
    symlinkSync(target, join(local, 'codex'));
    const PATH = `${local}:${f.bin}:${process.env.PATH}`;
    const run = launch(f, { env: { PATH } });
    // Every Codex call starts the resolved binary itself, so an update that switches `current` mid-launch cannot swap it.
    for (const entry of run.log) assert.equal(entry.bin, realpathSync(target), `${layout} ${entry.argv[0]}`);
    if (layout === 'login-bin') {
      assert.deepEqual([run.code, run.record.status, run.exec, run.log.map((entry) => entry.argv[0])], [1, 'refused', undefined, ['--version', 'sandbox']]);
      assert.deepEqual(run.record.blockers, [run.record.blockers[0]]);
      assert.ok(run.record.blockers[0].startsWith('bounded-tools: ')
        && run.record.blockers[0].includes(`(bwrap: execvp ${realpathSync(target)}: No such file or directory)`), run.record.blockers[0]);
      continue;
    }
    assert.deepEqual([run.code, run.record.status], [0, 'completed'], `${layout}: ${run.recordText}`);
    // The table develop builds, plus exactly one read-only entry for the standalone release; the scratch directory varies per run.
    const table = filesystemOf(run.exec.argv);
    for (const [key, mode] of Object.entries(table)) if (mode === 'write') delete table[key];
    assert.deepEqual(table, { ':minimal': 'read', ...Object.fromEntries(toolchainDirs(PATH, { HOME: f.home, CODEX_HOME: login }).map((dir) => [dir, 'read'])),
      ':workspace_roots': 'read', [join(realpathSync(f.repo), '.git')]: 'read', ...(layout === 'standalone' ? { [realpathSync(release)]: 'read' } : {}) }, layout);
  }
});

test('a relative or empty PATH component never selects codex, and a phase with no other codex is refused before any call', () => {
  const f = fixture();
  // PATH holds only these links besides the components under test, so no host codex can answer.
  const tools = join(f.root, 'tools');
  const other = join(f.root, 'other');
  mkdirSync(tools);
  install(join(other, 'codex'), STUB);
  for (const [name, file] of [['git', GIT], ['node', process.execPath]]) symlinkSync(file, join(tools, name));
  // `bin` and the empty component both name the fixture's stub through the working directory.
  for (const [PATH, cwd] of [[`bin:${tools}`, f.root], [`:${tools}`, f.bin], [`bin:${other}:${tools}`, f.root], [`:${other}:${tools}`, f.bin]]) {
    rmSync(join(f.root, 'stub.log'), { force: true });
    const [argv, options] = launchSpec(f, { env: { PATH } });
    const result = spawnSync('node', argv, { ...options, cwd });
    const record = JSON.parse(readFileSync(join(f.root, 'record.json'), 'utf8'));
    const log = existsSync(join(f.root, 'stub.log')) ? readFileSync(join(f.root, 'stub.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (PATH.includes(other)) {
      assert.deepEqual([result.status, record.status], [0, 'completed'], `${PATH}: ${JSON.stringify(record)}`);
      assert.deepEqual(log.map((entry) => [entry.argv[0], entry.bin]), ['--version', 'sandbox', 'exec'].map((call) => [call, realpathSync(join(other, 'codex'))]), PATH);
    } else {
      assert.deepEqual([result.status, record.status, log], [1, 'refused', []], `${PATH}: ${JSON.stringify(record)}`);
      assert.deepEqual(record.blockers, ['codex: no executable codex in an absolute PATH directory; check the installed CLI']);
    }
  }
});

// The real boundary, with synthetic markers only: a credential file and an environment marker outside the worker, and an
// edit, a diff and a check inside it. Skipped where unprivileged namespaces or bubblewrap are unavailable.
test('the bounded shell hides the caller\'s credentials and environment, and confines writes to the worktree', (t) => {
  if (spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']).status !== 0) return t.skip('bubblewrap or user namespaces unavailable');
  const f = fixture();
  const login = join(f.home, '.claude');
  mkdirSync(login);
  writeFileSync(join(login, '.credentials.json'), '{"synthetic":"LOGIN-MARKER-41c2"}');
  const scratch = mkdtempSync(join(tmpdir(), 'bounded-scratch-'));
  roots.push(scratch);
  const shell = (mode, command) => spawnSync(BOUNDED_SHELL, [command], { cwd: f.repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.home,
    SYNTHETIC_PROVIDER_TOKEN: 'ENV-MARKER-9d1e', BOUNDED_WORKTREE: f.repo, BOUNDED_MODE: mode, BOUNDED_SCRATCH: scratch, BOUNDED_PATH: process.env.PATH,
    BOUNDED_GIT: f.gitIn('rev-parse', '--path-format=absolute', '--git-common-dir') } });
  const probe = shell('write', `cat ${join(login, '.credentials.json')}; env; cat /proc/*/environ; ls /proc; echo edited > file.txt; git diff --stat; test "$(cat file.txt)" = edited && echo CHECKED`);
  const seen = probe.stdout + probe.stderr;
  for (const marker of ['LOGIN-MARKER-41c2', 'ENV-MARKER-9d1e']) assert.ok(!seen.includes(marker), `${marker} reached the worker`);
  assert.match(probe.stdout, /file\.txt \| 2 \+-/);
  assert.match(probe.stdout, /CHECKED/);
  assert.equal(readFileSync(join(f.repo, 'file.txt'), 'utf8'), 'edited\n');
  for (const [mode, command] of [['read', 'echo x > file.txt'], ['write', 'echo x > .git/planted'], ['write', `echo x > ${join(f.home, 'outside')}`]]) {
    assert.notEqual(shell(mode, command).status, 0, `${mode}: ${command}`);
  }
  assert.ok(!existsSync(join(f.repo, '.git/planted')) && !existsSync(join(f.home, 'outside')));
  assert.equal(readFileSync(join(f.repo, 'file.txt'), 'utf8'), 'edited\n');
});

test('a role child receives no coordinator session variable, and a Claude child keeps only its login and provider variables', () => {
  const names = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_COMPANION_SESSION_ID'];
  const sentinels = Object.fromEntries(names.map((name) => [name, `sentinel:${name}`]));
  for (const provider of ['codex', 'claude']) {
    for (const role of ['reviewer', 'writer']) {
      const run = launch(fixture(), { provider, role, env: sentinels });
      assert.equal(run.code, 0, run.recordText);
      assert.ok(run.log.length >= 2, 'the version probe and the phase');
      for (const entry of run.log) {
        assert.deepEqual(entry.session, provider === 'claude'
          ? { CLAUDE_CODE_OAUTH_TOKEN: true, CLAUDE_CODE_USE_BEDROCK: true, CLAUDE_CONFIG_DIR: true } : {}, `${provider} ${role} ${entry.argv[0]}`);
      }
    }
  }
});

test('a Claude report loses exactly one outer fence, and any other wrapper or missing result blocks', () => {
  const body = '# Review\n\n```js\ninner();\n```\n\n| a |\n';
  for (const [phase, result, expected] of [
    ['review', body, body], ['closing-review', `\n\`\`\`markdown\n${body}\`\`\`\n`, `\n${body}`], ['final-review', `~~~~md\n${body}~~~~~\n`, body],
    ['review', ` \`\`\`markdown\n${body}   \`\`\`\n`, body],
    ['writer', `\`\`\`\n${body}\`\`\``, body], ['closing-writer', '```markdown\n ```\n# Review\n ```\n```\n', /two code fences/],
    ['review', `\`\`\`text\n${body}\`\`\`\n`, /unrecognised code fence/], ['review', `\`\`\`\n${body}`, /unrecognised code fence/],
    ['review', `\`\`\`\`\n${body}\`\`\`\n`, /unrecognised code fence/], ['review', `~~~\n${body}\`\`\`\n`, /unrecognised code fence/],
    ['review', null, /missing or not a string/], ['writer', 'absent', /missing or not a string/],
  ]) {
    const run = launch(fixture(), { provider: 'claude', role: phase.endsWith('writer') ? 'writer' : 'reviewer', phase,
      env: { STUB_RESULT: result === 'absent' ? 'absent' : JSON.stringify(result) } });
    if (typeof expected === 'string') assert.deepEqual([run.code, run.record.status, run.report], [0, 'completed', expected], JSON.stringify(result));
    else { assert.deepEqual([run.code, run.record.status, run.report], [1, 'blocked', ''], JSON.stringify(result)); assert.match(run.record.blockers.join('\n'), expected); }
    assert.equal(JSON.parse(run.output).session_id, 'stub-claude', '--output still carries the raw result');
  }
  const codex = launch(fixture(), { phase: 'review' });
  assert.deepEqual([codex.code, codex.report], [0, 'OK\n'], 'a Codex report is its last message, as human-mode stdout carried it');
  assert.equal(launch(fixture(), { provider: 'claude', flags: { report: undefined } }).code, 2, 'a phase without --report is a usage error');
});

// ---- Token usage (issue #46). Test names start with the acceptance case they evidence. ----

const claudeCounts = (over = {}) => JSON.stringify({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, ...over });
const codexCounts = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 };
const THREAD = { type: 'thread.started', thread_id: 'stub-thread' };
const events = (...list) => ({ STUB_EVENTS: JSON.stringify(list) });

test('AC1.a a Claude phase that ran to its end records modelUsage counts and total_cost_usd, reasoning only when reported', () => {
  const run = launch(fixture(), { provider: 'claude', env: { STUB_USAGE: claudeCounts({ inputTokens: 12, outputTokens: 18000,
    cacheReadInputTokens: 1100000, cacheCreationInputTokens: 140000, thinkingTokens: 6000, costUSD: 0.5 }), STUB_COST: '0.5' } });
  assert.deepEqual([run.code, run.record.status, 'usage_reason' in run.record], [0, 'completed', false], run.recordText);
  // input counts cache reads and writes as well.
  assert.deepEqual(run.record.usage, { input: 1240012, cached_input: 1100000, cache_write: 140000, output: 18000, reasoning: 6000, cost_usd: 0.5,
    source: 'claude:modelUsage' });
  // A blocked phase (two models) keeps its usage, summed over both entries, and has no reasoning without thinking tokens.
  const blocked = launch(fixture(), { provider: 'claude', env: { STUB_USAGE: claudeCounts(), STUB_COST: '0.25', STUB_MULTIPLE: '1' } });
  assert.deepEqual([blocked.code, blocked.record.status], [1, 'blocked']);
  assert.deepEqual(blocked.record.usage, { input: 16, cached_input: 6, cache_write: 8, output: 4, cost_usd: 0.25, source: 'claude:modelUsage' });
});

test('AC1.b a Claude result without counts or cost, or with an invalid count, records null usage with a reason and the same status', () => {
  const plain = launch(fixture(), { provider: 'claude' });
  assert.deepEqual([plain.code, plain.record.status, plain.record.usage, plain.record.usage_reason], [0, 'completed', null, 'not-reported']);
  for (const [env, reason] of [
    [{ STUB_USAGE: claudeCounts() }, 'not-reported'],
    [{ STUB_COST: '0.1' }, 'not-reported'],
    [{ STUB_USAGE: claudeCounts({ outputTokens: undefined }), STUB_COST: '0.1' }, 'malformed'],
    [{ STUB_USAGE: claudeCounts({ outputTokens: 1.5 }), STUB_COST: '0.1' }, 'malformed'],
    [{ STUB_USAGE: claudeCounts({ inputTokens: -1 }), STUB_COST: '0.1' }, 'malformed'],
    [{ STUB_USAGE: claudeCounts({ cacheReadInputTokens: '3' }), STUB_COST: '0.1' }, 'malformed'],
    [{ STUB_USAGE: claudeCounts({ thinkingTokens: -2 }), STUB_COST: '0.1' }, 'malformed'],
    [{ STUB_USAGE: claudeCounts(), STUB_COST: '"0.1"' }, 'malformed'],
  ]) {
    const run = launch(fixture(), { provider: 'claude', env });
    assert.deepEqual([run.code, run.record.status, run.record.usage, run.record.usage_reason], [plain.code, plain.record.status, null, reason], JSON.stringify(env));
  }
});

test('AC1.d a phase refused before its CLI starts records usage null with not-run', () => {
  const dirty = fixture();
  writeFileSync(join(dirty.repo, 'file.txt'), 'dirty');
  for (const [f, options, blocker] of [
    [fixture(), { flags: { 'expected-head': '0'.repeat(40) } }, /^head-mismatch: /],
    [dirty, { provider: 'claude' }, /^dirty-worktree: /],
    [fixture(), { provider: 'claude', env: { STUB_VERSION_FAIL: '1' } }, /version probe failed/],
    [fixture(), { env: { STUB_SANDBOX_EXIT: '1' } }, /^bounded-tools: codex sandbox/],
  ]) {
    const run = launch(f, options);
    assert.deepEqual([run.code, run.record.status, run.exec, run.record.usage, run.record.usage_reason], [1, 'refused', undefined, null, 'not-run'], run.recordText);
    assert.match(run.record.blockers[0], blocker);
  }
});

test('AC1.e a failed or timed-out phase records the usage its output reports, else null with a reason', () => {
  for (const [provider, env, status, usage] of [
    ['codex', { STUB_EXIT: '1' }, 'failed', 1240000],
    ['codex', { STUB_SLEEP: '1' }, 'timeout', 1240000],
    ['codex', { STUB_HANG: 'exec' }, 'timeout', null],
    ['claude', { STUB_USAGE: claudeCounts(), STUB_COST: '0.01', STUB_SUBTYPE: 'error_during_execution' }, 'failed', 8],
    ['claude', { STUB_FAIL: '1' }, 'failed', null],
    ['claude', { STUB_USAGE: claudeCounts(), STUB_COST: '0.01', STUB_SLEEP: '1' }, 'timeout', 8],
    ['claude', { STUB_HANG: '-p' }, 'timeout', null],
  ]) {
    const run = launch(fixture(), { provider, env, flags: { timeout: '2' } });
    assert.deepEqual([run.record.status, run.record.usage?.input ?? null, run.record.usage_reason], [status, usage, usage ? undefined : 'not-reported'],
      `${provider} ${JSON.stringify(env)}: ${run.recordText}`);
  }
});

test('AC2.a AC5.b the Codex exec argv is the earlier one plus --json and -o, and the sandbox probe argv is unchanged', () => {
  for (const flags of [{}, { model: 'chosen-model', effort: 'high' }]) {
    const f = fixture();
    const [, options] = launchSpec(f);
    const run = launch(f, { flags });
    assert.equal(run.code, 0, run.recordText);
    const { argv } = run.exec;
    const scratch = Object.entries(filesystemOf(argv)).find(([dir, mode]) => mode === 'write' && !dir.startsWith(':'))[0];
    const table = [[':minimal', 'read'], ...toolchainDirs(options.env.PATH, options.env).map((dir) => [dir, 'read']), [':workspace_roots', 'read'],
      [scratch, 'write'], [join(realpathSync(f.repo), '.git'), 'read']].map(([dir, mode]) => `${JSON.stringify(dir)}=${JSON.stringify(mode)}`).join(', ');
    const profile = ['-c', 'default_permissions="bounded"', '-c', `permissions.bounded.filesystem={${table}}`, '-c', 'permissions.bounded.network.enabled=false'];
    // The launch at ee0b084, followed by the two options this change adds.
    const earlier = ['exec', '--color', 'never', '-C', f.repo, '--ignore-user-config', '--ignore-rules',
      ...(flags.model ? ['-m', 'chosen-model', '-c', 'model_reasoning_effort="high"'] : ['-c', 'model="configured-model"']), ...profile,
      '-c', 'shell_environment_policy.inherit="none"', '-c', `shell_environment_policy.set={"PATH"=${JSON.stringify(options.env.PATH)}, "LANG"="C.UTF-8", `
        + `"HOME"=${JSON.stringify(scratch)}, "TMPDIR"=${JSON.stringify(scratch)}}`, '-c', 'approval_policy="never"', '--ephemeral', '-'];
    assert.deepEqual(argv, [...earlier.slice(0, -2), '--json', '-o', argv[argv.indexOf('-o') + 1], '--ephemeral', '-']);
    assert.deepEqual(run.log[1].argv, ['sandbox', ...profile, '--', 'true']);
  }
});

test('AC5.a the Claude argv and environment for a request are those at ee0b084', () => {
  for (const [role, flags] of [['reviewer', {}], ['writer', { model: 'chosen-model', effort: 'high' }]]) {
    const f = fixture();
    const [, options] = launchSpec(f, { provider: 'claude', role });
    const run = launch(f, { provider: 'claude', role, flags });
    assert.equal(run.code, 0, run.recordText);
    assert.deepEqual(run.exec.argv, ['-p', ...(flags.model ? ['--model', 'chosen-model', '--effort', 'high'] : []), '--permission-mode', 'dontAsk',
      '--allowedTools', 'Bash', '--no-session-persistence', '--setting-sources', 'user', '--output-format', 'json', '--tools', 'Bash',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
    const scratch = run.exec.worker.BOUNDED_SCRATCH;
    assert.deepEqual(run.exec.worker, { CLAUDE_CODE_SHELL_PREFIX: BOUNDED_SHELL, BOUNDED_WORKTREE: f.repo, BOUNDED_MODE: role === 'writer' ? 'write' : 'read',
      BOUNDED_SCRATCH: scratch, BOUNDED_READ: toolchainDirs(options.env.PATH, options.env).join('\n'), BOUNDED_GIT: join(realpathSync(f.repo), '.git'),
      BOUNDED_PATH: options.env.PATH, TMPDIR: scratch });
    assert.deepEqual(run.exec.keys, [...new Set([...Object.keys(options.env), ...Object.keys(run.exec.worker)])].sort(), 'no other variable is added');
  }
});

test('AC1.c AC2.b a Codex phase that ran to its end sums its well-formed turn.completed events', () => {
  assert.deepEqual(launch(fixture()).record.usage, { input: 1240000, cached_input: 1100000, cache_write: 0, output: 18000, reasoning: 6000,
    cost_usd: null, source: 'codex:turn.completed' });
  const turn = (input, reasoning) => ({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: 1, cache_write_input_tokens: 2,
    output_tokens: 3, ...(reasoning === undefined ? {} : { reasoning_output_tokens: reasoning }) } });
  assert.deepEqual(launch(fixture(), { env: events(THREAD, turn(10, 4), { type: 'turn.started' }, turn(20, 5)) }).record.usage,
    { input: 30, cached_input: 2, cache_write: 4, output: 6, reasoning: 9, cost_usd: null, source: 'codex:turn.completed' });
  assert.deepEqual(launch(fixture(), { env: events(THREAD, turn(10)) }).record.usage,
    { input: 10, cached_input: 1, cache_write: 2, output: 3, cost_usd: null, source: 'codex:turn.completed' });
});

test('AC1.c AC2.c no turn.completed is not-reported; a non-object line or an invalid count is malformed; neither changes the status', () => {
  const turn = (usage) => ({ type: 'turn.completed', usage: { ...codexCounts, ...usage } });
  for (const [list, reason] of [
    [[THREAD], 'not-reported'],
    [[THREAD, 'not json', turn()], 'malformed'],
    [[THREAD, '[1,2]', turn()], 'malformed'],
    [[THREAD, '', turn()], 'malformed'],
    [[THREAD, { type: 'turn.completed' }], 'malformed'],
    [[THREAD, turn({ output_tokens: undefined })], 'malformed'],
    [[THREAD, turn({ input_tokens: 1.5 })], 'malformed'],
    [[THREAD, turn({ cached_input_tokens: -1 })], 'malformed'],
    [[THREAD, turn({ reasoning_output_tokens: '7' })], 'malformed'],
  ]) {
    const run = launch(fixture(), { env: events(...list) });
    assert.deepEqual([run.code, run.record.status, run.record.usage, run.record.usage_reason], [0, 'completed', null, reason], JSON.stringify(list));
  }
});

test('AC2.d events after more than 4 MiB of earlier stdout are still read', () => {
  const run = launch(fixture(), { env: { STUB_STDOUT_FLOOD: '1' } });
  assert.equal(run.code, 0, run.recordText.slice(0, 2000));
  assert.ok(run.output.endsWith('\n[stream truncated]\n') && !run.output.includes('turn.completed'), 'the capture itself dropped the events');
  assert.deepEqual([run.record.usage?.input, run.record.observed.session], [1240000, 'stub-thread']);
});

test('AC2.e the report is the -o file plus one newline; an empty or missing file writes no report and blocks', () => {
  const message = '# Review\n\n| a | b |\n\nü — ✓\n';
  assert.deepEqual([launch(fixture(), { env: { STUB_LAST: message } }).report], [`${message}\n`]);
  for (const last of ['', 'absent']) {
    const f = fixture();
    const run = launch(f, { env: { STUB_LAST: last } });
    assert.deepEqual([run.code, run.record.status, existsSync(join(f.root, 'report.md'))], [1, 'blocked', false], last);
    assert.deepEqual(run.record.blockers, ['report: the Codex last-message file is missing, empty or not a regular file']);
  }
});

test('AC2.f the -o file lies in a directory the helper creates outside every worker mount, and only a regular file is read', () => {
  const f = fixture();
  const run = launch(f);
  const { argv } = run.exec;
  const dir = dirname(argv[argv.indexOf('-o') + 1]);
  for (const mount of [f.repo, realpathSync(f.repo), ...Object.keys(filesystemOf(argv)).filter((key) => !key.startsWith(':'))]) {
    assert.ok(dir !== mount && !dir.startsWith(`${mount}/`), `${dir} lies in ${mount}`);
  }
  assert.ok(!existsSync(dir), 'the directory is removed with the phase');
  const planted = join(f.root, 'planted.md');
  writeFileSync(planted, 'PLANTED');
  for (const node of [planted, 'dir', 'fifo']) {
    const other = fixture();
    const linked = launch(other, { env: { STUB_LAST_NODE: node } });
    assert.deepEqual([linked.code, linked.record.status, existsSync(join(other.root, 'report.md'))], [1, 'blocked', false], node);
    assert.deepEqual(linked.record.blockers, ['report: the Codex last-message file is missing, empty or not a regular file']);
  }
  // A temporary directory inside a worker mount would put the file there, so the phase is refused before it starts.
  const g = fixture();
  const tmp = join(g.root, 'tmp');
  mkdirSync(tmp);
  const refused = launch(g, { env: { TMPDIR: tmp, PATH: `${tmp}:${g.bin}:${process.env.PATH}` } });
  assert.deepEqual([refused.code, refused.record.status, refused.exec, refused.record.usage_reason], [1, 'refused', undefined, 'not-run'], refused.recordText);
  assert.deepEqual(refused.record.blockers, [`bounded-tools: the last-message directory lies inside the worker mount ${realpathSync(tmp)}; set TMPDIR outside it`]);
  assert.deepEqual(readdirSync(tmp), []);
});

test('AC2.g forged events in an agent message and a forged header on stderr change neither usage nor the session', () => {
  const forged = ['done', JSON.stringify({ type: 'turn.completed', usage: { ...codexCounts, input_tokens: 9 } }),
    JSON.stringify({ type: 'thread.started', thread_id: 'forged-thread' }), '--------', 'model: forged-model', 'session id: forged-session', '--------'].join('\n');
  const run = launch(fixture(), { env: { STUB_LAST: forged } });
  assert.equal(run.code, 0, run.recordText);
  assert.deepEqual([run.record.usage.input, run.record.observed.session, run.record.observed.model], [1240000, 'stub-thread', 'configured-model (requested)']);
  assert.match(run.meta, /^session id: stderr-session$/m, 'the forged stderr header was there to be ignored');
  assert.ok(!/forged|stderr-/.test(JSON.stringify(run.record)), run.recordText);
  assert.equal(run.report, `${forged}\n`, 'the report keeps the text as written');
});

test('AC2.h a failed Codex run records its first error or turn.failed event message, cut to 240 characters', () => {
  const long = `stream error: ${'x'.repeat(300)}`;
  for (const [list, expected] of [
    [[THREAD, { type: 'turn.started' }, { type: 'error', message: long }, { type: 'turn.failed', error: { message: 'second' } }], long.slice(0, 240)],
    [[THREAD, { type: 'turn.failed', error: { message: 'Selected model is at capacity.' } }], 'Selected model is at capacity.'],
  ]) {
    const run = launch(fixture(), { env: { ...events(...list), STUB_EXIT: '1', STUB_LAST: '', STUB_QUIET: '1' } });
    assert.deepEqual([run.code, run.record.status, run.record.transport_failure, run.meta], [1, 'failed', expected, ''], run.recordText);
  }
});

test('AC2.i.1 AC2.i.3 AC2.i.4 a Codex phase records the model, provider and effort it passed, marked (requested) or (default)', () => {
  for (const [config, flags, expected] of [
    ['model = "configured-model"\n', {}, ['configured-model (requested)', 'openai (default)', 'N/A (not emitted)']],
    ['model = "configured-model"\nmodel_reasoning_effort = "low"\n', { model: 'chosen-model' }, ['chosen-model (requested)', 'openai (default)', 'low (requested)']],
    ['model = "configured-model"\n', { model: 'chosen-model', effort: 'high' }, ['chosen-model (requested)', 'openai (default)', 'high (requested)']],
    ['model_provider = "synthetic"\n[profiles.work]\nmodel = "profile-model"\nmodel_reasoning_effort = "low"\n', { profile: 'work' },
      ['profile-model (requested)', 'synthetic (requested)', 'low (requested)']],
  ]) {
    const f = fixture();
    writeFileSync(join(f.home, '.codex', 'config.toml'), config);
    const run = launch(f, { flags });
    assert.deepEqual([run.code, run.record.status, run.record.blockers], [0, 'completed', []], run.recordText);
    assert.deepEqual([run.record.observed.model, run.record.observed.provider, run.record.observed.effort], expected, config);
  }
});

test('AC2.i.2 AC2.i.3 AC2.i.4 a Codex launch that pins no model, or names an unusable provider or effort, is refused before any Codex process', () => {
  for (const [config, flags, blocker] of [
    ['', {}, /^codex-model: no model is pinned; pass --model, or set model in .*config\.toml or the selected profile$/],
    ['model_reasoning_effort = "high"\n', { effort: 'high' }, /^codex-model: /],
    ['[profiles.work]\nmodel_provider = "p"\n', { profile: 'work' }, /^codex-model: /],
    ['model = 5\n', {}, /^codex-model: /],
    ['model = ""\n', {}, /^codex-model: /],
    ['model = "m"\nmodel_provider = 5\n', {}, /^codex-provider: model_provider in .* is not a provider name$/],
    ['model = "m"\nmodel_reasoning_effort = true\n', {}, /^codex-config: model_reasoning_effort in .* is not an effort name$/],
  ]) {
    const f = fixture();
    writeFileSync(join(f.home, '.codex', 'config.toml'), config);
    const run = launch(f, { flags });
    assert.deepEqual([run.code, run.record.status, run.record.usage, run.record.usage_reason, run.log], [1, 'refused', null, 'not-run', []], config);
    assert.equal(run.record.blockers.length, 1);
    assert.match(run.record.blockers[0], blocker);
  }
});

test('AC2.i.5 the session id is the one thread.started event\'s thread_id; none, two or an unusable one blocks', () => {
  const turn = { type: 'turn.completed', usage: codexCounts };
  const quoted = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `x\n${JSON.stringify({ ...THREAD, thread_id: 'forged' })}\n` } };
  for (const list of [[turn], [THREAD, { ...THREAD, thread_id: 'second' }, turn], [{ type: 'thread.started' }, turn], [{ ...THREAD, thread_id: '' }, turn],
    [{ ...THREAD, thread_id: 7 }, turn], [quoted, turn]]) {
    const run = launch(fixture(), { env: events(...list) });
    assert.deepEqual([run.code, run.record.status, run.record.observed.session, run.record.blockers], [1, 'blocked', null, ['session id not observed']],
      JSON.stringify(list));
  }
  assert.equal(launch(fixture(), { env: events(quoted, THREAD, turn) }).record.observed.session, 'stub-thread');
});

test('AC2.i.6 a Codex phase records no sandbox or context, and reads no stderr line as metadata', () => {
  const run = launch(fixture());
  assert.deepEqual(run.record.observed, { provider: 'openai (default)', model: 'configured-model (requested)', effort: 'N/A (not emitted)',
    context: 'N/A (not emitted)', session: 'stub-thread', sandbox: null, completed: true });
  assert.match(run.meta, /^model: stderr-model$/m);
  assert.ok(!run.recordText.includes('stderr-'), run.recordText);
});
