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
  'scripts/configure.test.mjs',
  'scripts/lib/config-schema.test.mjs',
  'scripts/lib/config-load.test.mjs',
  'scripts/lib/config-keys.test.mjs',
  'scripts/lib/link-check.test.mjs',
  'scripts/lib/pointer-check.test.mjs',
  'scripts/lib/jsonc.test.mjs',
  'scripts/lib/git-env.test.mjs',
  'scripts/lib/git-env-census.test.mjs',
  'scripts/secret-scan.test.mjs',
  'scripts/secret-gate.test.mjs',
  'scripts/release-notes.test.mjs',
  'scripts/verify-release-shape.test.mjs',
  'scripts/lib/release-shape.test.mjs',
  'scripts/lib/hooks.test.mjs',
  'scripts/lib/cwk137.test.mjs',
  'scripts/lib/engine.test.mjs',
  'scripts/build-plugin.test.mjs',
  'scripts/verify.test.mjs',
  'lib/handoff-journal.test.js',
  'lib/state-snapshot.test.js',
  'lib/load-config.test.js',
  'lib/contained-dir.test.js',
  'lib/repo-fs.test.js',
  'lib/journal-cap.test.js',
  'bin/session-start.test.js',
  'bin/post-tool-use.test.js',
  'bin/user-prompt-submit.test.js',
  'bin/ag-hooks.test.js',
];

// CWK-199 (R20): a harness child carries a finite clock and a heap cap (testing.md Determinism: every test run has a finite clock, a MUST; AGENTS.md, the runaway test child).
// `--test-timeout` fails ONE test that runs past it (the default is Infinity, so one hung test held a hook for ever). On its own it is not enough, measured: the test is
// marked failed at the limit but its file child stays alive while the test left a timer or a child running, so the run still hung; `--test-force-exit` ends that file child
// once its tests are done.
// THE TRADE, chosen here: force-exit ends a child held open by a leaked handle, and it also lets a LATE async failure pass unreported. A test that returns, and then has an
// unawaited timer throw or a promise reject after it, is reported as a pass (the R20 INSPECT witness: the same file exits 1 without the
// flag and 0 with it). So a test must await everything it starts; a handle left running is a defect in the test, not something this flag makes safe.
// `--test-concurrency=1` runs the files one at a time (the house rule for a test child). The heap cap goes to the runner and node:test hands it on to
// every test file it starts (measured: a planted test saw a 2240 MB heap limit under it).
// SIZING (this room's own variable, never the canon's 300 s): one run of the whole suite (738 tests, 60 s) on a loaded box (49.5% busy, seven other seats alive, 2026-10-04) had
// its slowest single test at 20 s (a git-fixture scan), the next at 8 s. 120 s is six times the slowest, and the most a test child may run (the house cap). A test that needs
// more is a defect to fix, not a number to raise.
// Taken from the canon (`.github` e7c7959, gate-test-run.mjs): the heap cap of 2048 MB and the per-test kill-timeout. Not taken: its whole-run timer that kills the process tree
// (needs an async spawn and a process group on POSIX), and its env override of the limit (only that file's own tests needed it). NAMED GAP, measured: a test FILE that hangs
// at its top level, before any test starts, is not bounded by `--test-timeout`; each spawn in a test carries its own `timeout`, as testing.md asks.
const HEAP_CAP_MB = 2048;
const TEST_TIMEOUT_MS = 120000;

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

  const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_CAP_MB}`, '--test', '--test-concurrency=1', '--test-force-exit', `--test-timeout=${TEST_TIMEOUT_MS}`, ...TESTS], { cwd: repo, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

main();
