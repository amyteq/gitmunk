import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { InputError, askQuestions, deriveAbbr, parseInvocation, repoStateDir, resolveSettings, srcKey, stateDir } from './config.mjs';
import { stubBin, tempDir, withPath } from './test-helpers.mjs';

const pick = (obj, keys) => Object.fromEntries(keys.split(' ').map((k) => [k, obj[k]]));

test('defaults match the design', () => {
  const { values, sources } = resolveSettings({}, {});
  assert.deepEqual(pick(values, 'cap usage_cap merge reviewer writer rounds model effort autocompact mcp'),
    { cap: 4, usage_cap: 80, merge: 'auto', reviewer: 'codex', writer: 'claude', rounds: 10,
      model: 'opus', effort: 'xhigh', autocompact: '300k', mcp: 'none' });
  assert.equal(sources.cap, 'default');
});

test('argument beats environment beats default', () => {
  const { values, sources } = resolveSettings({ cap: '2' }, { DEV_BATCH_CAP: '6', DEV_BATCH_MODEL: 'claude-opus-5-5' });
  assert.equal(values.cap, 2); assert.equal(sources.cap, 'argument');
  assert.equal(values.model, 'claude-opus-5-5'); assert.equal(sources.model, 'environment');
});

test('accounts accept a JSON array or a comma list and default to CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  const accounts = (args, env) => resolveSettings(args, env).values.accounts;
  assert.deepEqual(accounts({}, { HOME: '/h' }), [{ alias: 'A1', dir: '/h/.claude' }]);
  assert.deepEqual(accounts({}, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }), [{ alias: 'A1', dir: '/c' }]);
  assert.deepEqual(accounts({ accounts: '/a, /b' }, {}), [{ alias: 'A1', dir: '/a' }, { alias: 'A2', dir: '/b' }]);
  assert.deepEqual(accounts({}, { DEV_BATCH_ACCOUNTS: '["/a","/b"]' }), [{ alias: 'A1', dir: '/a' }, { alias: 'A2', dir: '/b' }]);
  assert.deepEqual(accounts({ accounts: '[{"alias":"work","dir":"/a"},"/b"]' }, {}), [{ alias: 'work', dir: '/a' }, { alias: 'A2', dir: '/b' }]);
  assert.throws(() => accounts({ accounts: '[]' }, {}), InputError);
  assert.throws(() => accounts({ accounts: '[1]' }, {}), InputError);
  assert.throws(() => accounts({ accounts: '/a,/a' }, {}), InputError);
});

test('invalid values are refused', () => {
  for (const bad of [{ cap: '0' }, { usage_cap: '101' }, { merge: 'maybe' }, { autocompact: '50k' }, { mcp: '../x.txt' }, { rounds: 'x' }, { reviewer: 'gpt' }])
    assert.throws(() => resolveSettings(bad, {}), InputError, JSON.stringify(bad));
  assert.throws(() => resolveSettings({}, { DEV_BATCH_CAP: 'x' }), InputError);
  const { values } = resolveSettings({ mcp: 'inherit', autocompact: 'auto' }, {});
  assert.equal(values.mcp, 'inherit'); assert.equal(values.autocompact, 'auto');
  assert.equal(resolveSettings({ mcp: '/m/servers.json' }, {}).values.mcp, '/m/servers.json');
});

test('parseInvocation reads quoted values and extra', () => {
  assert.deepEqual(parseInvocation('init src=40 merge=off extra="no UI work"'),
    { sub: 'init', args: { src: '40', merge: 'off' }, extra: 'no UI work' });
  assert.equal(parseInvocation('').sub, 'status');
  assert.deepEqual(parseInvocation('config cap=2 label="a b"').args, { cap: '2', label: 'a b' });
  assert.throws(() => parseInvocation('frobnicate'), InputError);
  assert.throws(() => parseInvocation('init bogus=1'), InputError);
  assert.throws(() => parseInvocation('init src'), InputError);
});

test('abbr', () => {
  assert.equal(deriveAbbr('example-repo'), 'er');
  assert.equal(deriveAbbr('gitmunk'), 'gi');
});

test('state paths', () => {
  assert.equal(stateDir({ owner: 'example-org', repo: 'example-repo', src: { kind: 'issue', number: 40 } }, { XDG_STATE_HOME: '/s' }),
    '/s/dev-batch/example-org/example-repo/i40');
  assert.equal(repoStateDir({ owner: 'o', repo: 'r' }, { HOME: '/h' }), '/h/.local/state/dev-batch/o/r');
  assert.equal(srcKey({ kind: 'discussion', number: 7 }), 'd7');
  assert.equal(srcKey({ kind: 'comment', id: 99 }), 'c99');
});

const ask = (sub, args = {}, context = {}, env = {}) => askQuestions(sub, resolveSettings(args, env), { args, ...context });

test('ask round: init without src asks for it first; given values are not asked; never more than 4', () => {
  const candidates = [{ value: '40', label: '#40 tracker' }];
  const all = ask('init', {}, { candidates });
  assert.deepEqual(all.map((q) => q.key), ['src', 'merge', 'cap', 'model_effort']);
  assert.deepEqual(all[0].options, candidates);
  assert.equal(all[1].options[0].value, 'auto');
  assert.deepEqual(all[2].options.map((o) => o.value), ['4', '2', '6']);
  assert.match(all[0].question, /usage_cap=80 \(default\)/);
  assert.deepEqual(ask('init', { src: '40', merge: 'off' }, { candidates }).map((q) => q.key), ['cap', 'model_effort']);
  assert.throws(() => ask('init', { confirm: 'no' }), InputError);
  assert.deepEqual(ask('init', { src: '40', confirm: 'no' }), []);
  for (const sub of ['init', 'add', 'rm', 'config', 'handover', 'takeover', 'setup']) assert.ok(ask(sub).length <= 4);
});

test('ask round: status, pause, resume and clear ask nothing', () => {
  for (const sub of ['status', 'pause', 'resume', 'clear']) assert.deepEqual(ask(sub), []);
  assert.deepEqual(ask('config', { cap: '3' }), []);
  assert.equal(ask('config').length, 4);
  assert.equal(ask('config')[0].options[0].value, 'keep');
});

test('CLAUDE_CODE_AUTO_COMPACT_WINDOW in the environment gives a warning', () => {
  assert.deepEqual(resolveSettings({}, {}).warnings, []);
  const { warnings } = resolveSettings({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
});

test('test helpers: a stub on PATH logs argv and answers from its fixture', () => {
  const dir = tempDir();
  stubBin(dir, 'gh', 'process.stdout.write(JSON.stringify(fixture()));');
  const log = join(dir, 'log'); const fixture = join(dir, 'f.json');
  writeFileSync(fixture, '{"ok":1}');
  const out = spawnSync('gh', ['issue', 'list'], { env: { PATH: withPath(dir), STUB_LOG: log, STUB_FIXTURE: fixture }, encoding: 'utf8' });
  assert.equal(out.stdout, '{"ok":1}');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).argv, ['issue', 'list']);
});

test('reviewer and writer model/effort settings default to null and follow the precedence', () => {
  const keys = ['reviewer_model', 'reviewer_effort', 'writer_model', 'writer_effort'];
  const { values, sources } = resolveSettings({}, {});
  for (const key of keys) { assert.equal(values[key], null); assert.equal(sources[key], 'default'); }
  const r = resolveSettings({ writer_effort: 'high' }, { DEV_BATCH_WRITER_EFFORT: 'low', DEV_BATCH_REVIEWER_MODEL: 'gpt-x', DEV_BATCH_REVIEWER_EFFORT: 'medium', DEV_BATCH_WRITER_MODEL: 'sonnet' });
  assert.deepEqual(pick(r.values, keys.join(' ')), { reviewer_model: 'gpt-x', reviewer_effort: 'medium', writer_model: 'sonnet', writer_effort: 'high' });
  assert.deepEqual(keys.map((k) => r.sources[k]), ['environment', 'environment', 'environment', 'argument']);
  assert.throws(() => resolveSettings({ reviewer_effort: ' ' }, {}), InputError);
  assert.throws(() => resolveSettings({ writer_model: '' }, {}), InputError);
  assert.deepEqual(parseInvocation('config reviewer_model=x writer_effort=high').args, { reviewer_model: 'x', writer_effort: 'high' });
  assert.ok(!ask('init').some((q) => keys.includes(q.key)));
  assert.ok(!ask('config').some((q) => keys.includes(q.key)));
});

// #58: named slots and the cost alert.
const ALL = ['refine', 'implement', 'review', 'merge'];
test('slots and cost_alert default to none and off and follow the precedence (AC-3 a)', () => {
  const d = resolveSettings({}, {});
  assert.deepEqual([d.values.slots, d.values.cost_alert, d.sources.slots, d.sources.cost_alert], ['none', 'off', 'default', 'default']);
  const e = resolveSettings({}, { DEV_BATCH_SLOTS: 'e2e=1', DEV_BATCH_COST_ALERT: '3' });
  assert.deepEqual([e.values.slots, e.values.cost_alert, e.sources.slots, e.sources.cost_alert], [[{ name: 'e2e', count: 1, stages: ALL }], 3, 'environment', 'environment']);
  const a = resolveSettings({ slots: 'none', cost_alert: 'off' }, { DEV_BATCH_SLOTS: 'e2e=1', DEV_BATCH_COST_ALERT: '3' });
  assert.deepEqual([a.values.slots, a.values.cost_alert, a.sources.slots, a.sources.cost_alert], ['none', 'off', 'argument', 'argument']);
  assert.deepEqual(parseInvocation('config slots=heavy=3,e2e=1 cost_alert=2.5').args, { slots: 'heavy=3,e2e=1', cost_alert: '2.5' });
});

test('slots parse into name, count and stages; no stage list is every stage (AC-3 a)', () => {
  const slots = (v) => resolveSettings({ slots: v }, {}).values.slots;
  assert.deepEqual(slots('heavy=3,e2e=1,live-api=1:implement+review'), [
    { name: 'heavy', count: 3, stages: ALL }, { name: 'e2e', count: 1, stages: ALL }, { name: 'live-api', count: 1, stages: ['implement', 'review'] }]);
  assert.deepEqual(slots(`${'a'.repeat(32)}=12:merge`), [{ name: 'a'.repeat(32), count: 12, stages: ['merge'] }]);
  assert.equal(resolveSettings({ cost_alert: '1.5' }, {}).values.cost_alert, 1.5);
});

// AC-3 (b): one test per refused value; batch.test.mjs checks exit 2 from `ask` and `config` for the same values.
const REFUSED = [
  ['slots', '=1', 'an empty name'], ['slots', `${'a'.repeat(33)}=1`, 'a name over 32 characters'], ['slots', 'E2E=1', 'an upper-case name'],
  ['slots', 'e2e_x=1', 'a name with _'], ['slots', 'e2e', 'no count'], ['slots', 'e2e=0', 'a count of 0'], ['slots', 'e2e=1.5', 'a fractional count'],
  ['slots', 'e2e=x', 'a count that is not a number'], ['slots', 'e2e=1,e2e=2', 'a duplicate name'], ['slots', 'e2e=1:deploy', 'an unknown stage'],
  ['slots', 'e2e=1:', 'an empty stage'], ['cost_alert', 'lots', 'not a number'], ['cost_alert', '1', 'exactly 1'], ['cost_alert', '0.5', 'below 1'],
  ['cost_alert', '-3', 'a negative number'],
];
for (const [key, value, why] of REFUSED) {
  test(`${key}=${value} is refused naming the key: ${why} (AC-3 b)`, () => {
    assert.throws(() => resolveSettings({ [key]: value }, {}), (e) => e instanceof InputError && e.message.startsWith(`${key} `));
    const env = `DEV_BATCH_${key.toUpperCase()}`;
    assert.throws(() => resolveSettings({}, { [env]: value }), (e) => e instanceof InputError && e.message.startsWith(`${env}: ${key} `));
  });
}
