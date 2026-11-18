// The batch's file-based event log, the judgment queue `wait` drains, and the lease of the one detached loop.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const tmp = join(dir, 'pending', `${name}.tmp`); // invisible to wait until complete
  writeFileSync(tmp, JSON.stringify(full));
  renameSync(tmp, join(dir, 'pending', name));
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
    try {
      renameSync(join(dir, 'pending', name), to);
      events.push(JSON.parse(readFileSync(to, 'utf8')));
    } catch { /* claimed by another wait, or unreadable: skip, keep what is claimed */ }
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

// Serialised by a short mutex (mkdir lease.lock is exclusive). Returns { ok, nonce }, { held: lease }, or
// { busy: true } when another taker is inside its critical section (retry shortly). insideLock is a test hook.
export function takeLease(dir, { pid, host, alias, coordinator, now = Date.now(), force = false, insideLock }) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'lease.lock');
  for (let tries = 0; ; tries++) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // shortcut: a lock older than 30 s means a taker crashed mid-section; two reclaimers could race here, fine for a few-ms section.
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > 30_000; } catch { /* gone: retry */ }
      if (stale) rmSync(lock, { recursive: true, force: true });
      else return { busy: true };
      if (tries) return { busy: true };
    }
  }
  try {
    let held = null;
    try { held = JSON.parse(readFileSync(leasePath(dir), 'utf8')); } catch { /* absent or unreadable: free */ }
    if (held && (held.host === host ? pidAlive(held.pid) : !force)) return { held };
    insideLock?.();
    const nonce = randomUUID();
    const tmp = `${leasePath(dir)}.${nonce}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, host, alias, coordinator, nonce, startedAt: new Date(now).toISOString() }));
    renameSync(tmp, leasePath(dir));
    return { ok: true, nonce };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

// Removes the lease only while it is still ours.
export function releaseLease(dir, nonce) {
  try { if (JSON.parse(readFileSync(leasePath(dir), 'utf8')).nonce === nonce) rmSync(leasePath(dir), { force: true }); } catch { /* none */ }
}
