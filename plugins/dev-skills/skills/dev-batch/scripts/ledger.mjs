import { fromMarkdown } from 'mdast-util-from-markdown';

// The batch ledger region kept in an issue or discussion body: find, parse, render, splice, and detect the
// owner's hand edits (§7 of the design). Pure functions, no I/O.

export const STATUS = { queued: '🆕', waiting: '⏳', refining: '🔍', implementing: '🛠️', reviewing: '🔄', merging: '🔀', merged: '✅', owner: '👤', blocked: '⛔', hold: '⏸️', removed: '⏭️' };
const OPEN = '<!-- dev-batch:ledger v=1 -->';
const CLOSE = '<!-- /dev-batch:ledger -->';
const LEGEND = 'Status: 🆕 queued · ⏳ waiting on dependencies · 🔍 refining · 🛠️ implementing · 🔄 in review · 🔀 merging · ✅ merged · 👤 needs the owner · ⛔ blocked · ⏸️ on hold · ⏭️ removed';
const LOOP = { running: '🟢', paused: '🟡', stopped: '🔴' };
const ROLL_ORDER = ['merged', 'merging', 'reviewing', 'implementing', 'refining', 'queued', 'waiting', 'owner', 'blocked', 'hold', 'removed'];
const LOG_KEEP = 20;
const bare = (s) => s.replaceAll('️', '');
const byEmoji = new Map(Object.entries(STATUS).map(([k, v]) => [bare(v), k]));

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Line indexes inside code blocks, as dev-track finds them: a quoted marker is never the region.
function codeLines(text) {
  const code = new Set();
  const pending = [fromMarkdown(text)];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'code') for (let l = node.position.start.line; l <= node.position.end.line; l++) code.add(l - 1);
    if (node.children) pending.push(...node.children);
  }
  return code;
}

export function findRegion(body) {
  const code = codeLines(body);
  const opens = [], closes = [];
  let offset = 0;
  body.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!code.has(i)) {
      if (line.trim() === OPEN) opens.push(offset + raw.length - raw.trimStart().length);
      else if (line.trim() === CLOSE) closes.push(offset + line.trimEnd().length);
    }
    offset += raw.length + 1;
  });
  if (opens.length > 1 || closes.length > 1) return { error: 'multiple' };
  if (!opens.length && !closes.length) return null;
  if (!opens.length || !closes.length || closes[0] < opens[0]) return { error: 'unclosed' };
  return { start: opens[0], end: closes[0] };
}

const escapeCell = (s) => String(s).replaceAll('|', '\\|');
// Splits on unescaped `|`, tolerating a missing leading or trailing pipe and extra spaces.
function cells(line) {
  const parts = line.trim().replace(/^\|/, '').split(/(?<!\\)\|/);
  if (parts.length > 1 && parts.at(-1).trim() === '') parts.pop();
  return parts.map((c) => c.trim().replaceAll('\\|', '|'));
}

const dash = (s) => (s === '—' || s === '' ? '' : s);

export function parseLedger(regionText, { previous } = {}) {
  const lines = regionText.split(/\r?\n/);
  const problems = [];
  const ledger = { header: { coordinator: null, alias: null, loop: null, cap: null, merge: null, changed: null, waiting: 0 }, authorization: null, rows: [], log: [] };
  let inLog = false;
  for (const line of lines) {
    if (line.startsWith('<details')) inLog = true;
    if (line.startsWith('Coordinator:')) {
      const [alias, coord, loop, cap, merge, ...changed] = line.slice('Coordinator:'.length).split(' · ').map((s) => s.trim());
      Object.assign(ledger.header, {
        alias, coordinator: coord?.replaceAll('`', ''), loop: /running|paused|stopped/.exec(loop ?? '')?.[0] ?? null,
        cap: Number(/\d+/.exec(cap ?? '')?.[0]), merge: merge?.replace(/^merge /, ''), changed: changed.join(' · ').replace(/^changed /, ''),
      });
    } else if (line.startsWith('Owner authorization')) ledger.authorization = line;
    else if (line.startsWith('Roll call:')) ledger.header.waiting = Number(/❗ (\d+)/.exec(line)?.[1] ?? 0);
    else if (line.trimStart().startsWith('|')) {
      const c = cells(line);
      if (/^:?-+:?$/.test(c[0]) || c[0] === '#' || c[0] === 'Time (UTC)') continue;
      if (inLog) { ledger.log.push({ time: c[0], event: c.slice(1).join(' | ') }); continue; }
      const n = Number(c[0]);
      // `#42 Title`, `42 Title`, `[#42](…/issues/42) Title` or an issues URL.
      const cell = c[1] ?? '';
      const task = /^\[#?(\d+)\]\([^)]*\)\s*(.*)$/.exec(cell) ?? /^https?:\/\/\S*\/issues\/(\d+)\S*\s*(.*)$/.exec(cell) ?? /^#?(\d+)\s*(.*)$/.exec(cell);
      if (!task) {
        // Keep the previous row so a typo is never read as a deletion.
        problems.push({ row: n, reason: 'unreadable task cell' });
        const was = previous?.rows.find((r) => r.n === n);
        if (was) ledger.rows.push(structuredClone(was));
        continue;
      }
      const issue = Number(task[1]);
      const emoji = bare(c[4] ?? '');
      let status = byEmoji.get(emoji);
      if (!status) {
        problems.push({ row: n, reason: `unknown status ${emoji}` });
        status = previous?.rows.find((r) => r.issue === issue)?.status ?? null;
      }
      const pr = /^#(\d+)(?:\s*·\s*`([^`]*)`)?/.exec(c[5] ?? '');
      ledger.rows.push({
        n, issue, title: task[2], deps: [...(c[2] ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
        batch: Number(/\d+/.exec(c[3] ?? '')?.[0]), status, pr: pr ? Number(pr[1]) : null, head: pr?.[2] ?? null,
        session: dash(c[6] ?? '') || null, next: dash(c.slice(7).join(' | ')),
      });
    }
  }
  return { ledger, problems };
}

export function renderLedger(ledger, { eol = '\n' } = {}) {
  const { header: h, rows } = ledger;
  const counts = ROLL_ORDER.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n);
  const roll = [`${rows.length} tasks`, ...counts.map(([s, n]) => `${STATUS[s]} ${n}`), `❗ ${h.waiting} events waiting`].join(' · ');
  const out = [
    OPEN, '### Batch ledger', '',
    `Coordinator: ${h.alias} · \`${h.coordinator}\` · ${LOOP[h.loop]} ${h.loop} · cap ${h.cap} · merge ${h.merge} · changed ${h.changed}`,
    ...(ledger.authorization == null ? [] : [ledger.authorization]),
    `Roll call: ${roll}`, '', LEGEND, '',
    '| # | Task | Deps | Batch | Status | PR · head | Session | Next |', '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.n} | #${r.issue} ${escapeCell(r.title)} | ${r.deps.map((d) => `#${d}`).join(', ') || '—'} | B${r.batch} | ${STATUS[r.status]} | ${
      r.pr == null ? '—' : `#${r.pr}${r.head ? ` · \`${r.head}\`` : ''}`} | ${r.session ?? '—'} | ${escapeCell(r.next) || '—'} |`),
    '', '<details><summary>Log</summary>', '', '| Time (UTC) | Event |', '|---|---|',
    ...ledger.log.slice(-LOG_KEEP).map((e) => `| ${e.time} | ${escapeCell(e.event)} |`),
    '', '</details>', CLOSE,
  ];
  return out.join(eol);
}

export function spliceLedger(body, regionText) {
  const found = findRegion(body);
  if (found?.error) throw new Error(`ledger region is ${found.error}`);
  if (found) return body.slice(0, found.start) + regionText + body.slice(found.end);
  const eol = eolOf(body);
  const trailing = /(?:\r?\n)*$/.exec(body)[0].split('\n').length - 1;
  return body === '' ? regionText : body + eol.repeat(Math.max(0, 2 - trailing)) + regionText;
}

export function foldEarlierList(body, listText) {
  const found = findRegion(body);
  if (!found || found.error) throw new Error('no ledger region to fold after');
  const eol = eolOf(body);
  const fold = ['', '<details><summary>Earlier task list</summary>', '', listText, '', '</details>'].join(eol);
  return body.slice(0, found.end) + eol + fold + body.slice(found.end);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function ownerEdits(lastWritten, current) {
  const edits = [];
  if (lastWritten.authorization !== current.authorization) edits.push({ type: 'authorization' });
  const now = new Map(current.rows.map((r) => [r.issue, r]));
  const kept = lastWritten.rows.filter((r) => now.has(r.issue));
  for (const r of lastWritten.rows) if (!now.has(r.issue)) edits.push({ type: 'deleted', issue: r.issue });
  const order = current.rows.filter((r) => kept.some((k) => k.issue === r.issue)).map((r) => r.issue);
  if (!same(kept.map((r) => r.issue), order)) edits.push({ type: 'order', value: order });
  for (const was of kept) {
    const r = now.get(was.issue);
    if (!same(was.deps, r.deps)) edits.push({ type: 'deps', issue: r.issue, value: r.deps });
    if (was.batch !== r.batch) edits.push({ type: 'batch', issue: r.issue, value: r.batch });
    if (r.status === 'hold' && was.status !== 'hold') edits.push({ type: 'hold', issue: r.issue });
    else if (r.status === 'queued' && (was.status === 'owner' || was.status === 'blocked')) edits.push({ type: 'answered', issue: r.issue });
  }
  return edits;
}
