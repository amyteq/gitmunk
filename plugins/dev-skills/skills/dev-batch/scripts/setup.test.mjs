import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySetup, planSetup } from './setup.mjs';
import { tempDir } from './test-helpers.mjs';

const env = { DEV_BATCH_MODEL: 'claude-opus-5-5' };

test('fresh settings', () => {
  const { changes, next } = planSetup({ settings: {}, configDir: '/c', env });
  assert.equal(changes.length, 3);
  assert.match(changes.join('\n'), /statusLine/);
  assert.match(changes.join('\n'), /DEV_BATCH_MODEL=claude-opus-5-5/);
  assert.match(changes.join('\n'), /cleanupPeriodDays 365/);
  assert.deepEqual(next.statusLine, { type: 'command', command: 'node "/c/dev-batch-statusline.mjs"' });
});

test('an existing status line is chained, not replaced', () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  const settings = { statusLine: { type: 'command', command: 'echo hi' } };
  writeFileSync(path, JSON.stringify(settings));
  const plan = planSetup({ settings, configDir: dir, env: {} });
  assert.equal(plan.chain, 'echo hi');
  applySetup({ path, next: plan.next, chain: plan.chain, now: new Date('2026-11-19T01:02:03Z') });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dev-batch-statusline.json'), 'utf8')), { chain: 'echo hi' });
  assert.ok(existsSync(join(dir, 'dev-batch-statusline.mjs')));
  assert.ok(existsSync(`${path}.dev-batch-backup-20261119010203`));
  assert.ok(readFileSync(path, 'utf8').endsWith('}\n'));
});

test('cleanupPeriodDays 3650 is kept', () => {
  const { next } = planSetup({ settings: { cleanupPeriodDays: 3650 }, configDir: '/c', env: {} });
  assert.equal(next.cleanupPeriodDays, 3650);
});

test('a second run changes nothing', () => {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  const first = planSetup({ settings: { statusLine: { type: 'command', command: 'echo hi' } }, configDir: dir, env });
  applySetup({ path, next: first.next, chain: first.chain });
  const second = planSetup({ settings: JSON.parse(readFileSync(path, 'utf8')), configDir: dir, env });
  assert.deepEqual(second.changes, []);
  assert.equal(second.chain, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, 'dev-batch-statusline.json'), 'utf8')).chain, 'echo hi');
  assert.equal(readdirSync(dir).filter((f) => f.includes('backup')).length, 0);
});

test('no key is removed and key order is kept', () => {
  const settings = { b: 1, env: { X: '1' }, a: 2 };
  const { next } = planSetup({ settings, configDir: '/c', env });
  assert.deepEqual(Object.keys(next), ['b', 'env', 'a', 'statusLine', 'cleanupPeriodDays']);
  assert.deepEqual(Object.keys(next.env), ['X', 'DEV_BATCH_MODEL']);
});

test('extra statusLine keys survive', () => {
  const { next } = planSetup({ settings: { statusLine: { type: 'command', command: 'echo hi', padding: 2 } }, configDir: '/c', env: {} });
  assert.equal(next.statusLine.padding, 2);
  assert.equal(next.statusLine.command, 'node "/c/dev-batch-statusline.mjs"');
});
