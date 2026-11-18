import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { launch, launchArgs, listAgents, loggedIn, transcriptPath } from './sessions.mjs';
import { stubBin, tempDir, withPath } from './test-helpers.mjs';

const base = { name: 'repo-i1a', model: 'opus', effort: 'xhigh', autocompact: '300k', mcp: 'none', scope: 'scope text', prompt: '/dev-refine-issue 1' };
const ORIGINAL_PATH = process.env.PATH;

function setup(script) {
  const dir = tempDir();
  stubBin(dir, 'claude', script);
  const log = join(dir, 'log');
  process.env.STUB_LOG = log;
  process.env.PATH = withPath(dir, ORIGINAL_PATH);
  return { dir, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('launch argv for implement with mcp=none and autocompact=300k', () => {
  assert.deepEqual(launchArgs(base), ['--bg', '--name', 'repo-i1a', '--model', 'opus', '--effort', 'xhigh', '--autocompact', '300k',
    '--permission-mode', 'auto', '--remote-control', 'repo-i1a', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--append-system-prompt', 'scope text', '/dev-refine-issue 1']);
});

test('mcp file and inherit', () => {
  assert.deepEqual(launchArgs({ ...base, mcp: '/x/m.json' }).slice(-6, -3), ['--strict-mcp-config', '--mcp-config', '/x/m.json']);
  assert.ok(!launchArgs({ ...base, mcp: 'inherit' }).includes('--strict-mcp-config'));
});

test('merge sessions get no --autocompact', () => {
  assert.ok(!launchArgs({ ...base, autocompact: null }).includes('--autocompact'));
});

test('a prompt starting with "-" is refused before spawning', () => {
  const { dir } = setup('process.exit(0)');
  assert.throws(() => launchArgs({ ...base, prompt: '--dangerous' }));
  assert.throws(() => launch({ configDir: dir }, { ...base, prompt: '-x' }));
  assert.throws(() => readFileSync(join(dir, 'log')));
});

test('each call runs with CLAUDE_CONFIG_DIR of its account', () => {
  const { calls } = setup('console.log("deadbeef")');
  assert.deepEqual(launch({ configDir: '/cfg/A1' }, base), { id: 'deadbeef' });
  assert.deepEqual(launch({ configDir: '/cfg/A2' }, base), { id: 'deadbeef' });
  assert.deepEqual(calls().map((c) => c.env.CLAUDE_CONFIG_DIR), ['/cfg/A1', '/cfg/A2']);
});

test('launch without an id gives { error }', () => {
  setup('console.log("nope")');
  assert.ok(launch({ configDir: '/c' }, base).error);
});

test('listAgents maps states; non-zero exit gives { error }', () => {
  const states = ['working', 'blocked', 'done', 'stopped', 'failed'];
  const fx = join(tempDir(), 'fx.json');
  writeFileSync(fx, JSON.stringify(states.map((state, i) => ({ id: `0000000${i}`, cwd: '/w', kind: 'background', startedAt: 't', sessionId: `s${i}`, name: `n${i}`, state }))));
  process.env.STUB_FIXTURE = fx;
  setup('console.log(JSON.stringify(fixture()))');
  const agents = listAgents({ configDir: '/c' });
  assert.deepEqual(agents.map((a) => a.state), states);
  assert.deepEqual(Object.keys(agents[0]), ['id', 'sessionId', 'name', 'state', 'cwd', 'startedAt']);
  setup('process.exit(3)');
  assert.ok(listAgents({ configDir: '/c' }).error);
});

test('loggedIn reads only the boolean', () => {
  setup('console.log(JSON.stringify({ loggedIn: true, email: "x" }))');
  assert.equal(loggedIn({ configDir: '/c' }), true);
  setup('console.log(JSON.stringify({ loggedIn: false }))');
  assert.equal(loggedIn({ configDir: '/c' }), false);
});

test('transcriptPath searches projects/*/<sessionId>.jsonl', () => {
  const cfg = tempDir();
  mkdirSync(join(cfg, 'projects', 'a'), { recursive: true });
  mkdirSync(join(cfg, 'projects', 'b'));
  writeFileSync(join(cfg, 'projects', 'b', 's1.jsonl'), '');
  assert.equal(transcriptPath(cfg, 's1'), join(cfg, 'projects', 'b', 's1.jsonl'));
  assert.equal(transcriptPath(cfg, 'zz'), null);
  assert.equal(transcriptPath(join(cfg, 'none'), 's1'), null);
});
