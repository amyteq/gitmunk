// The batch's file-based event log, the judgment queue `wait` drains, and the lease of the one detached loop.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// shortcut: read-then-rename is not an exclusive create, so two simultaneous takers could both win; the
// loop is started by one coordinator, upgrade to link()/O_EXCL if that stops holding.
export function takeLease(dir, { pid, host, alias, coordinator, now = Date.now(), force = false }) {
  let held = null;
  try { held = JSON.parse(readFileSync(leasePath(dir), 'utf8')); } catch { /* absent or unreadable: free */ }
  if (held) {
    if (held.host === host ? pidAlive(held.pid) : !force) return { held };
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${leasePath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, host, alias, coordinator, startedAt: new Date(now).toISOString() }));
  renameSync(tmp, leasePath(dir));
  return { ok: true };
}

export const releaseLease = (dir) => rmSync(leasePath(dir), { force: true });
