// Account choice from usage snapshots and cooling (spec §12).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 3600_000;

// A window whose resets_at (epoch seconds) has passed counts as 0.
const windowUse = (w, now) => (!w || typeof w.used_percentage !== 'number' ? null
  : w.resets_at != null && w.resets_at * 1000 <= now ? 0 : w.used_percentage);
const resetMs = (w) => (w?.resets_at != null ? w.resets_at * 1000 : null);

// → { at, five, seven, fiveResetsAt, sevenResetsAt } (percentages, null when a window was never seen; resets in ms) or null.
export function readSnapshot(configDir, now) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(configDir, 'dev-batch-usage.json'), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const five = windowUse(raw.five_hour, now);
  const seven = windowUse(raw.seven_day, now);
  if (five === null && seven === null) return null;
  return { at: raw.at ?? null, five, seven, fiveResetsAt: resetMs(raw.five_hour), sevenResetsAt: resetMs(raw.seven_day) };
}

const high = (s) => Math.max(s.five ?? 0, s.seven ?? 0);

export function chooseAccount({ accounts, snapshots = {}, cooling = new Map(), usageCap, coordinatorAlias, unknownRunning = new Map(), now }) {
  const ok = accounts.filter((a) => a.loggedIn && !((cooling.get(a.alias) ?? 0) > now));
  const known = ok.filter((a) => snapshots[a.alias]);
  const below = known.filter((a) => high(snapshots[a.alias]) < usageCap);
  const coord = below.find((a) => a.alias === coordinatorAlias);
  if (coord) return { alias: coord.alias };
  if (below.length) return { alias: below.reduce((m, a) => (high(snapshots[a.alias]) < high(snapshots[m.alias]) ? a : m)).alias };
  const unknown = ok.find((a) => !snapshots[a.alias] && !unknownRunning.get(a.alias));
  if (unknown) return { alias: unknown.alias };
  // Free again when every window at the cap has reset (or cooling ends); wait for the earliest account.
  const times = [];
  for (const a of accounts.filter((x) => x.loggedIn)) {
    const until = cooling.get(a.alias) ?? 0;
    const s = snapshots[a.alias];
    if (until > now) times.push(until);
    else if (s) {
      const capped = [['five', 'fiveResetsAt'], ['seven', 'sevenResetsAt']].filter(([w]) => (s[w] ?? 0) >= usageCap).map(([, r]) => s[r]);
      if (capped.length && capped.every((t) => t != null)) times.push(Math.max(...capped));
    }
  }
  return times.length ? { waitUntil: Math.min(...times) } : { none: 'all-at-cap' };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function zoneParts(ms, tz) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(ms).map((x) => [x.type, Number(x.value)]));
}
// Wall-clock time in tz → epoch ms (offset re-checked once for DST).
function zonedMs(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo, d, h, mi);
  const off = (t) => { const p = zoneParts(t, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; };
  const first = wall - off(wall);
  return wall - off(first);
}

// Usage-limit message → ms until which the account is cooling (stated reset, else one hour); null for any other text.
export function limitCooling(logText, now) {
  if (!/hit your [^\n]*limit/i.test(logText)) return null;
  const m = /resets (?:([A-Za-z]{3})[a-z]* (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s*([ap])m \(([^)]+)\)/i.exec(logText);
  if (m) {
    try {
      const [, mon, day, hh, mm = '0', ap, tz] = m;
      const h = (Number(hh) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
      const t = zoneParts(now, tz);
      let at;
      if (mon) {
        const mo = MONTHS.indexOf(mon.toLowerCase());
        at = zonedMs(t.year, mo, Number(day), h, Number(mm), tz);
        if (at <= now) at = zonedMs(t.year + 1, mo, Number(day), h, Number(mm), tz);
      } else {
        at = zonedMs(t.year, t.month - 1, t.day, h, Number(mm), tz);
        if (at <= now) at = zonedMs(t.year, t.month - 1, t.day + 1, h, Number(mm), tz);
      }
      if (Number.isFinite(at)) return at;
    } catch { /* unknown time zone: fall back */ }
  }
  return now + HOUR;
}
