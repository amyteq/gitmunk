// Standalone status-line script (only node: imports): `setup` copies it into each config directory.
// Reads Claude Code's status-line JSON on stdin, records the usage windows beside itself, prints usage text.
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const readJson = (file) => { try { return JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { return null; } };
const input = (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })();
let payload = null;
try { payload = JSON.parse(input); } catch { /* not JSON: keep the last snapshot */ }

const prev = readJson('dev-batch-usage.json') ?? {};
const snap = { at: Date.now() };
for (const w of ['five_hour', 'seven_day']) {
  const cur = payload?.rate_limits?.[w];
  snap[w] = cur && typeof cur.used_percentage === 'number'
    ? { used_percentage: cur.used_percentage, resets_at: cur.resets_at ?? null }
    : prev[w] ?? null;
}
try {
  const tmp = join(dir, `.dev-batch-usage.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, join(dir, 'dev-batch-usage.json'));
} catch { /* a failed write must not hide the status line */ }

// The owner's previous status line, run through a shell exactly as Claude Code would; its failure is ignored.
const chain = readJson('dev-batch-statusline.json')?.chain;
let out = '';
if (typeof chain === 'string' && chain) {
  const r = spawnSync('sh', ['-c', chain], { input, encoding: 'utf8' });
  out = (r.stdout ?? '').replace(/\n+$/, '');
}
const pct = (w) => (snap[w] ? `${Math.round(snap[w].used_percentage)}%` : '?');
process.stdout.write(`${out ? `${out}\n` : ''}5h ${pct('five_hour')} · 7d ${pct('seven_day')}\n`);
