import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { appendEvent, pendingCount, queueJudgment, releaseLease, takeLease, wait } from './events.mjs';
import { tempDir } from './test-helpers.mjs';

test('appendEvent writes one JSON line with an ISO time', () => {
  const dir = tempDir();
  appendEvent(dir, { type: 'wake', task: 'i1' }, Date.parse('2026-01-02T03:04:05Z'));
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { at: '2026-01-02T03:04:05.000Z', type: 'wake', task: 'i1' });
});

test('wait returns pending events in queue order, moves them, exits 0', async () => {
  const dir = tempDir();
  for (const n of [1, 2, 3]) queueJudgment(dir, { type: 'stall', task: `i${n}` }, 1000);
  assert.equal(pendingCount(dir), 3);
  const r = await wait(dir, { timeoutSeconds: 1, pollMs: 10 });
  assert.equal(r.code, 0);
  assert.deepEqual(r.events.map((e) => e.task), ['i1', 'i2', 'i3']);
  assert.equal(pendingCount(dir), 0);
  assert.equal(readdirSync(join(dir, 'delivered')).length, 3);
});

test('two concurrent waits never deliver the same event', async () => {
  const dir = tempDir();
  for (let n = 0; n < 20; n++) queueJudgment(dir, { type: 'stall', task: `i${n}` });
  const [a, b] = await Promise.all([wait(dir, { timeoutSeconds: 1, pollMs: 5 }), wait(dir, { timeoutSeconds: 1, pollMs: 5 })]);
  const tasks = [...(a.events ?? []), ...(b.events ?? [])].map((e) => e.task);
  assert.equal(tasks.length, 20);
  assert.equal(new Set(tasks).size, 20);
});

test('wait times out with 3', async () => {
  assert.deepEqual(await wait(tempDir(), { timeoutSeconds: 0.05, pollMs: 10 }), { code: 3 });
});

test('events queued while no wait runs stay pending, and a later wait picks them up', async () => {
  const dir = tempDir();
  queueJudgment(dir, { type: 'stall', task: 'i1' });
  assert.equal(pendingCount(dir), 1);
  const waiting = wait(dir, { timeoutSeconds: 1, pollMs: 10 });
  queueJudgment(dir, { type: 'stall', task: 'i2' });
  assert.equal((await waiting).events.length >= 1, true);
});

const dead = () => { const r = spawnSync(process.execPath, ['-e', '']); return r.pid; };

test('lease: a live pid refuses, a dead pid on the same host is reclaimed, another host needs force', () => {
  const dir = tempDir();
  const me = { pid: process.pid, host: 'h1', alias: 'A1', coordinator: 'x-i1c' };
  assert.deepEqual(takeLease(dir, me), { ok: true });
  assert.equal(takeLease(dir, { ...me, pid: 1 }).held.pid, process.pid);
  writeFileSync(join(dir, 'lease.json'), JSON.stringify({ ...me, pid: dead() }));
  assert.deepEqual(takeLease(dir, me), { ok: true });
  assert.equal(takeLease(dir, { ...me, host: 'h2' }).held.host, 'h1');
  assert.deepEqual(takeLease(dir, { ...me, host: 'h2', force: true }), { ok: true });
  assert.equal(JSON.parse(readFileSync(join(dir, 'lease.json'), 'utf8')).host, 'h2');
  releaseLease(dir);
  assert.equal(existsSync(join(dir, 'lease.json')), false);
});
