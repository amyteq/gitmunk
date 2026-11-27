import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { pickTarget, splitInvocation } from '../../dev-explain/scripts/check-explain.mjs';

// Deterministic decisions for dev-reply: resolving the invocation, and finding the unanswered mentions of
// one login in raw GitHub reads with where each reply goes. Target parsing is dev-explain's. Pure functions;
// only the CLI reads files. Exit 0 proceeds, 1 stops, and 2 means the check did not run, which never passes.

export const DEFAULT_SINCE = '5d';
const SINCE = /^([1-9]\d{0,3})([dh])$/;
// A comment URL of an issue or PR: dev-explain's parser ignores these fragments, dev-reply narrows to them.
const COMMENT_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)#(issuecomment-|discussion_r)([1-9]\d*)$/;
const CC_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull|discussions)\/([1-9]\d*)(#\S*)?$/;
// The Ask workflow starts an agent on `@claude` or `@codex` followed by a word boundary (agent_lib.py).
const AGENT_TRIGGER = /^(claude|codex)\b/i;

const stop = (reason, detail) => ({ action: 'stop', reason, detail });

function sinceOf(given, warnings) {
  if (given.length === 1 && SINCE.test(given[0])) return { value: given[0], source: 'argument' };
  if (given.length) warnings.push(`since= ${given.length > 1 ? `was given ${given.length} times` : `"${given[0]}" is not Nd or Nh`}; using ${DEFAULT_SINCE} (default)`);
  return { value: DEFAULT_SINCE, source: 'default' };
}

const hoursOf = (since) => { const [, n, unit] = SINCE.exec(since); return Number(n) * (unit === 'd' ? 24 : 1); };

/** One `cc=` item: #N or N of this repository, or an issue, PR or discussion URL of any repository. */
export function parseCc(item, repo) {
  const local = /^#?([1-9]\d*)$/.exec(item);
  if (local) return Number.isSafeInteger(Number(local[1])) ? { repo, number: Number(local[1]), kind: 'any', here: true } : null;
  const url = CC_URL.exec(item);
  if (!url || !Number.isSafeInteger(Number(url[3]))) return null;
  const here = url[1].toLowerCase() === repo.toLowerCase();
  return { repo: here ? repo : url[1], number: Number(url[3]), kind: url[2] === 'discussions' ? 'discussion' : 'issue-or-pr', here };
}

/**
 * Resolve the invocation: an optional target, cc=, since= and dry-run in any order, then the notes. No target
 * means every open issue, PR and discussion of the repository. A comment URL narrows the run to that comment.
 */
export function resolveArgs({ repo, text, now }) {
  const split = splitInvocation(text, repo, { options: ['cc', 'since'], flags: ['dry-run'] });
  if (split.action === 'stop') return split;
  const warnings = [];
  const head = split.notes ? text.slice(0, text.lastIndexOf(split.notes)) : text;
  const fragments = new Map();
  for (const token of head.match(/\S+/g) ?? []) {
    const m = COMMENT_URL.exec(token);
    if (m && m[1].toLowerCase() === repo.toLowerCase() && Number.isSafeInteger(Number(m[5]))) {
      if (m[4] === 'discussion_r' && m[2] !== 'pull') return stop('bad-target', `"${token}" names a review comment on an issue`);
      fragments.set(Number(m[3]), { comment: Number(m[5]), commentKind: m[4] === 'discussion_r' ? 'review-comment' : 'issue-comment' });
    }
  }
  const targets = split.targets.map((t) => {
    const fragment = t.kind === 'issue-or-pr' ? fragments.get(t.number) : undefined;
    if (t.kind === 'discussion' && t.comment) return { ...t, commentKind: 'discussion-comment' };
    if (!fragment) return t;
    const { warning, ...rest } = t;
    return { ...rest, ...fragment };
  });
  let target = null;
  if (targets.length) {
    target = pickTarget(targets, [], warnings);
    if (target.action === 'stop') return target;
  }
  const cc = [];
  for (const item of split.options.cc.flatMap((value) => value.split(',')).filter(Boolean)) {
    const parsed = parseCc(item, repo);
    if (!parsed) return stop('bad-cc', `cc="${item}" is not #N, N or an issue, PR or discussion URL`);
    if (!cc.some((c) => c.repo.toLowerCase() === parsed.repo.toLowerCase() && c.number === parsed.number)) cc.push(parsed);
  }
  const since = sinceOf(split.options.since, warnings);
  const cutoff = new Date(Date.parse(now) - hoursOf(since.value) * 3600 * 1000).toISOString();
  return { action: 'proceed', target, cc, since, cutoff, dryRun: split.flags.includes('dry-run'), notes: split.notes, warnings };
}

// ── Mentions ─────────────────────────────────────────────────────────────────────────────────────

// Code, quoted text, HTML and link text never mention anyone a reply should answer.
const SKIP = new Set(['code', 'inlineCode', 'html', 'blockquote', 'link', 'linkReference', 'definition', 'image', 'imageReference']);
// Raw <a> and <code> tags sit in HTML nodes apart from the text they wrap, and GitHub keeps an unclosed one
// open across blocks, so count them in document order over every HTML node and drop text while one is open.
// Every tag is matched whole, quoted values included, so a value such as title="<code>" is no tag of its own.
// A tag name runs to whitespace, `/` or `>`, as in HTML's tokenizer; the lookahead stops it backtracking shorter.
const TAG = /<(\/?)([a-z][^\s/>]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/gi;
const HIDING = new Set(['a', 'code']);
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// GitHub also links a bare URL (a GFM autolink literal) that CommonMark leaves as text: `http(s)://` after anything
// but a letter, or `www.` after whitespace, `*`, `_`, `~` or `(`; then a domain with no `_` in its last two labels;
// then on to whitespace or `<`. It spans the source, emphasis, code and character references inside it included, so
// each URL that starts in shown text is cut out of every text node it reaches.
const BARE_URL = /(?:(?<![a-z])https?:\/\/|(?<![^\s*_~(])www\.)(?:(?:[\p{L}\p{N}_-]+\.)*[\p{L}\p{N}-]+\.)?[\p{L}\p{N}-]+(?!\.?[\p{L}\p{N}_-])[^\s<]*/giu;
function plain(node, state, quiet = false) {
  if (node.type === 'html') {
    for (const [, close, name, selfClosing] of node.value.replace(HTML_COMMENT, '').matchAll(TAG)) {
      if (HIDING.has(name.toLowerCase()) && !selfClosing) state.open = Math.max(0, state.open + (close ? -1 : 1));
    }
  }
  const skip = quiet || SKIP.has(node.type);
  if (node.type === 'text') {
    if (skip || state.open) return ' ';
    const { start: { offset: s }, end: { offset: e } } = node.position;
    const cuts = state.urls.filter(([a]) => a >= s && a < e);
    if (state.urlEnd > s) cuts.unshift([s, state.urlEnd]);
    if (!cuts.length) return node.value;
    let text = state.src.slice(s, e);
    for (const [a, b] of cuts) {
      text = text.slice(0, a - s) + ' '.repeat(Math.min(b, e) - a) + text.slice(Math.min(b, e) - s);
      state.urlEnd = Math.max(state.urlEnd, b);
    }
    return text;
  }
  return (node.children ?? []).map((child) => plain(child, state, skip)).join(' ');
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a Markdown body mentions `login` directly (not a team, an email or a path). */
export function mentions(body, login) {
  const re = new RegExp(`(?<![\\w\`/.@-])@${escapeRe(login)}(?![\\w-]|/\\w)`, 'i');
  const src = body ?? '';
  const urls = [...src.matchAll(BARE_URL)].map((m) => [m.index, m.index + m[0].length]);
  return re.test(plain(fromMarkdown(src), { open: 0, src, urls, urlEnd: 0 }));
}

/** How a reply names its sender: `@login` for a person; a bot or agent trigger stays in a code span. */
export function replyMention(login, bot) {
  return bot || AGENT_TRIGGER.test(login) || login.endsWith('[bot]') ? `\`@${login}\`` : `@${login}`;
}

const who = (user) => ({ author: user?.login ?? 'ghost', bot: user?.type === 'Bot' || user?.__typename === 'Bot' || Boolean(user?.login?.endsWith('[bot]')) });
const flat = (pages) => (pages ?? []).flat();

// Every text of one thread as { place, id, url, createdAt, body, author, bot, key, in }: `key` is the reply
// thread whose later comment of the login answers it, `in` the threads its own text answers.
function itemsOf(thread) {
  if (thread.discussion) {
    const d = thread.discussion;
    const items = [{ place: 'body', id: d.id, url: d.url, createdAt: d.createdAt, body: d.body, ...who(d.author), key: 'main', in: ['main'], route: { kind: 'discussion-comment', discussionId: d.id } }];
    for (const c of d.comments?.nodes ?? []) {
      const t = `c${c.id}`;
      const route = { kind: 'discussion-reply', discussionId: d.id, replyToId: c.id };
      items.push({ place: 'discussion-comment', id: c.databaseId, url: c.url, createdAt: c.createdAt, body: c.body, ...who(c.author), key: t, in: ['main', t], route });
      for (const r of c.replies?.nodes ?? []) items.push({ place: 'discussion-reply', id: r.databaseId, url: r.url, createdAt: r.createdAt, body: r.body, ...who(r.author), key: t, in: [t], route });
    }
    return { number: d.number, kind: 'discussion', title: d.title, url: d.url, items };
  }
  const issue = thread.issue;
  const conversation = { kind: 'issue-comment', number: issue.number };
  const items = [{ place: 'body', id: issue.id, url: issue.html_url, createdAt: issue.created_at, body: issue.body, ...who(issue.user), key: 'main', in: ['main'], route: conversation }];
  for (const c of flat(thread.comments)) items.push({ place: 'comment', id: c.id, url: c.html_url, createdAt: c.created_at, body: c.body, ...who(c.user), key: 'main', in: ['main'], route: conversation });
  // A pending review has no submitted_at, so the window check drops it.
  for (const r of flat(thread.reviews)) items.push({ place: 'review', id: r.id, url: r.html_url, createdAt: r.submitted_at, body: r.body, ...who(r.user), key: 'main', in: ['main'], route: conversation });
  for (const c of flat(thread.reviewComments)) {
    const root = c.in_reply_to_id ?? c.id;
    items.push({ place: 'review-comment', id: c.id, url: c.html_url, createdAt: c.created_at, body: c.body, ...who(c.user), key: `r${root}`, in: [`r${root}`], route: { kind: 'review-reply', number: issue.number, commentId: root } });
  }
  return { number: issue.number, kind: issue.pull_request ? 'pr' : 'issue', title: issue.title, url: issue.html_url, items };
}

// The places a named comment of each kind can be: a discussion comment's URL also names its replies.
const PLACES = { 'issue-comment': ['comment'], 'review-comment': ['review-comment'], 'discussion-comment': ['discussion-comment', 'discussion-reply'] };
const named = (item, comment) => item.id === comment.id && PLACES[comment.kind].includes(item.place);

/**
 * The unanswered mentions of `login` per thread: written by someone else at or after `cutoff`, with no
 * later text of `login` in the same reply thread. A named comment narrows the scan to itself under the same
 * rules; when it is not taken, `named` says why. Mentions are grouped by reply route and sender, one reply each.
 */
export function scan({ login, cutoff, threads, comment = null }) {
  const self = (item) => item.author.toLowerCase() === login.toLowerCase();
  const topics = [];
  let namedReason = 'not-found';
  for (const thread of threads) {
    const { items, ...topic } = itemsOf(thread);
    // An approval without a body is not text, so it answers nothing.
    const answers = (later, item) => self(later) && Boolean(later.body?.trim()) && later.in.includes(item.key) && Date.parse(later.createdAt) > Date.parse(item.createdAt);
    const why = (item) => (self(item) ? 'own-text'
      : !(Date.parse(item.createdAt) >= Date.parse(cutoff)) ? 'before-cutoff'
        : !mentions(item.body, login) ? 'no-mention'
          : items.some((later) => answers(later, item)) ? 'answered' : null);
    const pending = items.filter((item) => {
      if (comment && !named(item, comment)) return false;
      const reason = why(item);
      if (comment) namedReason = reason;
      return !reason;
    });
    if (!pending.length) continue;
    const groups = [];
    for (const item of pending) {
      const id = JSON.stringify(item.route) + item.author;
      let group = groups.find((g) => g.id === id);
      if (!group) groups.push(group = { id, route: item.route, sender: item.author, bot: item.bot, mention: replyMention(item.author, item.bot), comments: [] });
      group.comments.push({ place: item.place, id: item.id, url: item.url, createdAt: item.createdAt });
    }
    topics.push({ ...topic, mentions: pending.length, groups: groups.map(({ id, ...g }) => g) });
  }
  return comment && !topics.length ? { topics, named: namedReason } : { topics };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
const isString = (v) => typeof v === 'string';
const isTime = (v) => isString(v) && !Number.isNaN(Date.parse(v));
const isLogin = (v) => isString(v) && /^[A-Za-z0-9-]+$/.test(v);
const isThread = (t) => t && typeof t === 'object' && (Boolean(t.discussion?.id) || Number.isSafeInteger(t.issue?.number));
const SCHEMAS = {
  args: { repo: (v) => isString(v) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v), text: isString, now: isTime },
  scan: {
    login: isLogin,
    cutoff: isTime,
    threads: (v) => Array.isArray(v) && v.every(isThread),
    comment: (v) => v === undefined || v === null || (Number.isSafeInteger(v?.id) && ['issue-comment', 'review-comment', 'discussion-comment'].includes(v?.kind)),
  },
};
const OPTIONAL = new Set(['comment']);
const RUN = {
  args: (input) => { const result = resolveArgs(input); return [result.action === 'proceed', result]; },
  scan: (input) => [true, scan(input)],
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
    for (const [key, valid] of Object.entries(schema)) {
      if (!(OPTIONAL.has(key) && input[key] === undefined) && !valid(input[key])) throw new Error(`input.${key} is missing or invalid`);
    }
  } catch (error) {
    console.error(`check-reply: ${error.message}\nUsage: node check-reply.mjs <args|scan> --input FILE.json`);
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
