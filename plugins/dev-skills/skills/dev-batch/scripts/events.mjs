// The batch's file-based event log, the judgment queue `wait` drains, and the lease of the one detached loop.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0; // monotonic per process, so names never collide

export function appendEvent(dir, { type, task, stage, session, account, detail }, now = Date.now()) {
  const event = { at: new Date(now).toISOString(), type, task, stage, session, account, detail };
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  return event;
}

export function queueJudgment(dir, event, now = Date.now()) {
  const full = appendEvent(dir, event, now);
  mkdirSync(join(dir, 'pending'), { recursive: true });
  const name = `${String(now).padStart(13, '0')}-${String(seq++).padStart(8, '0')}.json`;
  writeFileSync(join(dir, 'pending', name), JSON.stringify(full));
  return full;
}

const pendingNames = (dir) => (existsSync(join(dir, 'pending')) ? readdirSync(join(dir, 'pending')).filter((n) => n.endsWith('.json')).sort() : []);
export const pendingCount = (dir) => pendingNames(dir).length;

// Claims each file by renaming it into delivered/; a concurrent wait that loses the rename skips the file.
function claim(dir) {
  mkdirSync(join(dir, 'delivered'), { recursive: true });
  const events = [];
  for (const name of pendingNames(dir)) {
    const to = join(dir, 'delivered', name);
    try { renameSync(join(dir, 'pending', name), to); } catch { continue; }
    events.push(JSON.parse(readFileSync(to, 'utf8')));
  }
  return events;
}

export async function wait(dir, { timeoutSeconds, pollMs = 1000 }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const events = claim(dir);
    if (events.length) return { code: 0, events };
    if (Date.now() >= deadline) return { code: 3 };
    await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
  }
}

const leasePath = (dir) => join(dir, 'lease.json');

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Last writer wins: after the rename the lease is re-read and only the taker whose nonce is on disk proceeds.
// afterWrite is a test hook between the rename and the re-read.
export function takeLease(dir, { pid, host, alias, coordinator, now = Date.now(), force = false, afterWrite }) {
  let held = null;
  try { held = JSON.parse(readFileSync(leasePath(dir), 'utf8')); } catch { /* absent or unreadable: free */ }
  if (held) {
    if (held.host === host ? pidAlive(held.pid) : !force) return { held };
  }
  mkdirSync(dir, { recursive: true });
  const nonce = randomUUID();
  const tmp = `${leasePath(dir)}.${process.pid}.${nonce}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, host, alias, coordinator, nonce, startedAt: new Date(now).toISOString() }));
  renameSync(tmp, leasePath(dir));
  afterWrite?.();
  const now_ = JSON.parse(readFileSync(leasePath(dir), 'utf8'));
  return now_.nonce === nonce ? { ok: true, nonce } : { held: now_ };
}

// Removes the lease only while it is still ours.
export function releaseLease(dir, nonce) {
  try { if (JSON.parse(readFileSync(leasePath(dir), 'utf8')).nonce === nonce) rmSync(leasePath(dir), { force: true }); } catch { /* none */ }
}
