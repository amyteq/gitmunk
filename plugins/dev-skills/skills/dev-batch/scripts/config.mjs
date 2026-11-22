// Settings, invocation parsing, state paths and the ask round of /dev-batch (spec §6, §8).
// Pure over its inputs: nothing here reads process.env or the filesystem.
import { homedir } from 'node:os';
import { join } from 'node:path';

export class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };

const int = (name, min, max = Infinity) => (value) => {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  return n >= min && n <= max ? n : fail(`${name} must be an integer from ${min}${max < Infinity ? ` to ${max}` : ''}: ${value}`);
};
const oneOf = (name, ...allowed) => (value) => allowed.includes(value) ? value : fail(`${name} must be ${allowed.join(' or ')}: ${value}`);
const text = (name) => (value) => value.trim() ? value.trim() : fail(`${name} must not be empty`);

// Accepts a JSON array of directories or { alias, dir } objects, or a comma-separated list of directories.
function parseAccounts(value) {
  let items;
  if (value.trim().startsWith('[')) {
    try { items = JSON.parse(value); } catch { fail(`accounts is not valid JSON: ${value}`); }
  } else items = value.split(',').map((dir) => dir.trim());
  if (!Array.isArray(items) || items.length === 0) fail('accounts needs at least one config directory');
  const accounts = items.map((item, i) => {
    const entry = typeof item === 'string' ? { dir: item } : item;
    if (typeof entry?.dir !== 'string' || !entry.dir || (entry.alias !== undefined && (typeof entry.alias !== 'string' || !entry.alias)))
      fail(`accounts entry ${i + 1} must be a directory or { "alias", "dir" }`);
    return { alias: entry.alias ?? `A${i + 1}`, dir: entry.dir };
  });
  for (const key of ['alias', 'dir'])
    if (new Set(accounts.map((a) => a[key])).size !== accounts.length) fail(`accounts has a duplicate ${key}`);
  return accounts;
}

const home = (env) => env.HOME || homedir();

/** Every §8 key. `default` may be a function of the environment. */
export const SETTINGS = [
  { key: 'cap', env: 'DEV_BATCH_CAP', default: 4, parse: int('cap', 1) },
  { key: 'usage_cap', env: 'DEV_BATCH_USAGE_CAP', default: 80, parse: int('usage_cap', 1, 100) },
  { key: 'accounts', env: 'DEV_BATCH_ACCOUNTS', default: (env) => [{ alias: 'A1', dir: env.CLAUDE_CONFIG_DIR || join(home(env), '.claude') }], parse: parseAccounts },
  { key: 'merge', env: 'DEV_BATCH_MERGE', default: 'auto', parse: oneOf('merge', 'auto', 'off') },
  { key: 'reviewer', env: 'DEV_BATCH_REVIEWER', default: 'codex', parse: oneOf('reviewer', 'codex', 'claude') },
  { key: 'writer', env: 'DEV_BATCH_WRITER', default: 'claude', parse: oneOf('writer', 'codex', 'claude') },
  { key: 'rounds', env: 'DEV_BATCH_ROUNDS', default: 10, parse: int('rounds', 1) },
  { key: 'model', env: 'DEV_BATCH_MODEL', default: 'opus', parse: text('model') },
  { key: 'effort', env: 'DEV_BATCH_EFFORT', default: 'xhigh', parse: text('effort') },
  ...['reviewer_model', 'reviewer_effort', 'writer_model', 'writer_effort']
    .map((key) => ({ key, env: `DEV_BATCH_${key.toUpperCase()}`, default: null, parse: text(key) })),
  { key: 'autocompact', env: 'DEV_BATCH_AUTOCOMPACT', default: '300k',
    parse: (v) => v === 'auto' || (/^\d+k$/.test(v) && parseInt(v, 10) >= 100) ? v : fail(`autocompact must be auto or at least 100k, like 300k: ${v}`) },
  { key: 'abbr', env: 'DEV_BATCH_ABBR', default: null, parse: (v) => /^[a-z0-9]{1,8}$/i.test(v) ? v : fail(`abbr must be 1-8 letters or digits: ${v}`) },
  { key: 'mcp', env: 'DEV_BATCH_MCP', default: 'none',
    parse: (v) => v === 'none' || v === 'inherit' || /\.json$/.test(v) && !v.split('/').includes('..') ? v : fail(`mcp must be none, inherit or a path to a .json file: ${v}`) },
];

const SUBS = ['status', 'init', 'add', 'rm', 'pause', 'resume', 'config', 'clear', 'handover', 'takeover', 'setup'];
const SUB_KEYS = ['src', 'label', 'milestone', 'pos', 'deps', 'task', 'stop', 'acct', 'session', 'force', 'apply', 'confirm'];
const KEYS = new Set([...SETTINGS.map((s) => s.key), ...SUB_KEYS]);

/** `<sub> key=value… extra="…"` → { sub, args, extra }. Unknown sub-commands and keys throw. */
export function parseInvocation(input) {
  const words = [...input.matchAll(/([^\s="]+)=(?:"([^"]*)"|(\S*))|(\S+)/g)]
    .map((m) => m[1] === undefined ? { key: m[4], hasValue: false } : { key: m[1], value: m[2] ?? m[3], hasValue: true });
  let sub = 'status';
  if (words.length && !words[0].hasValue) {
    sub = words.shift().key;
    if (!SUBS.includes(sub)) fail(`unknown sub-command "${sub}"; expected one of ${SUBS.join(', ')}`);
  }
  const args = {}; let extra = null;
  for (const { key, value, hasValue } of words) {
    if (!hasValue) fail(`expected key=value, got "${key}"`);
    if (key === 'extra') extra = value;
    else if (KEYS.has(key)) args[key] = value;
    else fail(`unknown key "${key}"`);
  }
  return { sub, args, extra };
}

/** args (strings from the invocation) > env > default. Returns parsed values, where each came from, and warnings. */
export function resolveSettings(args, env) {
  const values = {}; const sources = {}; const warnings = [];
  for (const { key, env: name, default: dflt, parse } of SETTINGS) {
    const [raw, source] = args[key] !== undefined ? [args[key], 'argument'] : env[name] !== undefined && env[name] !== '' ? [env[name], 'environment'] : [undefined, 'default'];
    try {
      values[key] = raw === undefined ? (typeof dflt === 'function' ? dflt(env) : dflt) : parse(String(raw));
    } catch (error) {
      if (error instanceof InputError && source === 'environment') error.message = `${name}: ${error.message}`;
      throw error;
    }
    sources[key] = source;
  }
  if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) warnings.push(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=${env.CLAUDE_CODE_AUTO_COMPACT_WINDOW} is set and overrides --autocompact`);
  return { values, sources, warnings };
}

/** Initials of the hyphen/underscore/dot-separated words; one word gives its first two letters. */
export function deriveAbbr(repoName) {
  const words = repoName.toLowerCase().split(/[-_.]+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 2);
}

export const srcKey = ({ kind, number, id }) =>
  kind === 'issue' ? `i${number}` : kind === 'discussion' ? `d${number}` : kind === 'comment' ? `c${id}` : fail(`unknown source kind: ${kind}`);

export const repoStateDir = ({ owner, repo }, env) =>
  join(env.XDG_STATE_HOME || join(home(env), '.local', 'state'), 'dev-batch', owner, repo);
export const stateDir = ({ owner, repo, src }, env) => join(repoStateDir({ owner, repo }, env), srcKey(src));

const opt = (value, label = value) => ({ value, label });
const modelEffort = ({ values }) => [opt(`${values.model} ${values.effort}`, `${values.model} · ${values.effort}`),
  opt(`${values.model} high`, `${values.model} · high`)].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);

/**
 * The one ask round (§6): questions for what is still missing, recommended first, at most 4.
 * A value given as an argument is not asked again. context: { args, candidates, accounts, batches, foreignLease }.
 */
export function askQuestions(sub, resolved, context = {}) {
  const args = context.args ?? {};
  if (args.confirm === 'no') {
    if (sub === 'init' && args.src === undefined) fail('init needs src= when confirm=no skips the questions');
    return [];
  }
  const { values, sources } = resolved;
  const missing = (...keys) => keys.every((k) => args[k] === undefined);
  const q = [];
  if (sub === 'init') {
    const settingsText = SETTINGS.filter((s) => !['cap', 'merge', 'model', 'effort'].includes(s.key))
      .map((s) => `${s.key}=${JSON.stringify(values[s.key])} (${sources[s.key]})`).join(', ');
    if (missing('src')) q.push({ key: 'src', question: `Which issue or discussion is the source? Other settings: ${settingsText}`, options: context.candidates ?? [] });
    if (missing('merge')) q.push({ key: 'merge', question: 'Merge approval-eligible PRs automatically?', options: [opt('auto', 'auto (merge under your authorization)'), opt('off', 'off (you merge by hand)')] });
    if (missing('cap')) q.push({ key: 'cap', question: 'How many worker sessions at once?', options: ['4', '2', '6'].map((v) => opt(v)) });
    if (missing('model', 'effort')) q.push({ key: 'model_effort', question: 'Model and effort for every session?', options: modelEffort(resolved) });
    if (q.length && q[0].key !== 'src') q[0].question += ` Other settings: ${settingsText}`;
  } else if (sub === 'add') {
    if (missing('src')) q.push({ key: 'src', question: 'Which issues to add?', options: context.candidates ?? [] });
    if (missing('pos')) q.push({ key: 'pos', question: 'Where do they go?', options: [opt('end'), opt('top'), opt('after', 'after a row')] });
    if (missing('deps')) q.push({ key: 'deps', question: 'Dependencies for the new rows?', options: [opt('analyse'), opt('none')] });
  } else if (sub === 'rm') {
    if (missing('task')) q.push({ key: 'task', question: 'Which row to remove?', options: context.candidates ?? [] });
    if (missing('stop')) q.push({ key: 'stop', question: 'Stop its running session?', options: [opt('no'), opt('yes')] });
  } else if (sub === 'config') {
    if (!Object.keys(args).some((k) => SETTINGS.some((s) => s.key === k))) {
      const keep = (key, alternatives) => ({ key, question: `${key} (now ${values[key]}, ${sources[key]})?`, options: [opt('keep', `keep ${values[key]}`), ...alternatives.map((v) => opt(v))] });
      q.push(keep('cap', ['2', '6']), keep('usage_cap', ['70', '90']), keep('merge', [values.merge === 'auto' ? 'off' : 'auto']),
        { key: 'model_effort', question: `model · effort (now ${values.model} · ${values.effort})?`, options: [opt('keep', 'keep'), ...modelEffort(resolved)] });
    }
  } else if (sub === 'handover') {
    if (missing('acct')) q.push({ key: 'acct', question: 'Hand over to which account?', options: context.accounts ?? [] });
  } else if (sub === 'takeover') {
    if (missing('src', 'session') && (context.batches?.length ?? 0) > 1) q.push({ key: 'src', question: 'Take over which batch?', options: context.batches });
    if (missing('force') && context.foreignLease) q.push({ key: 'force', question: 'The lease belongs to another host. Take it anyway?', options: [opt('no'), opt('yes')] });
  } else if (sub === 'setup') {
    if (missing('acct')) q.push({ key: 'acct', question: 'Which accounts?', options: [opt('all', 'all configured'), opt('this', 'this one')] });
    if (missing('apply')) q.push({ key: 'apply', question: 'Write the changes or only show them?', options: [opt('no', 'show only'), opt('yes', 'write')] });
  }
  return q.slice(0, 4);
}
