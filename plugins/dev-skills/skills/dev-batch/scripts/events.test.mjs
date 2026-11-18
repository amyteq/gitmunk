import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
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
  assert.equal(takeLease(dir, me).ok, true);
  assert.equal(takeLease(dir, { ...me, pid: 1 }).held.pid, process.pid);
  writeFileSync(join(dir, 'lease.json'), JSON.stringify({ ...me, pid: dead() }));
  assert.equal(takeLease(dir, me).ok, true);
  assert.equal(takeLease(dir, { ...me, host: 'h2' }).held.host, 'h1');
  const forced = takeLease(dir, { ...me, host: 'h2', force: true });
  assert.equal(forced.ok, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'lease.json'), 'utf8')).host, 'h2');
  releaseLease(dir, forced.nonce);
  assert.equal(existsSync(join(dir, 'lease.json')), false);
});

test('lease: a second taker arriving inside the first one\'s critical section is busy, then sees the holder', () => {
  const dir = tempDir();
  const base = { host: 'h1', alias: 'A1', coordinator: 'x-i1c' };
  let b;
  const a = takeLease(dir, { ...base, pid: process.pid, insideLock: () => { b = takeLease(dir, { ...base, pid: dead() }); } });
  assert.equal(a.ok, true);
  assert.deepEqual(b, { busy: true });
  assert.equal(takeLease(dir, { ...base, pid: dead() }).held.nonce, a.nonce);
});

test('lease: a stale lock directory left by a crashed taker is removed', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'lease.lock'));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'lease.lock'), old, old);
  assert.equal(takeLease(dir, { pid: process.pid, host: 'h1', alias: 'A1', coordinator: 'c' }).ok, true);
  assert.equal(existsSync(join(dir, 'lease.lock')), false);
});

test('wait skips an unreadable pending file and still delivers the others', async () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'pending'));
  writeFileSync(join(dir, 'pending', '0000000000000-00000000.json'), '{"ty');
  queueJudgment(dir, { type: 'stall', task: 'i1' });
  const r = await wait(dir, { timeoutSeconds: 1, pollMs: 10 });
  assert.deepEqual(r.events.map((e) => e.task), ['i1']);
});

test('releaseLease by a non-holder leaves the lease', () => {
  const dir = tempDir();
  const first = takeLease(dir, { pid: process.pid, host: 'h1', alias: 'A1', coordinator: 'c' });
  releaseLease(dir, 'someone-else');
  assert.equal(existsSync(join(dir, 'lease.json')), true);
  releaseLease(dir, first.nonce);
  assert.equal(existsSync(join(dir, 'lease.json')), false);
});

test('wait raises one loop-not-running judgment when no live loop holds the lease of an active, unpaused batch (I7)', async () => {
  const batch = (files) => {
    const dir = tempDir();
    for (const [name, value] of Object.entries({ 'settings.json': { paused: false }, ...files })) writeFileSync(join(dir, name), JSON.stringify(value));
    return dir;
  };
  const watch = (dir, timeoutSeconds = 2) => wait(dir, { timeoutSeconds, pollMs: 10, host: 'h1', checkMs: 30 });
  for (const dir of [batch({}), batch({ 'lease.json': { pid: dead(), host: 'h1' } })]) {
    const r = await watch(dir);
    assert.deepEqual([r.code, r.events.map((e) => e.type)], [0, ['loop-not-running']]);
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 1); // logged as well
  }
  // A live loop (or a command holding the lease for a moment), a paused or complete batch, another host's lease: nothing.
  for (const files of [{ 'lease.json': { pid: process.pid, host: 'h1' } }, { 'settings.json': { paused: true } }, { 'settings.json': { paused: 'handover' } },
    { 'summary.json': {} }, { 'lease.json': { pid: dead(), host: 'h2' } }]) {
    assert.deepEqual(await watch(batch(files), 0.2), { code: 3 }, JSON.stringify(files));
  }
  // Without a host, wait never checks the lease.
  assert.deepEqual(await wait(batch({}), { timeoutSeconds: 0.2, pollMs: 10 }), { code: 3 });
});
