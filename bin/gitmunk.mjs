#!/usr/bin/env node
// 🐿️ gitmunk installer: npx --allow-git=root github:amyteq/gitmunk
// Asks for channel, scope and agents, shows every step, asks once, then runs the Claude Code and Codex CLIs.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = 'amyteq/gitmunk';
// The CLI cannot add a catalog that sits at a path inside a repository, so beta is added by the file's URL.
const BETA_CATALOG = 'https://raw.githubusercontent.com/amyteq/gitmunk/develop/channels/beta/.claude-plugin/marketplace.json';
const CHANNELS = ['stable', 'beta'];
const SCOPES = ['user', 'project', 'local'];
const AGENTS = ['claude', 'codex'];
// Stands in for the Codex dev-skills folder until `codex plugin add` has created it.
export const CODEX_ROOT_LATER = '<installed dev-skills folder>';

export const USAGE = `Usage: npx --allow-git=root github:amyteq/gitmunk [options]

Install the gitmunk plugins for Claude Code and Codex. Without --yes it asks
three questions, shows every step and asks once before it changes anything.

Options:
  --channel stable|beta       stable: gitmunk at main (default); beta: gitmunk-beta at develop
  --scope user|project|local  where Claude Code records the plugins (default: user);
                              Codex installs per user, so it is set up only with user
  --agents claude,codex       agents to set up (default: every one found on PATH)
  --with-hooks                also install dev-hooks for Claude Code
  --yes                       run without questions, using the flags and defaults
  --dry-run                   print the plan and change nothing
  --help                      show this help
`;

class UsageError extends Error {}

export function parseFlags(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        channel: { type: 'string' },
        scope: { type: 'string' },
        agents: { type: 'string' },
        'with-hooks': { type: 'boolean' },
        yes: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.channel !== undefined) values.channel = oneOf('--channel', values.channel, CHANNELS);
  if (values.scope !== undefined) values.scope = oneOf('--scope', values.scope, SCOPES);
  if (values.agents !== undefined) values.agents = agentList('--agents', values.agents);
  return values;
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) throw new UsageError(`${name} must be one of ${allowed.join(', ')}, not "${value}"`);
  return value;
}

function agentList(name, value) {
  const list = [...new Set(value.split(',').map((a) => a.trim()))];
  if (!list.length || list.some((a) => !AGENTS.includes(a))) throw new UsageError(`${name} takes claude, codex or claude,codex, not "${value}"`);
  return AGENTS.filter((a) => list.includes(a));
}

/** Agent CLIs found as executable files on PATH; neither is run. */
export function findAgents(path = '') {
  const dirs = path.split(delimiter).filter(Boolean);
  return AGENTS.filter((name) => dirs.some((dir) => {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  }));
}

export function settingsFile(scope, env, cwd) {
  if (scope === 'project') return join(cwd, '.claude', 'settings.json');
  if (scope === 'local') return join(cwd, '.claude', 'settings.local.json');
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'settings.json');
}

/**
 * The ordered steps for the answers. Pure: the caller passes what it observed.
 * codex: { root } is the installed Codex dev-skills folder (null when not installed) and hasModules whether its node_modules exists.
 */
export function plan({ channel, scope, agents, withHooks = false, env = {}, cwd = '.', codex = { root: null, hasModules: false } }) {
  const steps = [];
  const notes = [];
  const plugins = withHooks ? ['dev-skills', 'dev-hooks'] : ['dev-skills'];
  if (agents.includes('claude')) {
    const beta = channel === 'beta';
    const marketplace = beta ? 'gitmunk-beta' : 'gitmunk';
    steps.push({ argv: ['claude', 'plugin', 'marketplace', 'add', beta ? BETA_CATALOG : `${REPO}#main`, '--scope', scope] });
    for (const p of plugins) steps.push({ argv: ['claude', 'plugin', 'install', `${p}@${marketplace}`, '--scope', scope] });
    // S3: switch the stable copies off at the same scope, as templates/claude/settings.beta.json does, so no skill loads twice.
    if (beta) for (const p of plugins) steps.push({ file: settingsFile(scope, env, cwd), key: `${p}@gitmunk` });
  }
  if (agents.includes('codex')) {
    if (scope !== 'user') {
      notes.push('Codex: skipped, because Codex installs plugins per user; run again with --scope user to add them.');
    } else {
      steps.push({ argv: ['codex', 'plugin', 'marketplace', 'add', REPO, '--ref', channel === 'beta' ? 'develop' : 'main'] });
      // A repeated add copies the plugin again and deletes its node_modules, so an installed copy is left alone.
      if (!codex.root) steps.push({ argv: ['codex', 'plugin', 'add', 'dev-skills@gitmunk'] });
      // Codex does not install plugin npm dependencies (#5).
      if (!codex.root || !codex.hasModules) steps.push({ argv: ['npm', 'ci', '--prefix', codex.root || CODEX_ROOT_LATER] });
    }
  }
  return { steps, notes };
}

export function describe(step) {
  if (step.file) return `set enabledPlugins["${step.key}"] to false in ${step.file}`;
  return step.argv.map((arg) => (arg === CODEX_ROOT_LATER || /^[\w@%+=:,./#-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(' ');
}

/** The parsed settings object, or {} when the file is missing; throws when it cannot be updated safely. */
function readSettings(file) {
  if (!existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message})`);
  }
  if (!isObject(data)) throw new Error(`${file} does not hold a JSON object`);
  if (data.enabledPlugins !== undefined && !isObject(data.enabledPlugins)) throw new Error(`${file}: enabledPlugins is not an object`);
  return data;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setFalse(file, key) {
  const data = readSettings(file);
  if (data.enabledPlugins?.[key] === false) return;
  data.enabledPlugins = { ...data.enabledPlugins, [key]: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** The installed Codex dev-skills folder, or null; reads `codex plugin list --json`. */
function codexRoot(env, cwd) {
  const listed = spawnSync('codex', ['plugin', 'list', '--json'], { env, cwd, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`codex plugin list --json failed with exit ${listed.status ?? listed.signal ?? listed.error?.code}`);
  let entry;
  try {
    entry = JSON.parse(listed.stdout).installed?.find((p) => p.pluginId === 'dev-skills@gitmunk');
  } catch (error) {
    throw new Error(`codex plugin list --json printed no JSON (${error.message})`);
  }
  if (!entry) return null;
  return join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'plugins', 'cache', 'gitmunk', 'dev-skills', String(entry.version));
}

function runSteps(steps, { env, cwd, out, err }) {
  for (const step of steps) {
    out(`\n→ ${describe(step)}`);
    if (step.file) {
      setFalse(step.file, step.key);
      continue;
    }
    let argv = step.argv;
    if (argv.includes(CODEX_ROOT_LATER)) {
      const root = codexRoot(env, cwd);
      if (!root) {
        err(`Codex lists no dev-skills@gitmunk, so the helpers were not installed. Run: npm ci --prefix "<installed dev-skills folder>"`);
        return 1;
      }
      argv = argv.map((arg) => (arg === CODEX_ROOT_LATER ? root : arg));
    }
    const result = spawnSync(argv[0], argv.slice(1), { env, cwd, stdio: 'inherit' });
    if (result.status !== 0) {
      err(`Stopped: \`${describe({ argv })}\` exited with ${result.status ?? result.signal ?? result.error?.code}. Later steps did not run.`);
      return 1;
    }
  }
  return 0;
}

async function choose(prompt, label, options, fallback) {
  const answer = (await prompt(`${label} (${options.join('/')}) [${fallback}]: `)).trim();
  return answer || fallback;
}

/**
 * Run the installer; returns the exit code.
 * io: env, cwd, isTTY, out/err (line writers) and prompt (question → answer), which tests inject.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  let rl;
  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      out(USAGE);
      return 0;
    }
    let prompt = io.prompt;
    if (!flags.yes && !prompt) {
      if (!(io.isTTY ?? process.stdin.isTTY)) throw new UsageError('stdin is not a terminal: pass --yes to run without questions');
      rl = createInterface({ input: process.stdin, output: process.stdout });
      prompt = (question) => rl.question(question);
    }
    const found = findAgents(env.PATH);
    const ask = !flags.yes;
    const channel = flags.channel ?? (ask ? oneOf('channel', await choose(prompt, 'Channel', CHANNELS, 'stable'), CHANNELS) : 'stable');
    const scope = flags.scope ?? (ask ? oneOf('scope', await choose(prompt, 'Scope', SCOPES, 'user'), SCOPES) : 'user');
    let agents = flags.agents ?? found;
    if (ask && !flags.agents && found.length) agents = agentList('agents', await choose(prompt, 'Agents', AGENTS, found.join(',')));
    if (!agents.length) {
      err('Found neither Claude Code (claude) nor Codex (codex) on PATH. Install one of them first.');
      return 1;
    }
    const missing = agents.filter((a) => !found.includes(a));
    if (missing.length) {
      err(`Not found on PATH: ${missing.join(', ')}.`);
      return 1;
    }
    const codex = { root: null, hasModules: false };
    if (agents.includes('codex') && scope === 'user') {
      codex.root = codexRoot(env, cwd);
      codex.hasModules = Boolean(codex.root) && existsSync(join(codex.root, 'node_modules'));
    }
    const { steps, notes } = plan({ channel, scope, agents, withHooks: Boolean(flags['with-hooks']), env, cwd, codex });
    for (const step of steps) if (step.file) readSettings(step.file); // refuse a file it cannot update before anything runs

    out(`gitmunk installer: channel ${channel}, scope ${scope}, agents ${agents.join(', ')}${flags['with-hooks'] ? ', with dev-hooks' : ''}`);
    out(steps.length ? 'Plan:' : 'Nothing to install.');
    steps.forEach((step, i) => out(`  ${i + 1}. ${describe(step)}`));
    for (const note of notes) out(note);
    if (flags['dry-run'] || !steps.length) return 0;
    if (ask) {
      const answer = (await prompt(`Run these ${steps.length} steps? [Y/n]: `)).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') {
        out('Nothing changed.');
        return 0;
      }
    }
    return runSteps(steps, { env, cwd, out, err });
  } catch (error) {
    err(error.message);
    if (error instanceof UsageError) {
      err(`\n${USAGE}`);
      return 2;
    }
    return 1;
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
