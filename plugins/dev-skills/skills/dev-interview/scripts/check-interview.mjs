import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { REJECTION, canonicalLanguage, pickTarget, resolveOption, splitInvocation } from '../../dev-explain/scripts/check-explain.mjs';
import { detectLang } from '../../dev-merge/scripts/check-merge.mjs';

// Deterministic decisions for dev-interview: resolving the invocation and the two languages. Target
// parsing, the type option and the language-tag check are dev-explain's; Chinese-or-English is dev-merge's.
// Exit 0 proceeds, 1 stops, and 2 means the check did not run, which never counts as a pass.

export const FALLBACK = 'zh-CN';
const FLAGS = ['linked', 'dry-run'];

// Code of every form, HTML and markers, and links, images and reference definitions with their labels.
const NOT_PROSE = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference', 'definition']);
function proseOf(node) {
  if (NOT_PROSE.has(node.type)) return '';
  // GFM's bare links and emails stay plain text in a CommonMark tree, so a token holding `://`, `www.` or an
  // email shape is a link, whatever wraps it. shortcut: a word glued to such a token with no space is dropped
  // with it, which only affects this language guess; upgrade to the GFM parser extensions if that ever matters.
  if (node.type === 'text') return node.value.replace(/\S*(?::\/\/|www\.|[\w.+-]@[\w-]+\.\w)\S*/g, '');
  const text = (node.children ?? []).map(proseOf).join(' ');
  // A list item's leading `[ ]`, `[x]` or `[X]` is a task status mark, not prose.
  return node.type === 'listItem' ? text.replace(/^\[[ xX]\](?!\S)/, '') : text;
}

/** The language of a text's prose: zh-CN for Chinese, en otherwise, or null when it has no prose. */
export function proseLanguage(text) {
  const lang = detectLang(proseOf(fromMarkdown(text)), null);
  return lang && (lang === 'zh' ? 'zh-CN' : 'en');
}

// The first link that yields a language, or null. A rejected or repeated value warns and falls through.
function chain(links, warnings) {
  for (const link of links) {
    if ('text' in link) {
      const value = proseLanguage(link.text);
      if (value) return { value, source: link.source };
    } else if (link.values.length > 1) {
      warnings.push(`${link.name}= was given ${link.values.length} times (${link.values.map((v) => `"${v}"`).join(', ')}); ignored`);
    } else if (link.values.length === 1) {
      const value = canonicalLanguage(link.values[0]);
      if (value) return { value, source: link.source };
      warnings.push(`${link.name}="${link.values[0]}" ${REJECTION.lang(link.values[0])}; ignored`);
    }
  }
  return null;
}

const pending = { value: null, source: 'source' };

/**
 * Resolve the invocation: target, type=, linked, ask-lang=, note-lang= and dry-run in any order, then the
 * notes. A language that no argument, variable or (for popups) session text settles is `pending`: the
 * `lang` command decides it from the target's text (popups) or each source's text (notes).
 */
export function resolveArgs({ repo, text, candidates, askEnv, noteEnv, sessionText }) {
  const split = splitInvocation(text, repo, { options: ['type', 'ask-lang', 'note-lang'], flags: FLAGS });
  if (split.action === 'stop') return split;
  const warnings = [];
  const target = pickTarget(split.targets, candidates, warnings);
  if (target.action === 'stop') return target;
  const type = resolveOption('type', split.options.type, '', warnings);
  const ask = chain([
    { source: 'argument', name: 'ask-lang', values: split.options['ask-lang'] },
    { source: 'environment', name: 'DEV_INTERVIEW_ASK_LANG', values: askEnv ? [askEnv] : [] },
    { source: 'session', text: sessionText },
  ], warnings) ?? pending;
  const note = chain([
    { source: 'argument', name: 'note-lang', values: split.options['note-lang'] },
    { source: 'environment', name: 'DEV_INTERVIEW_NOTE_LANG', values: noteEnv ? [noteEnv] : [] },
  ], warnings) ?? pending;
  const [linked, dryRun] = FLAGS.map((flag) => split.flags.includes(flag));
  return { action: 'proceed', target, type, linked, dryRun, ask, note, notes: split.notes, warnings };
}

/** The last links of both chains: the source text's language, else zh-CN. */
export function sourceLanguage(text) {
  const value = proseLanguage(text);
  return value ? { value, source: 'source' } : { value: FALLBACK, source: 'default' };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
const isString = (v) => typeof v === 'string';
const SCHEMAS = {
  args: {
    repo: (v) => isString(v) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v),
    text: isString,
    candidates: (v) => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && n > 0),
    askEnv: isString,
    noteEnv: isString,
    sessionText: isString,
  },
  lang: { text: isString },
};
const RUN = {
  args: (input) => { const result = resolveArgs(input); return [result.action === 'proceed', result]; },
  lang: ({ text }) => [true, sourceLanguage(text)],
};

export function main(argv) {
  const [command, flag, file] = argv;
  let input;
  try {
    if (!Object.hasOwn(RUN, command ?? '') || flag !== '--input' || !file || argv.length !== 3) throw new Error('bad arguments');
    input = JSON.parse(readFileSync(file, 'utf8'));
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('--input must hold a JSON object');
    const schema = SCHEMAS[command];
    for (const key of Object.keys(input)) if (!Object.hasOwn(schema, key)) throw new Error(`input has the unknown key "${key}"`);
    for (const [key, valid] of Object.entries(schema)) if (!valid(input[key])) throw new Error(`input.${key} is missing or invalid`);
  } catch (error) {
    console.error(`check-interview: ${error.message}\nUsage: node check-interview.mjs <args|lang> --input FILE.json`);
    return 2;
  }
  const [proceed, result] = RUN[command](input);
  console.log(JSON.stringify(result));
  return proceed ? 0 : 1;
}

function isDirectInvocation(entryPath) {
  try { return Boolean(entryPath) && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = main(process.argv.slice(2));
