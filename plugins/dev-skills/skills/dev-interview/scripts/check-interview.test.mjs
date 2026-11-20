// One test per case of #50's AC-2 cases 1–6: target, type, flags and notes, and both language chains.
// Run with `node --test skills/dev-interview/scripts/check-interview.test.mjs` or `npm test` from the
// plugin root. Every input is a fixture; no GitHub call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveArgs, sourceLanguage } from './check-interview.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'check-interview.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'check-interview-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const REPO = 'example-org/example-repo';
const BASE = `https://github.com/${REPO}`;
const ZH = '请确认是否保留默认的共享开关，以及后续计划由谁负责。';
const EN = 'Please confirm whether the default sharing switch stays on.';
const args = (text, over = {}) => resolveArgs({ repo: REPO, text, candidates: [], askEnv: '', noteEnv: '', sessionText: '', ...over });
const proceed = (text, over) => {
  const result = args(text, over);
  assert.equal(result.action, 'proceed', JSON.stringify(result));
  return result;
};
const cli = (command, input) => {
  const path = join(scratch, `${command}.json`);
  writeFileSync(path, JSON.stringify(input));
  return spawnSync(process.execPath, [CLI, command, '--input', path], { encoding: 'utf8' });
};

// AC-2 case 1 — target

test('AC-2.1 #N, N and this repository\'s issue, PR and discussion URLs resolve with their kind', () => {
  for (const [token, expected] of [['#12', { number: 12, kind: 'any' }], ['12', { number: 12, kind: 'any' }],
    [`${BASE}/issues/12`, { number: 12, kind: 'issue-or-pr' }], [`${BASE}/pull/12`, { number: 12, kind: 'issue-or-pr' }],
    [`${BASE}/discussions/12`, { number: 12, kind: 'discussion' }],
    [`${BASE}/discussions/12#discussioncomment-345`, { number: 12, kind: 'discussion', comment: 345 }]]) {
    assert.deepEqual(proceed(token, { candidates: [99] }).target, { ...expected, source: 'argument' });
  }
});

test('AC-2.1 another repository\'s URL, #0 and two targets stop', () => {
  assert.equal(args('https://github.com/other-org/other-repo/issues/12').reason, 'bad-target');
  assert.equal(args('#0').reason, 'bad-target');
  assert.deepEqual([args('#12 #13').reason, args('#12 #13').candidates], ['ambiguous-target', [12, 13]]);
});

test('AC-2.1 without a target, exactly one context candidate is the target; none or several stop', () => {
  assert.deepEqual(proceed('', { candidates: [7, 7] }).target, { number: 7, kind: 'any', source: 'context' });
  assert.equal(args('').reason, 'no-target');
  assert.deepEqual([args('', { candidates: [7, 8] }).reason, args('', { candidates: [7, 8] }).candidates], ['ambiguous-target', [7, 8]]);
});

// AC-2 case 2 — type

test('AC-2.2 type= is case-insensitive, defaults to OD, and an invalid value warns and uses OD', () => {
  for (const [token, value] of [['type=od', 'OD'], ['type=SD', 'SD'], ['type=all', 'ALL']]) {
    assert.deepEqual(proceed(`#1 ${token}`).type, { value, source: 'argument' });
  }
  assert.deepEqual(proceed('#1').type, { value: 'OD', source: 'default' });
  const invalid = proceed('#1 type=XD');
  assert.deepEqual(invalid.type, { value: 'OD', source: 'default' });
  assert.deepEqual(invalid.warnings, ['type="XD" is not OD, SD or ALL; using OD (default)']);
});

// AC-2 case 3 — flags and notes

test('AC-2.3 linked and dry-run before the notes are true, absent ones false, in any order', () => {
  const bare = proceed('#1');
  assert.deepEqual([bare.linked, bare.dryRun, bare.notes], [false, false, '']);
  for (const text of ['#1 linked dry-run', 'dry-run #1 linked', 'linked type=SD dry-run #1']) {
    const result = proceed(text);
    assert.deepEqual([result.target.number, result.linked, result.dryRun, result.notes], [1, true, true, '']);
  }
});

test('AC-2.3 the first other token starts verbatim notes, so a later flag stays in them', () => {
  const result = proceed('#1 dry-run only #12 Q2–Q3,  then linked\n  ask-lang=en ');
  assert.deepEqual([result.dryRun, result.linked, result.notes], [true, false, 'only #12 Q2–Q3,  then linked\n  ask-lang=en']);
  assert.deepEqual(result.ask, { value: null, source: 'source' });
});

// AC-2 cases 4–6 — languages

test('AC-2.4 the popup language: argument, then DEV_INTERVIEW_ASK_LANG, then session text, then pending', () => {
  const all = { askEnv: 'fr', sessionText: ZH };
  assert.deepEqual(proceed('#1 ask-lang=en-AU', all).ask, { value: 'en-AU', source: 'argument' });
  assert.deepEqual(proceed('#1', all).ask, { value: 'fr', source: 'environment' });
  assert.deepEqual(proceed('#1', { sessionText: ZH }).ask, { value: 'zh-CN', source: 'session' });
  assert.deepEqual(proceed('#1', { sessionText: EN }).ask, { value: 'en', source: 'session' });
  assert.deepEqual(proceed('#1').ask, { value: null, source: 'source' });
});

test('AC-2.4 the note language: argument, then DEV_INTERVIEW_NOTE_LANG, then pending; session text never counts', () => {
  assert.deepEqual(proceed('#1 note-lang=ja', { noteEnv: 'en' }).note, { value: 'ja', source: 'argument' });
  assert.deepEqual(proceed('#1', { noteEnv: 'zh-TW' }).note, { value: 'zh-TW', source: 'environment' });
  assert.deepEqual(proceed('#1', { sessionText: ZH }).note, { value: null, source: 'source' });
});

test('AC-2.4/2.5 a pending language comes from the source text, else zh-CN', () => {
  assert.deepEqual(sourceLanguage(ZH), { value: 'zh-CN', source: 'source' });
  assert.deepEqual(sourceLanguage(`${EN}\n\n\`\`\`\n${ZH}\n\`\`\``), { value: 'en', source: 'source' });
  for (const bare of ['', '   ', '`OD-1` https://example.com/x <!-- marker -->', `\`\`\`\n${EN}\n\`\`\``]) {
    assert.deepEqual(sourceLanguage(bare), { value: 'zh-CN', source: 'default' });
  }
});

test('AC-2.5 session text with no prose falls through to the source', () => {
  assert.deepEqual(proceed('#1', { sessionText: '`#12` https://example.com' }).ask, { value: null, source: 'source' });
  assert.deepEqual(proceed('#1', { sessionText: '[source](https://example.com)' }).ask, { value: null, source: 'source' });
  assert.deepEqual(proceed('#1', { sessionText: '- [x] [source](https://example.com)' }).ask, { value: null, source: 'source' });
});

test('AC-2.5 a task item\'s [ ], [x] or [X] is a status mark, not prose; the item\'s own words still count', () => {
  for (const form of ['- [x]', '- [X]', '- [x] [source](https://example.com)', '* [X] `OD-1`', '1. [x] ⏳', '- [ ] ✅']) {
    assert.deepEqual(sourceLanguage(form), { value: 'zh-CN', source: 'default' }, form);
  }
  assert.deepEqual(sourceLanguage(`- [x] ${EN}`), { value: 'en', source: 'source' });
  assert.deepEqual(sourceLanguage(`- [ ] ${ZH}`), { value: 'zh-CN', source: 'source' });
  assert.deepEqual(sourceLanguage('- [xx] Decide'), { value: 'en', source: 'source' }, 'only a one-character mark');
});

test('AC-2.5 link and image labels, reference definitions, any code span and indented code are not prose', () => {
  const forms = ['[source](https://example.com)', '![diagram](d.png)', '[source][1]\n\n[1]: https://example.com',
    '<https://example.com>', 'www.example.com/docs', '``a `b` c``', `\`OD-1\`\n\n    ${EN}`];
  for (const form of forms) assert.deepEqual(sourceLanguage(form), { value: 'zh-CN', source: 'default' }, form);
  assert.deepEqual(sourceLanguage(`${ZH} [the source](https://example.com)`), { value: 'zh-CN', source: 'source' });
  assert.deepEqual(sourceLanguage(`${EN}\n\n    ${ZH}`), { value: 'en', source: 'source' });
});

test('AC-2.5 a bare link or email is not prose, whatever wraps it; the words around it still count', () => {
  for (const form of ['(www.example.com/docs)', 'owner@example.com', '~~www.example.com/docs~~', '- [x] owner@example.com',
    '(https://example.com/x).', '<owner@example.com>']) {
    assert.deepEqual(sourceLanguage(form), { value: 'zh-CN', source: 'default' }, form);
  }
  assert.deepEqual(proceed('#1', { sessionText: '(www.example.com/docs)' }).ask, { value: null, source: 'source' });
  assert.deepEqual(sourceLanguage(`${EN} (www.example.com/docs)`), { value: 'en', source: 'source' });
  assert.deepEqual(sourceLanguage(`${ZH} owner@example.com`), { value: 'zh-CN', source: 'source' });
  assert.deepEqual(sourceLanguage('Ask @owner first'), { value: 'en', source: 'source' }, 'a mention is not an email');
});

test('AC-2.6 an invalid or repeated value warns once, naming it, and falls through to the next link', () => {
  const badArg = proceed('#1 ask-lang=zh_CN note-lang=', { sessionText: EN });
  assert.deepEqual([badArg.ask, badArg.note], [{ value: 'en', source: 'session' }, { value: null, source: 'source' }]);
  assert.deepEqual(badArg.warnings, ['ask-lang="zh_CN" is not a well-formed BCP 47 tag (did you mean "zh-CN"?); ignored',
    'note-lang="" is not a well-formed BCP 47 tag; ignored']);
  const badEnv = proceed('#1', { askEnv: 'xx', noteEnv: 'not a tag', sessionText: ZH });
  assert.deepEqual([badEnv.ask, badEnv.note], [{ value: 'zh-CN', source: 'session' }, { value: null, source: 'source' }]);
  assert.deepEqual(badEnv.warnings, ['DEV_INTERVIEW_ASK_LANG="xx" names no known language; ignored',
    'DEV_INTERVIEW_NOTE_LANG="not a tag" is not a well-formed BCP 47 tag; ignored']);
  const twice = proceed('#1 note-lang=en note-lang=fr', { noteEnv: 'de' });
  assert.deepEqual(twice.note, { value: 'de', source: 'environment' });
  assert.deepEqual(twice.warnings, ['note-lang= was given 2 times ("en", "fr"); ignored']);
});

// CLI

test('CLI: exit 0 proceeds, 1 stops and 2 means the check did not run', () => {
  const ok = cli('args', { repo: REPO, text: '#3 linked', candidates: [], askEnv: '', noteEnv: '', sessionText: ZH });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).ask, { value: 'zh-CN', source: 'session' });
  assert.equal(cli('args', { repo: REPO, text: '', candidates: [], askEnv: '', noteEnv: '', sessionText: '' }).status, 1);
  assert.deepEqual(JSON.parse(cli('lang', { text: '' }).stdout), { value: 'zh-CN', source: 'default' });
  assert.equal(cli('args', { repo: REPO, text: '#3' }).status, 2, 'missing keys');
  assert.equal(cli('lang', { text: '', extra: 1 }).status, 2, 'unknown key');
  assert.equal(cli('nope', {}).status, 2, 'unknown command');
});
