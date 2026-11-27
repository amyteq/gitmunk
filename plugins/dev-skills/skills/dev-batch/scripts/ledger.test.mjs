import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUS, findRegion, foldEarlierList, ownerEdits, parseLedger, renderLedger, spliceLedger } from './ledger.mjs';

const row = (n, issue, over = {}) => ({ n, issue, title: `Task ${issue}`, deps: [], batch: 1, status: 'queued', pr: null, head: null, session: null, next: '', ...over });
const example = () => ({
  header: { coordinator: 'ex-i40c', alias: 'A1', loop: 'running', cap: 4, merge: 'auto', changed: '2026-11-18 10:12 UTC', waiting: 0 },
  authorization: 'Owner authorization (2026-11-18 09:58 UTC, coordinator session `ex-i40c`, owner\'s invocation `/dev-batch init src=40 merge=auto`): for every task in this ledger, refine the issue.',
  rows: [
    row(1, 41, { title: 'Export tasks as CSV', status: 'merged', pr: 52, head: '4f2a9c1', session: 'ex-pr52m' }),
    row(2, 42, { title: 'Import from CSV', deps: [41], batch: 2, status: 'reviewing', pr: 55, head: '9b0e7d3', session: 'ex-pr55', next: 'round 2 of 10' }),
    row(3, 43, { title: 'Bulk delete | with pipe', status: 'owner', session: 'ex-i43r', next: '[decision on #43](https://example.test/x)' }),
  ],
  log: [{ time: '11-18 10:05', event: '#42 review round 1: 3 findings' }],
});

test('round trip', () => {
  const text = renderLedger(example(), { eol: '\n' });
  assert.match(text, /^<!-- dev-batch:ledger v=1 -->\n### Batch ledger\n\nCoordinator: A1 · `ex-i40c` · 🟢 running · cap 4 workers · merge auto · changed 2026-11-18 10:12 UTC\nOwner authorization/);
  assert.match(text, /\nRoll call: 3 tasks · ✅ 1 · 🔄 1 · 👤 1 · ❗ 0 events waiting\n/);
  assert.match(text, /\| 2 \| #42 Import from CSV \| #41 \| B2 \| 🔄 \| #55 · `9b0e7d3` \| ex-pr55 \| round 2 of 10 \|/);
  assert.ok(text.endsWith('<!-- /dev-batch:ledger -->'));
  const { ledger, problems } = parseLedger(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(ledger, example());
});

test('the old `cap N` Coordinator line reads as `cap N workers` and renders in the new form', () => {
  const text = renderLedger(example());
  assert.ok(text.includes('· cap 4 workers ·'));
  const old = parseLedger(text.replace('· cap 4 workers ·', '· cap 4 ·')).ledger;
  const now = parseLedger(text).ledger;
  assert.equal(old.header.cap, 4);
  assert.deepEqual(now.header, old.header);
  assert.ok(renderLedger(old).includes('· cap 4 workers ·'));
  assert.deepEqual(ownerEdits(old, now), []);
});

test('a labelled priority shows in the Batch cell and reads back; none shows nothing', () => {
  const l = example();
  l.rows[0].priority = 0;
  l.rows[1].priority = null;
  const text = renderLedger(l);
  assert.match(text, /\| 1 \| #41 Export tasks as CSV \| — \| B1 · P0 \| ✅ \|/);
  assert.match(text, /\| #41 \| B2 \| 🔄 \|/);
  const { ledger } = parseLedger(text);
  assert.equal(ledger.rows[0].priority, 0);
  assert.equal(ledger.rows[0].batch, 1);
  assert.equal('priority' in ledger.rows[1], false);
});

test('splice keeps every byte outside the region', () => {
  const region = (eol) => renderLedger(example(), { eol });
  const body = 'intro\r\n\r\ntail text  \r\n';
  const old = '<!-- dev-batch:ledger v=1 -->\r\nold\r\n<!-- /dev-batch:ledger -->';
  const full = `${body}${old}\r\n\r\nafter  \r\n`;
  const out = spliceLedger(full, region('\r\n'));
  assert.equal(out, `${body}${region('\r\n')}\r\n\r\nafter  \r\n`);
  assert.ok(!/(?<!\r)\n/.test(out));
  assert.equal(spliceLedger('plain', region('\n')), `plain\n\n${region('\n')}`);
  assert.equal(spliceLedger('plain\r\n', region('\r\n')), `plain\r\n\r\n${region('\r\n')}`);
});

test('a marker in a code fence is not the region', () => {
  const fenced = '```\n<!-- dev-batch:ledger v=1 -->\nx\n<!-- /dev-batch:ledger -->\n```\n';
  assert.equal(findRegion(fenced), null);
  const body = `${fenced}<!-- dev-batch:ledger v=1 -->\nreal\n<!-- /dev-batch:ledger -->\n`;
  const { start, end } = findRegion(body);
  assert.equal(body.slice(start, end), '<!-- dev-batch:ledger v=1 -->\nreal\n<!-- /dev-batch:ledger -->');
  assert.deepEqual(findRegion('<!-- dev-batch:ledger v=1 -->\nx'), { error: 'unclosed' });
  const two = '<!-- dev-batch:ledger v=1 -->\n<!-- /dev-batch:ledger -->\n<!-- dev-batch:ledger v=1 -->\n<!-- /dev-batch:ledger -->';
  assert.deepEqual(findRegion(two), { error: 'multiple' });
});

test('hand-edited table', () => {
  const previous = example();
  const text = renderLedger(previous, { eol: '\r\n' })
    .replace('| 3 | #43 Bulk delete \\| with pipe | — | B1 | 👤 | — | ex-i43r | [decision on #43](https://example.test/x) |',
      '|  3 |   #43 Bulk delete \\| with pipe  |  — | B1  |  🟣 | — |  ex-i43r | [decision on #43](https://example.test/x)');
  assert.ok(text.includes('🟣'));
  const { ledger, problems } = parseLedger(text, { previous });
  assert.deepEqual(problems, [{ row: 3, reason: 'unknown status 🟣' }]);
  assert.equal(ledger.rows.length, 3);
  assert.equal(ledger.rows[2].status, 'owner');
  assert.equal(ledger.rows[2].title, 'Bulk delete | with pipe');
  assert.equal(parseLedger(text).ledger.rows[2].status, null);
});

test('tolerant task cell', () => {
  const previous = example();
  const withCell = (cell) => renderLedger(previous, { eol: '\n' }).replace('#41 Export tasks as CSV', cell);
  for (const cell of ['41 Export tasks as CSV', '[#41](https://example.test/example-org/example-repo/issues/41) Export tasks as CSV', 'https://example.test/example-org/example-repo/issues/41 Export tasks as CSV']) {
    const { ledger, problems } = parseLedger(withCell(cell), { previous });
    assert.deepEqual(problems, [], cell);
    assert.deepEqual([ledger.rows[0].issue, ledger.rows[0].title], [41, 'Export tasks as CSV'], cell);
  }
});

test('unreadable task cell keeps the previous row', () => {
  const previous = example();
  const text = renderLedger(previous, { eol: '\n' }).replace('#41 Export tasks as CSV', 'Export tasks as CSV');
  const { ledger, problems } = parseLedger(text, { previous });
  assert.deepEqual(problems, [{ row: 1, reason: 'unreadable task cell' }]);
  assert.deepEqual(ledger.rows[0], previous.rows[0]);
  assert.deepEqual(ownerEdits(previous, ledger), []);
});

test('unreadable task cell with no previous row is dropped with a problem', () => {
  const previous = example();
  const text = renderLedger(previous, { eol: '\n' }).replace('| 3 | #43', '| 9 | oops');
  const { ledger, problems } = parseLedger(text, { previous });
  assert.deepEqual(problems, [{ row: 9, reason: 'unreadable task cell' }]);
  assert.equal(ledger.rows.length, 2);
});

test('a row without its leading pipe is read, and any other table line is reported, never dropped', () => {
  const text = renderLedger(example(), { eol: '\n' }).replace('| 2 | #42 Import', '2 | #42 Import');
  const { ledger, problems } = parseLedger(text);
  assert.deepEqual([problems, ledger.rows.map((r) => [r.n, r.issue, r.status])], [[], [[1, 41, 'merged'], [2, 42, 'reviewing'], [3, 43, 'owner']]]);
  const broken = parseLedger(text.replace('2 | #42 Import from CSV', '2 | Import from CSV'), { previous: example() });
  assert.deepEqual([broken.problems, broken.ledger.rows.map((r) => r.issue)], [[{ row: 2, reason: 'unreadable task cell' }], [41, 42, 43]]);
});

test('owner edits', () => {
  const last = example();
  last.rows.push(row(4, 44, { status: 'blocked' }), row(5, 45, { status: 'implementing' }), row(6, 46, { status: 'hold' }));
  const edit = (fn) => { const c = structuredClone(last); fn(c); return ownerEdits(last, c); };
  assert.deepEqual(edit(() => {}), []);
  assert.deepEqual(edit((c) => c.rows.reverse()).map((e) => e.type), ['order']);
  assert.deepEqual(edit((c) => { c.rows[0].deps = [42]; }), [{ type: 'deps', issue: 41, value: [42] }]);
  assert.deepEqual(edit((c) => { c.rows[0].batch = 3; }), [{ type: 'batch', issue: 41, value: 3 }]);
  assert.deepEqual(edit((c) => { c.rows[4].status = 'hold'; }), [{ type: 'hold', issue: 45 }]);
  assert.deepEqual(edit((c) => { c.rows[2].status = 'queued'; }), [{ type: 'answered', issue: 43 }]);
  assert.deepEqual(edit((c) => { c.rows[3].status = 'queued'; }), [{ type: 'answered', issue: 44 }]);
  assert.deepEqual(edit((c) => { c.rows[5].status = 'queued'; }), [{ type: 'release', issue: 46 }]);
  assert.deepEqual(edit((c) => c.rows.splice(1, 1)), [{ type: 'deleted', issue: 42 }]);
  assert.deepEqual(edit((c) => { c.authorization = null; }).map((e) => e.type), ['authorization']);
  assert.deepEqual(edit((c) => { c.authorization += ' x'; }).map((e) => e.type), ['authorization']);
  assert.deepEqual(edit((c) => {
    Object.assign(c.rows[4], { status: 'reviewing', pr: 9, head: 'abc', session: 's', next: 'n' });
    c.rows[1].status = 'merged'; c.header.waiting = 3;
  }), []);
});

test('log keeps the last 20 rows', () => {
  const l = example();
  l.log = Array.from({ length: 25 }, (_, i) => ({ time: `11-18 10:${String(i).padStart(2, '0')}`, event: `e${i}` }));
  const { ledger } = parseLedger(renderLedger(l, { eol: '\n' }));
  assert.equal(ledger.log.length, 20);
  assert.equal(ledger.log[0].event, 'e5');
  assert.equal(ledger.log[19].event, 'e24');
});

test('fold earlier list', () => {
  const region = renderLedger(example(), { eol: '\r\n' });
  const body = spliceLedger('top\r\n', region) + '\r\nmore';
  const out = foldEarlierList(body, '- [ ] #1\r\n- [ ] #2');
  assert.ok(out.includes(`${region}\r\n\r\n<details><summary>Earlier task list</summary>\r\n\r\n- [ ] #1\r\n- [ ] #2\r\n\r\n</details>\r\nmore`));
});

test('STATUS values', () => assert.equal(STATUS.hold, '⏸️'));
