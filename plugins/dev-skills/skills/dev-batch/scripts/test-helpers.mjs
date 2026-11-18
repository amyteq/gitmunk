// Test-only support: stub executables (gh, claude, ...) on PATH. Not imported by production code.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'dev-batch-'));

// Writes an executable Node script `name` into dir. The stub first appends {name, argv, selected env}
// to the file named by STUB_LOG, then runs `script`, which sees argv, env and fixture(): the parsed
// JSON file named by STUB_FIXTURE.
export function stubBin(dir, name, script = '') {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const env = process.env;
const fixture = () => JSON.parse(fs.readFileSync(env.STUB_FIXTURE, 'utf8'));
if (env.STUB_LOG) fs.appendFileSync(env.STUB_LOG, JSON.stringify({ name: ${JSON.stringify(name)}, argv,
  env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(STUB_|DEV_BATCH_)/.test(k) || k === 'CLAUDE_CONFIG_DIR')) }) + '\\n');
${script}
`);
  chmodSync(path, 0o755);
  return path;
}

// PATH value with dir first, for a spawned process's env.
export const withPath = (dir, path = process.env.PATH) => `${dir}${delimiter}${path ?? ''}`;
