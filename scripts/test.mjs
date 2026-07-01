#!/usr/bin/env node
// CoalHearth test runner — the canonical gate suite. Enumerates EVERY test file
// explicitly and FAILS LOUD on drift in BOTH directions (listed-but-missing,
// on-disk-but-unlisted). Mirrors CoalTipple's scripts/test.mjs. Run by
// pre-commit / pre-push alongside verify.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TESTS = [
  'scripts/lib/config-schema.test.mjs',
  'scripts/lib/config-load.test.mjs',
  'scripts/lib/jsonc.test.mjs',
  'scripts/lib/hooks.test.mjs',
  'scripts/lib/engine.test.mjs',
  'scripts/build-plugin.test.mjs',
  'lib/handoff-journal.test.js',
  'lib/state-snapshot.test.js',
  'lib/load-config.test.js',
  'bin/session-start.test.js',
  'bin/post-tool-use.test.js',
];

const missing = TESTS.filter((t) => !fs.existsSync(path.join(repo, t)));
if (missing.length) {
  console.error(`test runner: ${missing.length} listed test file(s) MISSING — ${missing.join(', ')}`);
  process.exit(1);
}

const onDisk = [];
for (const dir of ['scripts', 'scripts/lib', 'lib', 'bin']) {
  for (const f of fs.readdirSync(path.join(repo, dir))) {
    if (f.endsWith('.test.mjs') || f.endsWith('.test.js')) onDisk.push(`${dir}/${f}`);
  }
}
const orphans = onDisk.filter((f) => !TESTS.includes(f));
if (orphans.length) {
  console.error(`test runner: ${orphans.length} on-disk test(s) NOT in the suite — ${orphans.join(', ')}. Add to scripts/test.mjs.`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: repo, stdio: 'inherit' });
process.exit(r.status ?? 1);
