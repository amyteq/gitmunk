import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { chooseAccount, limitCooling, readSnapshot } from './accounts.mjs';
import { tempDir } from './test-helpers.mjs';

const now = Date.parse('2026-11-19T10:00:00Z');
const sec = (ms) => Math.floor(ms / 1000);
const accounts = [{ alias: 'A1', dir: '/a1', loggedIn: true }, { alias: 'A2', dir: '/a2', loggedIn: true }, { alias: 'A3', dir: '/a3', loggedIn: true }];
const snap = (five, seven = 0, fiveResetsAt = now + 3600_000) => ({ at: now, five, seven, fiveResetsAt, sevenResetsAt: now + 86400_000 });
const base = { accounts, usageCap: 80, now, cooling: new Map(), unknownRunning: new Map() };

test("coordinator's account first when below the cap", () => {
  assert.deepEqual(chooseAccount({ ...base, coordinatorAlias: 'A2', snapshots: { A1: snap(10), A2: snap(50), A3: snap(20) } }), { alias: 'A2' });
});
test('otherwise the lowest known below the cap', () => {
  assert.deepEqual(chooseAccount({ ...base, coordinatorAlias: 'A2', snapshots: { A1: snap(30), A2: snap(90), A3: snap(20, 40) } }), { alias: 'A1' });
});
test('an unknown account only when no known one is below the cap, one session at a time', () => {
  const snapshots = { A1: snap(90), A2: snap(85) };
  assert.deepEqual(chooseAccount({ ...base, snapshots }), { alias: 'A3' });
  assert.deepEqual(chooseAccount({ ...base, snapshots: { A1: snap(10) } }), { alias: 'A1' });
  const busy = chooseAccount({ ...base, snapshots, unknownRunning: new Map([['A3', 1]]) });
  assert.ok(busy.waitUntil);
});
test('all at cap waits until the earliest resets_at', () => {
  const snapshots = { A1: snap(90, 0, now + 7200_000), A2: snap(85, 0, now + 1800_000), A3: snap(99, 0, now + 3600_000) };
  assert.deepEqual(chooseAccount({ ...base, snapshots }), { waitUntil: now + 1800_000 });
  assert.deepEqual(chooseAccount({ ...base, accounts: [accounts[0]], snapshots: { A1: { ...snap(90), fiveResetsAt: null } } }), { none: 'all-at-cap' });
});
test('a passed reset counts as 0%', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'dev-batch-usage.json'), JSON.stringify({ at: now, five_hour: { used_percentage: 95, resets_at: sec(now) - 10 }, seven_day: { used_percentage: 30, resets_at: sec(now) + 100 } }));
  const s = readSnapshot(dir, now);
  assert.equal(s.five, 0);
  assert.equal(s.seven, 30);
  assert.equal(readSnapshot(tempDir(), now), null);
});
test('a cooling or logged-out account is skipped', () => {
  const snapshots = { A1: snap(10), A2: snap(20), A3: snap(30) };
  assert.deepEqual(chooseAccount({ ...base, snapshots, cooling: new Map([['A1', now + 1000]]) }), { alias: 'A2' });
  assert.deepEqual(chooseAccount({ ...base, snapshots, accounts: [{ ...accounts[0], loggedIn: false }, accounts[1]] }), { alias: 'A2' });
  assert.equal(chooseAccount({ ...base, snapshots, cooling: new Map(accounts.map((a) => [a.alias, now + 5000])) }).waitUntil, now + 5000);
});

test('limitCooling parses the stated reset in the named zone', () => {
  assert.equal(limitCooling("You've hit your session limit · resets 4:50pm (UTC)", now), Date.parse('2026-11-19T16:50:00Z'));
  assert.equal(limitCooling("You've hit your session limit · resets 4pm (Europe/Berlin)", now), Date.parse('2026-11-19T15:00:00Z'));
  // 9am Berlin is 08:00Z, already past at 10:00Z, so tomorrow.
  assert.equal(limitCooling("You've hit your 5-hour limit · resets 9am (Europe/Berlin)", now), Date.parse('2026-11-20T08:00:00Z'));
  assert.equal(limitCooling("You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your weekly limit resets Nov 24, 12:30am (UTC)", now), Date.parse('2026-11-24T00:30:00Z'));
  assert.equal(limitCooling("You've hit your weekly limit · resets Nov 1, 9am (UTC)", now), Date.parse('2027-11-01T09:00:00Z'));
});
test('limitCooling falls back to one hour, and ignores other text', () => {
  assert.equal(limitCooling("You've hit your monthly spend limit. /model to switch models.", now), now + 3600_000);
  assert.equal(limitCooling("You've hit your session limit · resets 4pm (Not/AZone)", now), now + 3600_000);
  assert.equal(limitCooling('tests failed', now), null);
});
test('limitCooling takes the last stated reset, and only a limit message in the last 20 lines of the log (I5)', () => {
  const evening = Date.parse('2026-11-19T20:00:00Z');
  const limit = (at) => `You've hit your session limit · resets ${at} (UTC)`;
  assert.equal(limitCooling(`${limit('3pm')}\nresumed\n${limit('9pm')}\n`, evening), Date.parse('2026-11-19T21:00:00Z'));
  // A limited session resumes by itself: an old limit line followed by other work is history, not a limit now.
  const later = Array.from({ length: 20 }, (_, i) => `step ${i}`).join('\n');
  assert.equal(limitCooling(`${limit('9pm')}\n${later}\nDo you want to allow this command?\n`, evening), null);
  assert.equal(limitCooling(`${later}\n${limit('9pm')}\n\n`, evening), Date.parse('2026-11-19T21:00:00Z'));
});
