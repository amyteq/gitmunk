import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const HELPER = fileURLToPath(new URL('./launch-phase.mjs', import.meta.url));
const PUBLICATION = fileURLToPath(new URL('../../../scripts/check-publication.mjs', import.meta.url));
const SKILL = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');
const TOGGLE = 'DEV_REVIEW_PR_RUN_DIR_HELPER';
const ID = 'pr7-20261127T0407Z';
// The runner's own setting of the toggle must not decide a case.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== TOGGLE));
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// A Git checkout to run from and a separate temporary folder, both inside one fixture root.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-dir-')));
  roots.push(root);
  const repo = join(root, 'repo');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  execFileSync('git', ['init', '-q', repo]);
  return { root, repo, tmp, parent: join(tmp, 'dev-review-pr'), dir: join(tmp, 'dev-review-pr', ID) };
}

// Every entry under dir: directories with their mode, files with their bytes.
const tree = (dir, base = dir) => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isSymbolicLink()) return [[relative(base, path), `link ${readlinkSync(path)}`]];
  if (!entry.isDirectory()) return [[relative(base, path), readFileSync(path, 'latin1')]];
  return [[relative(base, path), `dir ${(lstatSync(path).mode & 0o777).toString(8)}`], ...Object.entries(tree(path, base))];
}));
const added = (before, later) => Object.keys(later).filter((key) => !(key in before)).sort();
const unchangedExcept = (before, later) => Object.keys(before).every((key) => before[key] === later[key]);

const runDir = (f, args, env = {}, cwd = f.repo) => spawnSync('node', [HELPER, 'run-dir', ...args],
  { cwd, encoding: 'utf8', env: { ...ENV, TMPDIR: f.tmp, ...env } });
const ONE_LINE = /^[^\n]+\n$/;

function assertCreated(f, result, before) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.dir}\n`);
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  assert.ok(!f.dir.startsWith(`${f.repo}/`), 'the run directory lies outside the checkout it runs from');
  const later = tree(f.root);
  assert.deepEqual(added(before, later), ['tmp/dev-review-pr', `tmp/dev-review-pr/${ID}`]);
  assert.ok(unchangedExcept(before, later));
}

function assertRefused(f, result, before, code = 2) {
  assert.equal(result.status, code, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, ONE_LINE);
  assert.deepEqual(tree(f.root), before, 'nothing created or changed');
}

test('run-dir AC-2(a) the toggle unset or empty creates the run directory and prints its path', () => {
  for (const env of [{}, { [TOGGLE]: '' }]) {
    const f = fixture();
    const before = tree(f.root);
    const result = runDir(f, ['--run-id', ID], env);
    assertCreated(f, result, before);
    assert.equal(result.stderr, '');
  }
});

test('run-dir AC-2(b) the toggle at 1 behaves as unset', () => {
  const f = fixture();
  const before = tree(f.root);
  const result = runDir(f, ['--run-id', ID], { [TOGGLE]: '1' });
  assertCreated(f, result, before);
  assert.equal(result.stderr, '');
});

test('run-dir AC-2(c) the toggle at 0 creates and prints nothing, exits 3, and step 4 keeps its scratch sentence', () => {
  const f = fixture();
  const before = tree(f.root);
  const result = runDir(f, ['--run-id', ID], { [TOGGLE]: '0' });
  assertRefused(f, result, before, 3);
  assert.match(result.stderr, new RegExp(TOGGLE));
  const step4 = SKILL.split('\n').find((line) => line.startsWith('4. '));
  assert.ok(step4.includes('Keep the run ID, snapshots, prompts, ledger, reports and phase records in untracked scratch outside the checkout.'));
  assert.match(step4, /`0` makes the helper exit 3 and leaves you to choose the scratch directory as before/);
});

test('run-dir AC-2(d) another value warns, naming the variable and its accepted values, then behaves as unset', () => {
  const f = fixture();
  const before = tree(f.root);
  const result = runDir(f, ['--run-id', ID], { [TOGGLE]: 'yes' });
  assertCreated(f, result, before);
  assert.match(result.stderr, ONE_LINE);
  assert.match(result.stderr, new RegExp(`${TOGGLE}.*unset, empty, 1 or 0`));
});

test('run-dir AC-2(e) SKILL.md names the variable, its values and its default', () => {
  const step4 = SKILL.split('\n').find((line) => line.startsWith('4. '));
  assert.match(step4, new RegExp(`Unless \`${TOGGLE}\` is \`0\``));
  assert.match(step4, /unset by default; unset, empty or `1` turns this on/);
  assert.match(step4, /any other value warns and keeps it on/);
});

test('run-dir AC-3(a) a new run ID gets one 0700 directory outside the checkout, printed as its real path', () => {
  const f = fixture();
  const before = tree(f.root);
  assertCreated(f, runDir(f, ['--run-id', ID]), before);
  assert.equal(realpathSync(f.dir), f.dir);
});

test('run-dir AC-3(b) the same run ID again prints the same path and leaves the files there unchanged', () => {
  const f = fixture();
  const first = runDir(f, ['--run-id', ID]);
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(f.dir, 'ledger.md'), '| F001 | open |\n');
  mkdirSync(join(f.dir, 'snap'));
  writeFileSync(join(f.dir, 'snap', 'a.txt'), 'kept');
  const before = tree(f.root);
  const again = runDir(f, ['--run-id', ID]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, first.stdout);
  assert.equal(again.stderr, '');
  assert.deepEqual(tree(f.root), before);
});

test('run-dir AC-3(c) a run ID that is ., .., a/b, empty or 65 characters is refused with nothing created', () => {
  for (const id of ['.', '..', 'a/b', '', 'x'.repeat(65)]) {
    const f = fixture();
    const before = tree(f.root);
    assertRefused(f, runDir(f, ['--run-id', id]), before);
  }
  const f = fixture();
  const before = tree(f.root);
  assertRefused(f, runDir(f, []), before);
  assertRefused(f, runDir(f, ['--run-id', ID, '--run-id', ID]), before);
});

test('run-dir AC-3(d) a regular file at the run directory\'s path is refused and left unchanged', () => {
  const f = fixture();
  mkdirSync(f.parent, { mode: 0o700 });
  writeFileSync(f.dir, 'not a directory');
  const before = tree(f.root);
  assertRefused(f, runDir(f, ['--run-id', ID]), before);
  assert.equal(readFileSync(f.dir, 'utf8'), 'not a directory');
});

test('run-dir AC-3(e) a temporary folder inside the checkout is refused with nothing created', () => {
  const f = fixture();
  const inside = join(f.repo, 'scratch');
  mkdirSync(inside);
  symlinkSync(inside, join(f.root, 'link'));
  const before = tree(f.root);
  assertRefused(f, runDir(f, ['--run-id', ID], { TMPDIR: inside }), before);
  // The same from a subfolder of the checkout, through a link that resolves into it, and with a linked parent folder.
  assertRefused(f, runDir(f, ['--run-id', ID], { TMPDIR: inside }, inside), before);
  assertRefused(f, runDir(f, ['--run-id', ID], { TMPDIR: join(f.root, 'link') }), before);
  symlinkSync(inside, f.parent);
  const linked = tree(f.root);
  assertRefused(f, runDir(f, ['--run-id', ID]), linked);
});

// AC-4: one fixture holds a run directory made by run-dir and a run-id file naming it. Each command runs through
// `bash -c` twice from the same starting state: once re-deriving the directory from the run-id file, once with the
// printed path spelled literally. Status, stdout, stderr and the run directory's tree must match.
function equivalence() {
  const f = fixture();
  const made = runDir(f, ['--run-id', ID]);
  assert.equal(made.status, 0, made.stderr);
  const printed = made.stdout.trimEnd();
  const runIdFile = join(f.tmp, 'run-id');
  writeFileSync(runIdFile, `${ID}\n`);
  const files = {
    'pr-body.md': '## Summary\n\nCloses #7.\n',
    'r1.report.md': '## Review\n\nNo findings.\n\n---\n\nSigned.\n',
    'bad.report.md': '## Review\nNo findings.\n---\nSigned.\n',
    'ledger.md': '| ID | State |\n|---|---|\n| F001 | open |\n| F002 | resolved |\n',
  };
  const reset = () => {
    for (const name of readdirSync(printed)) rmSync(join(printed, name), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(printed, name), text);
  };
  const forms = (command) => [`R=${f.parent}/$(cat ${runIdFile}); ${command}`, command.replaceAll('$R', printed)].map((script) => {
    reset();
    const result = spawnSync('bash', ['-c', script], { cwd: f.repo, encoding: 'utf8', env: ENV });
    assert.equal(result.error, undefined, 'bash ran');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, tree: tree(printed) };
  });
  return { printed, both: (command) => { const [derived, literal] = forms(command); assert.deepEqual(literal, derived); return literal; } };
}

test('run-dir AC-4(a) cat of a saved PR body is the same both ways', () => {
  const { both } = equivalence();
  const result = both('cat $R/pr-body.md');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '## Summary\n\nCloses #7.\n');
});

test('run-dir AC-4(b) sed -n 1,3p of a saved report is the same both ways', () => {
  const { both } = equivalence();
  const result = both('sed -n 1,3p $R/r1.report.md');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '## Review\n\nNo findings.\n');
});

test('run-dir AC-4(c) grep -c on a saved ledger is the same both ways', () => {
  const { both } = equivalence();
  const result = both("grep -c '^| F' $R/ledger.md");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '2\n');
});

test('run-dir AC-4(d) check-publication on a clean report exits 0 both ways', () => {
  const { both } = equivalence();
  const result = both(`node ${PUBLICATION} --body-file $R/r1.report.md`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('run-dir AC-4(e) check-publication on a report missing the blank line before --- exits 1 with the same file:line', () => {
  const { both, printed } = equivalence();
  const result = both(`node ${PUBLICATION} --body-file $R/bad.report.md`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, `${printed}/bad.report.md:3: thematic break not preceded by a blank line\n`);
});

test('run-dir AC-4(f) cat of a missing file fails the same way both ways', () => {
  const { both, printed } = equivalence();
  const result = both('cat $R/missing.md');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(`${printed}/missing.md`), result.stderr);
});

test('run-dir AC-4(g) a command that writes into the run directory leaves the same tree both ways', () => {
  const { both } = equivalence();
  const result = both("printf '| F003 | open |\\n' >> $R/ledger.md && printf 'draft\\n' > $R/r2.prompt.md");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.tree['r2.prompt.md'], 'draft\n');
  assert.match(result.tree['ledger.md'], /\| F003 \| open \|\n$/);
});
