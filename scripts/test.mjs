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
  'scripts/lib/config-keys.test.mjs',
  'scripts/lib/pointer-check.test.mjs',
  'scripts/lib/jsonc.test.mjs',
  'scripts/lib/hooks.test.mjs',
  'scripts/lib/engine.test.mjs',
  'scripts/build-plugin.test.mjs',
  'scripts/verify.test.mjs',
  'lib/handoff-journal.test.js',
  'lib/state-snapshot.test.js',
  'lib/load-config.test.js',
  'lib/contained-dir.test.js',
  'bin/session-start.test.js',
  'bin/post-tool-use.test.js',
  'bin/user-prompt-submit.test.js',
  'bin/ag-hooks.test.js',
];

// CWK-071: process.exit() forces the process to exit before pending stdout writes flush
// (node/runtime.md 7) -- set process.exitCode and let the process exit naturally instead.
// Wrapped in main() so an early-exit path is a plain `return`, keeping this a flat script
// (no async needed: spawnSync below is already synchronous).
function main() {
  const missing = TESTS.filter((t) => !fs.existsSync(path.join(repo, t)));
  if (missing.length) {
    console.error(`test runner: ${missing.length} listed test file(s) MISSING — ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
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
    process.exitCode = 1;
    return;
  }

  const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: repo, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

main();
