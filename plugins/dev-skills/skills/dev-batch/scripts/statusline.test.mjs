import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { tempDir } from './test-helpers.mjs';

const SCRIPT = new URL('./statusline.mjs', import.meta.url);
function run(chain) {
  const dir = tempDir();
  copyFileSync(SCRIPT, join(dir, 'statusline.mjs'));
  if (chain) writeFileSync(join(dir, 'dev-batch-statusline.json'), JSON.stringify({ chain }));
  return {
    go: (input) => spawnSync(process.execPath, [join(dir, 'statusline.mjs')], { input, encoding: 'utf8' }),
    snap: () => JSON.parse(readFileSync(join(dir, 'dev-batch-usage.json'), 'utf8')),
  };
}
const payload = { rate_limits: { five_hour: { used_percentage: 41.6, resets_at: 1800000000 }, seven_day: { used_percentage: 12, resets_at: 1800500000 } } };

test('statusline writes the snapshot from rate_limits.five_hour and seven_day', () => {
  const t = run();
  assert.equal(t.go(JSON.stringify(payload)).stdout, '5h 42% · 7d 12%\n');
  const s = t.snap();
  assert.deepEqual([s.five_hour, s.seven_day], [payload.rate_limits.five_hour, payload.rate_limits.seven_day]);
  assert.equal(typeof s.at, 'number');
});

test('statusline without rate_limits keeps the previous snapshot', () => {
  const t = run();
  t.go(JSON.stringify(payload));
  t.go(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 1800000100 } } }));
  assert.equal(t.snap().five_hour.used_percentage, 50);
  assert.equal(t.snap().seven_day.used_percentage, 12);
  assert.equal(t.go(JSON.stringify({ model: 'x' })).stdout, '5h 50% · 7d 12%\n');
  assert.equal(t.snap().five_hour.used_percentage, 50);
});

test('statusline runs the chained command with the same stdin', () => {
  const t = run('cat | tr a-z A-Z');
  assert.equal(t.go('{"x":"abc"}').stdout, '{"X":"ABC"}\n5h ? · 7d ?\n');
});

test('a failing chained command does not stop the usage text or the snapshot', () => {
  const t = run('echo before; exit 3');
  assert.equal(t.go(JSON.stringify(payload)).stdout, 'before\n5h 42% · 7d 12%\n');
  assert.equal(t.snap().five_hour.used_percentage, 41.6);
});
