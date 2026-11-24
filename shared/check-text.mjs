import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// The caller stages evidence in a private task directory. Reject symlinks and
// special files, then verify the descriptor before reading.
function readText(path) {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || realpathSync.native(path) !== path) {
    throw new Error(`Expected a regular file without symlinks: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error(`File changed: ${path}`);
    return utf8.decode(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

function checkText(input) {
  const root = realpathSync.native(dirname(resolve(input)));
  const checks = JSON.parse(readText(join(root, basename(input))).replace(/^\uFEFF/, ''));
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('Expected a nonempty JSON array');

  const files = new Map();
  const results = checks.map((check, index) => {
    const { file, literal, lines = 'all' } = check ?? {};
    if (typeof file !== 'string' || !file || win32.parse(file).root || file.split(/[\\/]/).includes('..') ||
        typeof literal !== 'string' || !literal || /[\r\n\0]/.test(literal) ||
        !['first', 'all'].includes(lines) || Object.keys(check).some(k => !['file', 'literal', 'lines'].includes(k))) {
      throw new Error(`Invalid check at index ${index}; expected file, literal and optional lines (first or all)`);
    }
    const path = join(root, file);
    if (!files.has(path)) files.set(path, []);
    files.get(path).push(index);
    return { file, literal, lines: [] };
  });

  for (const [path, indices] of files) {
    const lines = readText(path).split(/\r?\n/);
    for (const index of indices) {
      const result = results[index];
      for (let line = 0; line < lines.length; line++) {
        if (lines[line].includes(result.literal)) {
          result.lines.push(line + 1);
          if (checks[index].lines === 'first') break;
        }
      }
    }
  }
  return results;
}

try {
  const [flag, input, ...extra] = process.argv.slice(2);
  if (flag !== '--input' || !input || extra.length) throw new Error('Usage: node check-text.mjs --input MANIFEST');
  const results = checkText(input);
  console.log(JSON.stringify(results));
  process.exitCode = results.every(result => result.lines.length > 0) ? 0 : 1;
} catch (error) {
  console.error(`check-text: ${error.message}`);
  process.exitCode = 2;
}
