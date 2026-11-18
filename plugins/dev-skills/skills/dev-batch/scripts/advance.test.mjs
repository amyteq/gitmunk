import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchable, dispatchOrder, layers } from './advance.mjs';

const row = (n, issue, over = {}) => ({ n, issue, title: `Task ${issue}`, deps: [], batch: 1, status: 'queued', pr: null, head: null, session: null, next: '', ...over });
const tasks = (map) => Object.entries(map).map(([issue, deps]) => ({ issue: Number(issue), deps }));

test('layers: B1 has no deps in the batch, deps outside the batch are met', () => {
  assert.deepEqual(Object.fromEntries(layers(tasks({ 41: [], 42: [41], 43: [], 44: [42, 43] })).batches), { 41: 1, 42: 2, 43: 1, 44: 3 });
  assert.deepEqual([...layers(tasks({ 5: [99] })).batches], [[5, 1]]);
});

test('a cycle is named', () => {
  assert.deepEqual(layers(tasks({ 1: [2], 2: [1] })), { cycle: [1, 2] });
  assert.deepEqual(layers(tasks({ 1: [2], 2: [3], 3: [2], 4: [1] })), { cycle: [2, 3] });
});

test('batch is priority, not a barrier', () => {
  const rows = [row(1, 41, { status: 'reviewing', pr: 5 }), row(2, 42, { deps: [41], batch: 2, status: 'waiting' }), row(3, 43)];
  const by = new Map(rows.map((r) => [r.issue, r]));
  assert.equal(dispatchable(rows[1], by, new Set([41])), true);
  assert.equal(dispatchable(rows[1], by, new Set()), false);
  assert.equal(dispatchable(rows[0], by, new Set()), false); // already in review
});

test('order: (B1, row 3) comes before (B2, row 1)', () => {
  const rows = [row(1, 41, { batch: 2 }), row(2, 42, { batch: 1 }), row(3, 43, { batch: 1 })];
  assert.deepEqual(dispatchOrder(rows).map((r) => r.n), [2, 3, 1]);
});
