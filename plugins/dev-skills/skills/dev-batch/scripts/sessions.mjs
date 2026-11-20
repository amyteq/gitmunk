// The adapter for background Claude Code sessions: launch, list, stop, logs, login check, transcript lookup.
// One account (config directory) per call; spawns argument arrays, never a shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const defaultRun = (cmd, args, { env, cwd } = {}) => {
  const r = spawnSync(cmd, args, { env, cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
};

// The child inherits the parent environment; only CLAUDE_CONFIG_DIR is set.
const call = ({ configDir, run = defaultRun }, args) =>
  run('claude', args, { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });

export function launchArgs({ name, model, effort, autocompact, mcp, scope, prompt }) {
  if (typeof prompt !== 'string' || !prompt.startsWith('/')) throw new Error('launch prompt must start with "/"');
  const mcpArgs = mcp === 'none' ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
    : mcp && mcp !== 'inherit' ? ['--strict-mcp-config', '--mcp-config', mcp] : [];
  return ['--bg', '--name', name, '--model', model, '--effort', effort,
    ...(autocompact ? ['--autocompact', autocompact] : []),
    '--permission-mode', 'auto', '--remote-control', name, ...mcpArgs, '--append-system-prompt', scope, prompt];
}

export function launch(ctx, opts) {
  const r = call(ctx, launchArgs(opts));
  const id = r.code === 0 ? /\b[0-9a-f]{8}\b/.exec(r.stdout)?.[0] : null;
  return id ? { id } : { error: (r.stderr || r.stdout || `exit ${r.code}`).trim() };
}

export function listAgents(ctx) {
  const r = call(ctx, ['agents', '--json', '--all']);
  if (r.code !== 0) return { error: (r.stderr || `exit ${r.code}`).trim() };
  try {
    return JSON.parse(r.stdout).map(({ id, sessionId, name, state, cwd, startedAt }) => ({ id, sessionId, name, state, cwd, startedAt }));
  } catch { return { error: 'claude agents printed unreadable JSON' }; }
}

export const stop = (ctx, id) => call(ctx, ['stop', id]).code === 0;
export const logs = (ctx, id) => call(ctx, ['logs', id]).stdout;

export function loggedIn(ctx) {
  const r = call(ctx, ['auth', 'status', '--json']);
  try { return r.code === 0 && JSON.parse(r.stdout).loggedIn === true; } catch { return false; }
}

export function transcriptPath(configDir, sessionId) {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const p = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}
