// suite-run.mjs -- how scripts/test.mjs judges the enumerated suite (08e RUNNER BUILD; testing.md: a gate judges a run by the TAP test names it EXPECTS, never by an exit code).
//
// LAYER 0, under the three below, is the canon's (09a): wave-run.mjs puts scripts/lib/stdout-sync.mjs on the NODE_OPTIONS of every file it runs (withStdoutSync), because on a POSIX pipe a
// force-exited file process drops the tail of its report and the runner counts fewer tests than ran (the CI of 4744791). The names lane below runs OUTSIDE wave-run, so it takes the
// canon's exported withStdoutSync itself. The split with the canon, piece by piece: the preload, its wiring on the waved files and the per-file clock (--file-clock-ms) are the canon's;
// the floors, the names manifest, the run-after-waves of the names files and the file clock and tree-kill of that lane are this room's.
// THREE LAYERS, each one a different way a green exit code can lie:
//   1. wave-run.mjs (the canon, adopted byte for byte) runs each file as its own `node --test --test-reporter=tap` child, admitted by the live machine reading, and reads
//      a PASS from the TAP: a file that exits 0 before its tests registered is VACUOUS, never a pass. Its whole-run deadline, and its per-file clock when the room passes one,
//      kill the TREE of the running child.
//   2. A COUNT FLOOR for every file the room lists in scripts/test-expect.json `floors`: the file must report at least that many tests (`# tests N`). A test that vanished
//      from a file that still exits 0 (a `process.exit(0)` after the first test, a deleted leg) takes the count below its floor and the file is FAIL. A floor is a MINIMUM:
//      adding tests never trips it, removing tests does until a person lowers it on purpose (a ratchet, never a target).
//   3. A NAMES MANIFEST for the files listed in `names` (the census and the secret scanners, whose legs are generated per vector): the file must report EVERY listed
//      top-level test name. These files run one at a time AFTER the waves, because wave-run keeps the TAP of a failing file only and this layer needs the names of a passing
//      one; one child at a time never exceeds the machine bound. A name in the run that the manifest does not list is reported, not failed (a new test is never a defect).
// Every roster file must have exactly one of the two entries, and neither list may name a file outside the roster: the manifest drifts loudly in both directions, like the roster.
//
// NAMED OPEN, measured not assumed: the TAP of a file whose test exits 0 AFTER another test passed shows only the tests that finished. Layers 2 and 3 are what see that, for the
// files that have an entry; a floor set to the current count sees one missing test of any file. A file that hangs at its top level (before any test starts, so `--test-timeout`
// never applies) is bounded by the per-file clock when the room sets one, else by the whole-run deadline: it is FAIL, and with the deadline the files that did not start are NOT-RUN.
//
// Node builtins plus ./wave-run.mjs only (Phoenix #2).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STATUS, parseTap, classifyFile, summarize, nodeOptionsWithHeap, withStdoutSync, runWaves } from './wave-run.mjs';

const MAX_LISTED = 5;

const listSome = (items) => items.slice(0, MAX_LISTED).join(', ') + (items.length > MAX_LISTED ? ` (+${items.length - MAX_LISTED} more)` : '');

// ---- the manifest: shape and drift against the roster --------------------------------------------------------------------------------------
export function expectProblems(expect, files) {
  const problems = [];
  const floors = expect && typeof expect.floors === 'object' && expect.floors ? expect.floors : null;
  const names = expect && typeof expect.names === 'object' && expect.names ? expect.names : null;
  if (!floors || !names) return ['scripts/test-expect.json must hold a "floors" object and a "names" object'];
  for (const f of files) {
    const inF = Object.hasOwn(floors, f);
    const inN = Object.hasOwn(names, f);
    if (inF && inN) problems.push(`${f} is listed in both floors and names`);
    else if (!inF && !inN) problems.push(`${f} has no entry: add a count floor (or a names list) to scripts/test-expect.json`);
  }
  for (const [kind, table] of [['floors', floors], ['names', names]]) {
    for (const f of Object.keys(table)) if (!files.includes(f)) problems.push(`${kind} names ${f}, which is not in the roster`);
  }
  for (const [f, n] of Object.entries(floors)) if (!Number.isInteger(n) || n < 1) problems.push(`the floor of ${f} must be a whole number of at least 1`);
  for (const [f, list] of Object.entries(names)) {
    if (!Array.isArray(list) || list.length === 0 || list.some((x) => typeof x !== 'string' || x === '')) problems.push(`the names of ${f} must be a non-empty list of non-empty strings`);
  }
  return problems;
}

// A multiset difference: a name listed twice must be reported twice.
export function judgeNames(expected, actual) {
  const left = new Map();
  for (const n of actual) left.set(n, (left.get(n) ?? 0) + 1);
  const missing = [];
  for (const n of expected) {
    const have = left.get(n) ?? 0;
    if (have > 0) left.set(n, have - 1);
    else missing.push(n);
  }
  const extra = [];
  for (const [n, k] of left) for (let i = 0; i < k; i++) extra.push(n);
  return { missing, extra };
}

// A finished file against its floor. Only a file that otherwise passed (or skipped) is judged: a red or vacuous file keeps the status it has.
export function applyFloor(result, floor) {
  if (result.status !== STATUS.PASS && result.status !== STATUS.SKIP) return result;
  const tests = result.counts ? result.counts.tests : 0;
  if (tests >= floor) return result;
  return { ...result, status: STATUS.FAIL, reason: `ran ${tests} test(s), below its floor of ${floor}: a test vanished, or lower the floor in scripts/test-expect.json on purpose` };
}

// ---- the files with a names manifest: one child, its TAP kept ------------------------------------------------------------------------------
function killTree(child) { // wave-run.mjs does not export its own; the same two moves (taskkill /T on Windows, the process group elsewhere)
  if (process.platform === 'win32') { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 30000, windowsHide: true }); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') child.kill('SIGKILL'); }
}

export function runPinned({ file, cwd, env = process.env, heapMb, fileTimeoutMs, deadlineMs, fileClockMs }) {
  return new Promise((resolve) => {
    const syncEnv = withStdoutSync(env);
    const childEnv = { ...syncEnv, NODE_OPTIONS: nodeOptionsWithHeap(syncEnv.NODE_OPTIONS, heapMb) };
    delete childEnv.NODE_TEST_CONTEXT; // a parent runner's variable switches a nested `node --test` to a binary format with no TAP
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `--test-timeout=${fileTimeoutMs}`, '--test-force-exit', file], {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    let out = '';
    let err = '';
    let killedBy = null;
    let done = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { killedBy = 'killed at the whole-run deadline'; killTree(child); }, deadlineMs);
    // the canon's per-file clock, same words as wave-run.mjs: it ends this file alone and names the clock, which the deadline above would only do at the end of the run
    const clock = fileClockMs === undefined ? null : setTimeout(() => { if (!killedBy) { killedBy = `killed at the file clock (${fileClockMs} ms)`; killTree(child); } }, fileClockMs);
    const finish = (code, signal, startError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (clock) clearTimeout(clock);
      const r = startError
        ? { file, status: STATUS.FAIL, reason: `could not start: ${startError}`, counts: null, failing: [] }
        : classifyFile({ file, code, signal, stdout: out, killedBy });
      r.name = file;
      if (r.status !== STATUS.PASS && r.status !== STATUS.SKIP) { r.stdout = out; r.stderr = err; }
      resolve({ result: r, names: parseTap(out).results.map((x) => x.name) });
    };
    child.on('error', (e) => finish(null, null, e.code ?? e.message));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---- the suite ---------------------------------------------------------------------------------------------------------------------------------
export async function runSuite(opts) {
  const { files, expect, cwd, env = process.env, heapMb, fileTimeoutMs, deadlineMs, fileClockMs, read, serial, onEvent } = opts;
  const problems = expectProblems(expect, files);
  if (problems.length) return { exitCode: 1, problems, results: [], summary: null, extras: {} };
  const started = Date.now();
  const pinned = files.filter((f) => Object.hasOwn(expect.names, f));
  const waved = files.filter((f) => !Object.hasOwn(expect.names, f));
  const byFile = new Map();
  if (waved.length) {
    const wave = await runWaves({ files: waved, cwd, env, heapMb, fileTimeoutMs, deadlineMs, fileClockMs, read, serial, onEvent });
    for (const r of wave.results) byFile.set(r.file, applyFloor(r, expect.floors[r.file]));
  }
  const extras = {};
  for (const file of pinned) {
    const left = deadlineMs - (Date.now() - started);
    if (left <= 0) {
      byFile.set(file, { file, name: file, status: STATUS.NOT_RUN, reason: 'the whole-run deadline was reached before this file started', counts: null, failing: [] });
      continue;
    }
    const args = { file, cwd, env, heapMb, fileTimeoutMs, deadlineMs: left, fileClockMs };
    onEvent?.({ type: 'pinned', file, deadlineMs: args.deadlineMs }); // the budget the pinned run is GIVEN, readable without a clock
    const { result, names } = await runPinned(args);
    if (result.status === STATUS.PASS || result.status === STATUS.SKIP) {
      const { missing, extra } = judgeNames(expect.names[file], names);
      if (missing.length) { result.status = STATUS.FAIL; result.reason = `expected test name(s) missing: ${listSome(missing)}`; }
      if (extra.length) extras[file] = extra;
    }
    byFile.set(file, result);
  }
  const results = files.map((f) => byFile.get(f));
  const summary = summarize(results, files.length);
  return { exitCode: summary.red ? 1 : 0, problems: [], results, summary, extras };
}

// The per-TEST totals over every file that reported a TAP summary: wave-run's own summary counts FILES, so a leg that silently turned into a skip would change nothing a reader sees.
export function testTotals(results) {
  const t = { tests: 0, pass: 0, skipped: 0 };
  for (const r of results) {
    if (!r || !r.counts) continue; // a killed, missing or not-run file has no summary
    t.tests += r.counts.tests;
    t.pass += r.counts.pass;
    t.skipped += r.counts.skipped;
  }
  return t;
}

// ---- the command line of scripts/test.mjs (here so a planted repo can drive it) -----------------------------------------------------------------
// Roster drift in both directions, the manifest, then the run; `--names <file>` prints one file's top-level names. Returns the exit code (0 green, 1 red, 64 usage); never exits.
export async function cli({ repo, tests, dirs, expectFile, argv, limits, io = { out: console.log, err: console.error } }) {
  const { out, err } = io;
  const missing = tests.filter((t) => !fs.existsSync(path.join(repo, t)));
  if (missing.length) { err(`test runner: ${missing.length} listed test file(s) MISSING — ${missing.join(', ')}`); return 1; }
  const onDisk = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(repo, dir))) {
      if (f.endsWith('.test.mjs') || f.endsWith('.test.js')) onDisk.push(`${dir}/${f}`);
    }
  }
  const orphans = onDisk.filter((f) => !tests.includes(f));
  if (orphans.length) { err(`test runner: ${orphans.length} on-disk test(s) NOT in the suite — ${orphans.join(', ')}. Add to scripts/test.mjs.`); return 1; }
  let expect;
  try { expect = JSON.parse(fs.readFileSync(path.join(repo, expectFile), 'utf8')); } catch (e) {
    err(`test runner: cannot read ${expectFile} (${e && e.code ? e.code : e.message}). Restore it from git; the suite is not run without its judge.`);
    return 1;
  }
  const run = { cwd: repo, ...limits };
  const [arg, file] = argv;
  if (arg === '--names') {
    if (!file || !tests.includes(file)) { err('usage: node scripts/test.mjs --names <a test file of the roster>'); return 64; }
    const { result, names } = await runPinned({ file, ...run });
    out(JSON.stringify(names, null, 2));
    err(`test runner: ${file} is ${result.status} with ${names.length} top-level name(s)`);
    return 0;
  }
  if (arg) { err(`test runner: unknown argument ${arg}`); return 64; }
  const suite = await runSuite({ files: tests, expect, ...run });
  for (const p of suite.problems) err(`test runner: ${expectFile}: ${p}`);
  for (const r of suite.results) {
    if (r.status === STATUS.PASS || r.status === STATUS.SKIP) continue;
    out(`${r.status} ${r.name}: ${r.reason}`);
    if (r.stdout || r.stderr) err(`--- ${r.name} (${r.status}) ---\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  const unlisted = Object.entries(suite.extras).map(([f, list]) => `${f} ${list.length}`);
  if (unlisted.length) out(`test runner: test name(s) the manifest does not list (not a failure; print them with --names): ${unlisted.join(', ')}`);
  if (suite.summary) {
    out(suite.summary.line);
    const t = testTotals(suite.results);
    out(`test runner: ${t.tests} test(s) · pass ${t.pass} · skipped ${t.skipped} (per test, summed over the files that reported)`);
  }
  return suite.exitCode;
}

