import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-text.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'job');
  mkdirSync(root);
  const manifest = join(root, 'checks.json');
  const check = (entries) => {
    writeFileSync(manifest, JSON.stringify(entries));
    return run('--input', manifest);
  };
  return { dir, root, manifest, check };
}

function assertError(result) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.notEqual(result.stderr, '');
}

test('ordered first and all matches across files, including repeated checks', (t) => {
  const { root, check } = fixture(t);
  const literal = '- [x] $(example) * café';
  writeFileSync(join(root, 'a.md'), `heading\r\n${literal} ${literal}\r\n\r\n${literal}\r\n\r\n`);
  writeFileSync(join(root, 'b.md'), literal);
  const a = { file: 'a.md', literal };
  const b = { file: 'b.md', literal };
  const result = check([a, b, { ...a, lines: 'first' }, { ...a, lines: 'all' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { ...a, lines: [2, 4] }, { ...b, lines: [1] }, { ...a, lines: [2] }, { ...a, lines: [2, 4] },
  ]);
});

test('a missing literal exits 1 and preserves later matches', (t) => {
  const { root, check } = fixture(t);
  writeFileSync(join(root, 'review.md'), 'match');
  const missing = { file: 'review.md', literal: 'MATCH' };
  const found = { file: 'review.md', literal: 'match' };
  const result = check([missing, found]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ ...missing, lines: [] }, { ...found, lines: [1] }]);
});

test('bad arguments, malformed JSON and invalid checks exit 2', (t) => {
  const { root, manifest, check } = fixture(t);
  writeFileSync(join(root, 'a.md'), 'example');
  writeFileSync(manifest, '{');
  assertError(run('--input', manifest));
  assertError(run());
  const invalidCases = [
    [], {}, [null], [{ file: 'a.md', literal: '' }],
    [{ file: 'a.md', literal: 'a\nb' }], [{ file: 'a.md', literal: 'a', lines: 'last' }],
  ];
  for (const entries of invalidCases) {
    assertError(check(entries));
  }
});

test('missing files, directories, symlinks and outside paths fail without partial output', (t) => {
  const { dir, root, manifest, check } = fixture(t);
  writeFileSync(join(root, 'inside.md'), 'example');
  const outside = join(dir, 'outside.md');
  writeFileSync(outside, 'example');
  mkdirSync(join(root, 'folder'));
  symlinkSync(outside, join(root, 'linked.md'), 'file');
  symlinkSync('inside.md', join(root, 'alias.md'), 'file');
  symlinkSync(dir, join(root, 'up'), 'dir');
  const valid = { file: 'inside.md', literal: 'example' };
  for (const file of ['missing.md', 'folder', '../outside.md', outside, 'linked.md', 'alias.md', 'up/outside.md']) {
    assertError(check([valid, { file, literal: 'example' }]));
  }
  writeFileSync(manifest, JSON.stringify([valid]));
  const linkedManifest = join(root, 'linked.json');
  symlinkSync(manifest, linkedManifest, 'file');
  assertError(run('--input', linkedManifest));
});
