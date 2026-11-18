// Plans and applies the per-account change to a Claude Code user settings.json.
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MARK = 'dev-batch-statusline.mjs';

// Returns { changes, next, chain }: chain is the previous status-line command to record (or undefined).
export function planSetup({ settings, configDir, env = {} }) {
  const next = structuredClone(settings);
  const changes = [];
  const command = `node "${join(configDir, MARK)}"`;
  let chain;
  if (next.statusLine?.command !== command) {
    if (typeof next.statusLine?.command === 'string' && !next.statusLine.command.includes(MARK)) chain = next.statusLine.command;
    next.statusLine = { ...next.statusLine, type: 'command', command };
    changes.push(chain ? `statusLine: dev-batch usage status line, chaining "${chain}"` : 'statusLine: dev-batch usage status line');
  }
  for (const [k, v] of Object.entries(env)) {
    if (next.env?.[k] === v) continue;
    next.env = { ...next.env, [k]: v };
    changes.push(`env ${k}=${v}`);
  }
  if (!(next.cleanupPeriodDays >= 365)) {
    next.cleanupPeriodDays = 365;
    changes.push('cleanupPeriodDays 365');
  }
  return { changes, next, chain };
}

const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);

// Backup first, then settings, the copied script and the chain file. Call only when changes is non-empty.
export function applySetup({ path, next, chain, now = new Date() }) {
  const configDir = dirname(path);
  try { copyFileSync(path, `${path}.dev-batch-backup-${stamp(now)}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  copyFileSync(join(here, 'statusline.mjs'), join(configDir, MARK));
  if (next.statusLine?.command?.includes(MARK) && chain !== undefined) {
    writeFileSync(join(configDir, 'dev-batch-statusline.json'), `${JSON.stringify({ chain }, null, 2)}\n`);
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}
