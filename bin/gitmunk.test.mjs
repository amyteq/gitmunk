// Tests for the installer. They never reach a real claude, codex or npm: every run gets a PATH that holds only
// stub programs, and HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and the working directory are temporary folders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODEX_ROOT_LATER, USAGE, main, plan, settingsFile } from './gitmunk.mjs';

const BIN = fileURLToPath(new URL('./gitmunk.mjs', import.meta.url));
const BETA = 'https://raw.githubusercontent.com/amyteq/gitmunk/develop/channels/beta/.claude-plugin/marketplace.json';
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

// A stub logs its argv as one JSON line; `codex plugin list --json` lists dev-skills once `codex plugin add` ran.
// STUB_FAIL names one command line that exits 7.
function stubSource(name) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = [${JSON.stringify(name)}, ...process.argv.slice(2)];
const state = process.env.STUB_STATE;
fs.appendFileSync(path.join(state, 'calls.log'), JSON.stringify(argv) + '\\n');
const line = argv.join(' ');
const installed = path.join(state, 'codex-installed');
if (line === 'codex plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: fs.existsSync(installed) ? [{ pluginId: 'dev-skills@gitmunk', version: '0.2.0', installed: true }] : [] }));
}
if (line === 'codex plugin add dev-skills@gitmunk') fs.writeFileSync(installed, '');
process.exit(line === process.env.STUB_FAIL ? 7 : 0);
`;
}

function sandbox({ stubs = ['claude', 'codex', 'npm'], codexHome = 'codex' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gitmunk-installer-'));
  roots.push(root);
  const dirs = { bin: join(root, 'bin'), state: join(root, 'state'), home: join(root, 'home'), cwd: join(root, 'project') };
  Object.values(dirs).forEach((dir) => mkdirSync(dir));
  for (const name of stubs) writeFileSync(join(dirs.bin, name), stubSource(name), { mode: 0o755 });
  const env = {
    PATH: dirs.bin,
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: join(dirs.home, 'claude'),
    CODEX_HOME: join(dirs.home, codexHome),
    STUB_STATE: dirs.state,
  };
  const output = [];
  const errors = [];
  return {
    ...dirs,
    env,
    output,
    errors,
    codexRoot: join(env.CODEX_HOME, 'plugins', 'cache', 'gitmunk', 'dev-skills', '0.2.0'),
    calls() {
      const log = join(dirs.state, 'calls.log');
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    },
    run(argv, io = {}) {
      return main(argv, { env, cwd: dirs.cwd, isTTY: false, out: (line) => output.push(line), err: (line) => errors.push(line), ...io });
    },
  };
}

const LIST = ['codex', 'plugin', 'list', '--json'];
const header = (box) => box.output.find((line) => line.startsWith('gitmunk installer:'));
const stableUser = (box) => [
  ['claude', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk#main', '--scope', 'user'],
  ['claude', 'plugin', 'install', 'dev-skills@gitmunk', '--scope', 'user'],
  ['codex', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk', '--ref', 'main'],
  ['codex', 'plugin', 'add', 'dev-skills@gitmunk'],
  LIST,
  ['npm', 'ci', '--prefix', box.codexRoot],
];
const argvOf = (steps) => steps.map((step) => step.argv ?? ['set', step.file, step.key]);

// AC1
test('AC1(a) package.json maps bin gitmunk, is private and has no version or dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { gitmunk: 'bin/gitmunk.mjs' });
  assert.equal(pkg.private, true);
  for (const key of ['version', 'dependencies', 'devDependencies']) assert.equal(key in pkg, false, key);
});

test('AC1(b) --help exits 0 and lists every flag', () => {
  const box = sandbox();
  const result = spawnSync(process.execPath, [BIN, '--help'], { env: box.env, cwd: box.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--channel', '--scope', '--agents', '--with-hooks', '--yes', '--dry-run', '--help']) assert.match(result.stdout, new RegExp(`${flag}\\b`));
  assert.deepEqual(box.calls(), []);
});

// AC2
test('AC2(a) defaults: stable, user, every agent found', async () => {
  const box = sandbox();
  assert.equal(await box.run(['--dry-run', '--yes']), 0);
  assert.equal(header(box), 'gitmunk installer: channel stable, scope user, agents claude, codex');
});

test('AC2(b) only the agents found on PATH', async () => {
  const claudeOnly = sandbox({ stubs: ['claude'] });
  assert.equal(await claudeOnly.run(['--dry-run', '--yes']), 0);
  assert.equal(header(claudeOnly), 'gitmunk installer: channel stable, scope user, agents claude');
  const codexOnly = sandbox({ stubs: ['codex'] });
  assert.equal(await codexOnly.run(['--dry-run', '--yes']), 0);
  assert.equal(header(codexOnly), 'gitmunk installer: channel stable, scope user, agents codex');
});

test('AC2(c) neither CLI found: non-zero, names both, runs nothing', async () => {
  const box = sandbox({ stubs: [] });
  assert.notEqual(await box.run(['--dry-run', '--yes']), 0);
  assert.match(box.errors.join('\n'), /claude.*codex/s);
  assert.deepEqual(box.calls(), []);
});

test('AC2(d) a chosen agent missing from PATH: non-zero, runs nothing', async () => {
  const box = sandbox({ stubs: ['claude'] });
  assert.notEqual(await box.run(['--agents', 'codex', '--yes']), 0);
  assert.match(box.errors.join('\n'), /codex/);
  assert.deepEqual(box.calls(), []);
});

test('AC2(e) bad values and unknown flags: exit 2 with usage, nothing run', async () => {
  for (const argv of [['--channel', 'nightly'], ['--scope', 'global'], ['--agents', 'foo'], ['--agents', ''], ['--force'], ['extra']]) {
    const box = sandbox();
    assert.equal(await box.run([...argv, '--yes']), 2, argv.join(' '));
    assert.ok(box.errors.join('\n').includes(USAGE), argv.join(' '));
    assert.deepEqual(box.calls(), [], argv.join(' '));
  }
});

test('AC2(f) no --yes while stdin is not a TTY: non-zero, names --yes, nothing run', async () => {
  const box = sandbox();
  assert.notEqual(await box.run(['--dry-run']), 0);
  assert.match(box.errors.join('\n'), /--yes/);
  assert.deepEqual(box.calls(), []);
});

test('AC2(g) and AC5(a) scripted answers: three defaults, one confirmation', async () => {
  const box = sandbox();
  const questions = [];
  const answers = ['', '', '', 'y'];
  const prompt = async (question) => {
    questions.push(question);
    // The whole plan is printed before the confirmation, and no install step has run yet.
    if (question.startsWith('Run these')) {
      assert.ok(box.output.includes('Plan:'));
      assert.deepEqual(box.calls(), [LIST]);
    }
    return answers.shift();
  };
  assert.equal(await box.run([], { prompt, isTTY: true }), 0);
  assert.equal(questions.length, 4);
  assert.equal(questions.filter((q) => q.startsWith('Run these')).length, 1);
  assert.deepEqual(box.calls(), [LIST, ...stableUser(box)]);
});

test('AC2(g) answering n at the confirmation runs nothing', async () => {
  const box = sandbox();
  const answers = ['', '', '', 'n'];
  assert.equal(await box.run([], { prompt: async () => answers.shift(), isTTY: true }), 0);
  assert.deepEqual(box.calls(), [LIST]);
  assert.ok(box.output.includes('Nothing changed.'));
});

test('AC5(a) flags answer the questions, so only the confirmation is asked', async () => {
  const box = sandbox();
  const questions = [];
  const prompt = async (question) => (questions.push(question), 'n');
  assert.equal(await box.run(['--channel', 'beta', '--scope', 'local', '--agents', 'claude'], { prompt }), 0);
  assert.deepEqual(questions, ['Run these 3 steps? [Y/n]: ']);
});

// AC3
for (const scope of ['user', 'project', 'local']) {
  const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' };
  test(`AC3(a) stable Claude Code steps at ${scope} scope`, () => {
    const { steps } = plan({ channel: 'stable', scope, agents: ['claude'], env, cwd: '/p' });
    assert.deepEqual(argvOf(steps), [
      ['claude', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk#main', '--scope', scope],
      ['claude', 'plugin', 'install', 'dev-skills@gitmunk', '--scope', scope],
    ]);
  });

  test(`AC3(b) beta Claude Code steps at ${scope} scope`, () => {
    const file = { user: '/cfg/settings.json', project: '/p/.claude/settings.json', local: '/p/.claude/settings.local.json' }[scope];
    const { steps } = plan({ channel: 'beta', scope, agents: ['claude'], env, cwd: '/p' });
    assert.deepEqual(argvOf(steps), [
      ['claude', 'plugin', 'marketplace', 'add', BETA, '--scope', scope],
      ['claude', 'plugin', 'install', 'dev-skills@gitmunk-beta', '--scope', scope],
      ['set', file, 'dev-skills@gitmunk'],
    ]);
  });

  test(`AC3(c) --with-hooks adds dev-hooks at ${scope} scope`, () => {
    const stable = plan({ channel: 'stable', scope, agents: ['claude'], withHooks: true, env, cwd: '/p' });
    assert.deepEqual(argvOf(stable.steps).slice(1), [
      ['claude', 'plugin', 'install', 'dev-skills@gitmunk', '--scope', scope],
      ['claude', 'plugin', 'install', 'dev-hooks@gitmunk', '--scope', scope],
    ]);
    const beta = plan({ channel: 'beta', scope, agents: ['claude'], withHooks: true, env, cwd: '/p' });
    assert.deepEqual(argvOf(beta.steps).slice(1), [
      ['claude', 'plugin', 'install', 'dev-skills@gitmunk-beta', '--scope', scope],
      ['claude', 'plugin', 'install', 'dev-hooks@gitmunk-beta', '--scope', scope],
      ['set', settingsFile(scope, env, '/p'), 'dev-skills@gitmunk'],
      ['set', settingsFile(scope, env, '/p'), 'dev-hooks@gitmunk'],
    ]);
    for (const channel of ['stable', 'beta']) {
      const without = plan({ channel, scope, agents: ['claude', 'codex'], env, cwd: '/p' });
      assert.ok(!JSON.stringify(without.steps).includes('dev-hooks'), channel);
    }
  });
}

test('AC3(b) user settings fall back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
  assert.equal(settingsFile('user', { HOME: '/h' }, '/p'), join('/h', '.claude', 'settings.json'));
});

// AC4
test('AC4(a) stable Codex steps when dev-skills is not installed', () => {
  const { steps } = plan({ channel: 'stable', scope: 'user', agents: ['codex'] });
  assert.deepEqual(argvOf(steps), [
    ['codex', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk', '--ref', 'main'],
    ['codex', 'plugin', 'add', 'dev-skills@gitmunk'],
    ['npm', 'ci', '--prefix', CODEX_ROOT_LATER],
  ]);
});

test('AC4(a) npm ci runs in the folder Codex reports after the add', async () => {
  const box = sandbox();
  assert.equal(await box.run(['--yes', '--agents', 'codex']), 0);
  assert.deepEqual(box.calls(), [LIST, ...stableUser(box).slice(2)]);
});

test('AC4(b) beta Codex steps use --ref develop', () => {
  const { steps } = plan({ channel: 'beta', scope: 'user', agents: ['codex'] });
  assert.deepEqual(steps[0].argv, ['codex', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk', '--ref', 'develop']);
  assert.deepEqual(steps[1].argv, ['codex', 'plugin', 'add', 'dev-skills@gitmunk']);
});

test('AC4(c) and AC6(d) an installed dev-skills is not added again; npm ci only without node_modules', async () => {
  const box = sandbox();
  writeFileSync(join(box.state, 'codex-installed'), '');
  assert.equal(await box.run(['--yes', '--agents', 'codex']), 0);
  assert.deepEqual(box.calls(), [LIST, ['codex', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk', '--ref', 'main'], ['npm', 'ci', '--prefix', box.codexRoot]]);

  const ready = sandbox();
  writeFileSync(join(ready.state, 'codex-installed'), '');
  mkdirSync(join(ready.codexRoot, 'node_modules'), { recursive: true });
  assert.equal(await ready.run(['--yes', '--agents', 'codex']), 0);
  assert.deepEqual(ready.calls(), [LIST, ['codex', 'plugin', 'marketplace', 'add', 'amyteq/gitmunk', '--ref', 'main']]);
});

test('AC4(d) project and local scope: no Codex step, one line on --scope user', async () => {
  for (const scope of ['project', 'local']) {
    const { steps, notes } = plan({ channel: 'stable', scope, agents: ['claude', 'codex'] });
    assert.ok(steps.every((step) => !step.argv || step.argv[0] !== 'codex' && step.argv[0] !== 'npm'), scope);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Codex.*per user.*--scope user/);
    const box = sandbox();
    assert.equal(await box.run(['--yes', '--scope', scope]), 0);
    assert.ok(box.calls().every(([program]) => program === 'claude'), scope);
    assert.ok(box.output.includes(notes[0]));
  }
});

test('AC4(e) --with-hooks adds no Codex step', () => {
  for (const channel of ['stable', 'beta']) {
    const plain = plan({ channel, scope: 'user', agents: ['codex'] });
    const hooks = plan({ channel, scope: 'user', agents: ['codex'], withHooks: true });
    assert.deepEqual(hooks, plain);
  }
});

// AC5
test('AC5(b) --dry-run runs no install command and writes no file', async () => {
  const box = sandbox();
  assert.equal(await box.run(['--dry-run', '--yes', '--channel', 'beta', '--with-hooks']), 0);
  assert.deepEqual(box.calls(), [LIST]);
  assert.equal(existsSync(join(box.env.CLAUDE_CONFIG_DIR, 'settings.json')), false);
  assert.ok(box.output.some((line) => line.includes(`set enabledPlugins["dev-hooks@gitmunk"] to false in ${join(box.env.CLAUDE_CONFIG_DIR, 'settings.json')}`)));
});

test('AC5(c) --yes runs the steps in plan order', async () => {
  const box = sandbox();
  assert.equal(await box.run(['--yes']), 0);
  assert.deepEqual(box.calls(), [LIST, ...stableUser(box)]);
  const planned = box.output.filter((line) => /^ {2}\d+\. /.test(line));
  assert.deepEqual(planned, [
    '  1. claude plugin marketplace add amyteq/gitmunk#main --scope user',
    '  2. claude plugin install dev-skills@gitmunk --scope user',
    '  3. codex plugin marketplace add amyteq/gitmunk --ref main',
    '  4. codex plugin add dev-skills@gitmunk',
    `  5. npm ci --prefix ${CODEX_ROOT_LATER}`,
  ]);
});

test('AC5(d) a failing step stops the run and names the command and its exit code', async () => {
  const box = sandbox();
  box.env.STUB_FAIL = 'claude plugin install dev-skills@gitmunk --scope user';
  assert.equal(await box.run(['--yes']), 1);
  assert.deepEqual(box.calls(), [LIST, ...stableUser(box).slice(0, 2)]);
  assert.match(box.errors.join('\n'), /claude plugin install dev-skills@gitmunk --scope user`? exited with 7/);
});

test('AC5(e) commands run without a shell: an argument with spaces and ; stays one argument', async () => {
  const box = sandbox({ codexHome: 'codex home; touch pwned' });
  assert.equal(await box.run(['--yes', '--agents', 'codex']), 0);
  assert.deepEqual(box.calls().at(-1), ['npm', 'ci', '--prefix', box.codexRoot]);
  assert.equal(existsSync(join(box.cwd, 'pwned')), false);
});

// AC6
const betaLocal = ['--yes', '--channel', 'beta', '--scope', 'local'];
const localFile = (box) => join(box.cwd, '.claude', 'settings.local.json');

test('AC6 a missing settings file is created with the stable ids set to false', async () => {
  const box = sandbox();
  assert.equal(await box.run([...betaLocal, '--with-hooks']), 0);
  assert.deepEqual(JSON.parse(readFileSync(localFile(box), 'utf8')), { enabledPlugins: { 'dev-skills@gitmunk': false, 'dev-hooks@gitmunk': false } });
});

test('AC6(a) a key already false leaves the file bytes unchanged', async () => {
  const box = sandbox();
  const text = '{"enabledPlugins":{"dev-skills@gitmunk":false},  "note": 1}';
  mkdirSync(join(box.cwd, '.claude'));
  writeFileSync(localFile(box), text);
  assert.equal(await box.run(betaLocal), 0);
  assert.equal(readFileSync(localFile(box), 'utf8'), text);
});

test('AC6(b) other keys and values are kept', async () => {
  const box = sandbox();
  const before = { permissions: { deny: ['Bash(rm -rf:*)'] }, enabledPlugins: { 'other@market': true, 'dev-skills@gitmunk': true } };
  mkdirSync(join(box.cwd, '.claude'));
  writeFileSync(localFile(box), JSON.stringify(before));
  assert.equal(await box.run(betaLocal), 0);
  assert.deepEqual(JSON.parse(readFileSync(localFile(box), 'utf8')), { ...before, enabledPlugins: { 'other@market': true, 'dev-skills@gitmunk': false } });
});

test('AC6(c) invalid JSON or a non-object enabledPlugins stops before any step and keeps the file', async () => {
  for (const text of ['{"enabledPlugins": {', '{"enabledPlugins": ["dev-skills@gitmunk"]}', '[]']) {
    const box = sandbox();
    mkdirSync(join(box.cwd, '.claude'));
    writeFileSync(localFile(box), text);
    assert.equal(await box.run(betaLocal), 1, text);
    assert.deepEqual(box.calls(), [], text);
    assert.equal(readFileSync(localFile(box), 'utf8'), text);
    assert.match(box.errors.join('\n'), /settings\.local\.json/);
  }
});
