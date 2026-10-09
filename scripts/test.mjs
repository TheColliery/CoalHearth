#!/usr/bin/env node
// CoalHearth test runner -- the canonical gate suite. Enumerates EVERY test file explicitly and FAILS LOUD on drift in BOTH directions (listed-but-missing,
// on-disk-but-unlisted), and the same for scripts/test-expect.json against the roster. Mirrors CoalTipple's scripts/test.mjs. Run by pre-commit / pre-push alongside
// verify.mjs.
//
// 08e RUNNER BUILD: the suite is judged by what the TAP says, never by an exit code alone (testing.md: a gate judges a run by the TAP test names it expects).
//   - Each file runs as its own `node --test --test-reporter=tap --test-force-exit` child through scripts/lib/wave-run.mjs (the canon, BB-87), the next file admitted only while a
//     fresh machine reading says BREATHE; a file that exits 0 before its tests registered is VACUOUS, not a pass.
//   - scripts/test-expect.json holds a count FLOOR for every file, or, for the census and the secret scanners, the NAMES the file must report (scripts/lib/suite-run.mjs).
//   - The whole run has a deadline that kills the process TREE of every running child, and (09b) each file has its own wall clock, --file-clock-ms: a file that hangs before its first
//     test is FAIL at its own clock and the rest of the roster still runs, where the deadline alone would end the whole run.
//   `node scripts/test.mjs --names <file>` prints the top-level test names of one file, to keep the manifest.
//
// CWK-199 (R20): a harness child carries a finite clock and a heap cap (testing.md Determinism: every test run has a finite clock, a MUST; AGENTS.md, the runaway test child).
// `--test-timeout` fails ONE test that runs past it (the default is Infinity). On its own it is not enough, measured: the test is marked failed at the limit but its file
// child stays alive while the test left a timer or a child running; `--test-force-exit` ends that file child once its tests are done.
// THE TRADE, chosen here: force-exit ends a child held open by a leaked handle, and it also lets a LATE async failure pass unreported. A test that returns, and then has an
// unawaited timer throw or a promise reject after it, is reported as a pass (the R20 INSPECT witness: the same file exits 1 without the flag and 0 with it). So a test must
// await everything it starts; a handle left running is a defect in the test, not something this flag makes safe.
// The heap cap rides NODE_OPTIONS, so every test file and every process a test starts inherits it (measured at R20: a planted test saw a 2240 MB limit under it).
// SIZING (this room's own variables, never the canon's): one run of the whole suite (738 tests, 60 s serial; 155-173 s at 70-85% busy, 2026-10-04) had its slowest single test
// at 20 s (a git-fixture scan), the next at 8 s. 120 s per test is six times the slowest and the most a test child may run (the house cap). The whole-run deadline is
// ten minutes, about three and a half times the slowest measured serial run; a run that needs more is a defect to fix, not a number to raise.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'scripts/git-env-pins.test.mjs',
  'scripts/secret-scan.test.mjs',
  'scripts/secret-gate.test.mjs',
  'scripts/release-notes.test.mjs',
  'scripts/verify-release-shape.test.mjs',
  'scripts/lib/release-shape.test.mjs',
  'scripts/lib/hooks.test.mjs',
  'scripts/lib/cwk137.test.mjs',
  'scripts/lib/engine.test.mjs',
  'scripts/lib/wave-run.test.mjs',
  'scripts/lib/suite-run.test.mjs',
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

const HEAP_CAP_MB = 2048;
const TEST_TIMEOUT_MS = 120000;
const DEADLINE_MS = 600000;
// The per-file wall clock (--file-clock-ms), this room's own variable: the slowest roster file measured 58 s serial and 48 s in waves on a box 57% busy (09a, 2026-10-09), so 240 s is
// four times the slowest and stays under the whole-run deadline; it kills one hung file and lets the rest of the run go on.
const FILE_CLOCK_MS = 240000;

// CWK-071: process.exit() forces the process to exit before pending stdout writes flush (node/runtime.md 7) -- set process.exitCode and let the process exit naturally.
// The judge is imported inside main (node/runtime.md 1): a missing scripts/lib/suite-run.mjs is a clean message and a red exit, never a link-time stack.
async function main() {
  let suite;
  try {
    suite = await import(pathToFileURL(path.join(repo, 'scripts/lib/suite-run.mjs')).href);
  } catch (e) {
    console.error(`test runner: cannot load scripts/lib/suite-run.mjs (${e && e.code ? e.code : e.message}). Restore it from git; the suite is not run without its judge.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await suite.cli({
    repo, tests: TESTS, dirs: ['scripts', 'scripts/lib', 'lib', 'bin'], expectFile: 'scripts/test-expect.json', argv: process.argv.slice(2),
    limits: { heapMb: HEAP_CAP_MB, fileTimeoutMs: TEST_TIMEOUT_MS, deadlineMs: DEADLINE_MS, fileClockMs: FILE_CLOCK_MS },
  });
}

main().catch((e) => {
  console.error(`test runner: crashed (${e && e.message ? e.message : 'error'})`);
  process.exitCode = 1;
});
