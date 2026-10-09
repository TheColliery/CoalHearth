// suite-run.test.mjs -- 08e RUNNER BUILD: the suite is judged by the TAP, never by an exit code alone (testing.md; the 08d pending decision 1), and a hang before the first test is
// bounded by the whole-run deadline's tree kill (the R20 named gap). Hermetic: the fixtures are written into a scratch folder at run time; every child runs under a heap cap and
// a finite clock. RED before 08e: scripts/test.mjs judged one `node --test` child by its exit code (a planted file that called process.exit(0) before its tests read green;
// a planted file that hung at its top level ran to the outer kill; measured, scratchpad/r08e/coder/red-old.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STATUS, runWaves } from './wave-run.mjs';
import { expectProblems, judgeNames, applyFloor, testTotals, withStdoutSync, runSuite, runPinned, cli } from './suite-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-run-test-'));
test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const LIMITS = { heapMb: 512, fileTimeoutMs: 20000, deadlineMs: 60000 };

const FIXTURES = {
  'three.fixture.mjs': "import { test } from 'node:test';\ntest('alpha', () => {});\ntest('beta', () => {});\ntest('gamma', () => {});\n",
  'four.fixture.mjs': "import { test } from 'node:test';\ntest('alpha', () => {});\ntest('beta', () => {});\ntest('gamma', () => {});\ntest('delta', () => {});\n",
  // the first test passes, the second ends the process with exit 0 from a timer: the TAP shows ONE test and "# pass 1", exit 0, and no VACUOUS tell (the named open of
  // wave-run.mjs, measured on Node 24.19; a plain process.exit(0) in the test body is VACUOUS instead, because the file-level line is then the only result)
  'exit-after-first.fixture.mjs': "import { test } from 'node:test';\ntest('alpha', async () => { await new Promise((r) => setTimeout(r, 50)); });\ntest('beta', async () => { await new Promise(() => setTimeout(() => process.exit(0), 300)); });\ntest('gamma', () => {});\n",
  'exit-before.fixture.mjs': "import { test } from 'node:test';\nprocess.exit(0);\ntest('alpha', () => {});\n",
  'fail.fixture.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('alpha', () => assert.equal(1, 2));\n",
  'slow.fixture.mjs': "import { test } from 'node:test';\ntest('alpha', async () => { await new Promise((r) => setTimeout(r, 2500)); });\n",
  'skip.fixture.mjs': "import { test } from 'node:test';\ntest('alpha', { skip: 'no link here' }, () => {});\n",
  'heap.fixture.mjs': "import { test } from 'node:test'; import fs from 'node:fs'; import v8 from 'node:v8';\ntest('alpha', () => { fs.writeFileSync(process.env.HEAP_FILE, String(v8.getHeapStatistics().heap_size_limit)); });\n",
  'marker.fixture.mjs': "import { test } from 'node:test'; import fs from 'node:fs';\ntest('alpha', () => { fs.writeFileSync(process.env.MARKER_FILE, 'ran'); });\n",
  // a hang BEFORE the first test: --test-timeout never applies; it starts a grandchild, records its pid, and keeps its own event loop alive for ever
  'top-hang.fixture.mjs': "import { spawn } from 'node:child_process'; import fs from 'node:fs';\nconst c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nfs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(c.pid));\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n",
};
// A POSIX pipe, simulated (a Windows pipe is blocking, so the loss cannot happen there): the first 32 KiB a file process writes go through at once (the kernel buffer), the rest is queued and
// dies with process.exit() -- unless the stream was switched to blocking, which is what scripts/lib/stdout-sync.mjs does. Installed only in the test FILE's own process (the runner's child).
const SIM = [
  "if (process.env.NODE_TEST_CONTEXT === 'child-v8') {",
  '  const out = process.stdout;',
  '  let written = 0;',
  '  let blocking = false;',
  '  const h = out._handle;',
  "  if (h && typeof h.setBlocking === 'function') { const real = h.setBlocking.bind(h); h.setBlocking = (v) => { blocking = !!v; return real(v); }; }",
  '  const realWrite = out.write.bind(out);',
  '  out.write = function (chunk, enc, cb) {',
  "    const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;",
  '    const direct = blocking || written + n <= 32768;',
  '    written += n;',
  '    if (direct) return realWrite(chunk, enc, cb);',
  '    setTimeout(() => realWrite(chunk, enc, cb), 400);',
  '    return true;',
  '  };',
  '}',
  '',
].join(String.fromCharCode(10));
fs.writeFileSync(path.join(SANDBOX, 'async-pipe.sim.mjs'), SIM);
const SIM_NODE_OPTIONS = '--import ' + pathToFileURL(path.join(SANDBOX, 'async-pipe.sim.mjs')).href;
const MANY = 300;
fs.writeFileSync(path.join(SANDBOX, 'many.fixture.mjs'), "import { test } from 'node:test';" + String.fromCharCode(10) + 'for (let i = 0; i < ' + MANY + "; i++) test('t' + i, () => {});" + String.fromCharCode(10));
for (const [name, text] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(SANDBOX, name), text);
const fx = (...names) => names.map((n) => `${n}.fixture.mjs`);
const byName = (run, file) => run.results.find((r) => r.file === file);
const run = (opts) => runSuite({ cwd: SANDBOX, env: process.env, serial: true, ...LIMITS, ...opts });

// ---- the pure parts -----------------------------------------------------------------------------------------------------------------------
test('expectProblems: a complete manifest has none; a file with no entry, in both tables, a stray entry, a bad floor and a bad names list are each named', () => {
  const files = ['a.test.mjs', 'b.test.mjs'];
  assert.deepEqual(expectProblems({ floors: { 'a.test.mjs': 3 }, names: { 'b.test.mjs': ['x'] } }, files), []);
  assert.match(expectProblems({ floors: { 'a.test.mjs': 3 }, names: {} }, files).join('|'), /b\.test\.mjs has no entry/);
  assert.match(expectProblems({ floors: { 'a.test.mjs': 3, 'b.test.mjs': 1 }, names: { 'b.test.mjs': ['x'] } }, files).join('|'), /b\.test\.mjs is listed in both/);
  assert.match(expectProblems({ floors: { 'a.test.mjs': 3, 'b.test.mjs': 1, 'c.test.mjs': 1 }, names: {} }, files).join('|'), /floors names c\.test\.mjs, which is not in the roster/);
  assert.match(expectProblems({ floors: { 'a.test.mjs': 1 }, names: { 'b.test.mjs': ['x'], 'z.test.mjs': ['y'] } }, files).join('|'), /names names z\.test\.mjs, which is not in the roster/);
  for (const bad of [0, -1, 1.5, '3', null]) assert.match(expectProblems({ floors: { 'a.test.mjs': bad, 'b.test.mjs': 1 }, names: {} }, files).join('|'), /floor of a\.test\.mjs must be a whole number/);
  for (const bad of [[], [''], [1], 'x', null]) assert.match(expectProblems({ floors: { 'a.test.mjs': 1 }, names: { 'b.test.mjs': bad } }, files).join('|'), /names of b\.test\.mjs must be a non-empty list/);
  assert.match(expectProblems(null, files).join('|'), /must hold a "floors" object and a "names" object/);
  assert.match(expectProblems({ floors: {} }, files).join('|'), /must hold a "floors" object and a "names" object/);
});

test('judgeNames: missing and extra names are told apart, and a name listed twice must be reported twice', () => {
  assert.deepEqual(judgeNames(['a', 'b'], ['b', 'a']), { missing: [], extra: [] });
  assert.deepEqual(judgeNames(['a', 'b', 'c'], ['a']), { missing: ['b', 'c'], extra: [] });
  assert.deepEqual(judgeNames(['a'], ['a', 'z', 'y']), { missing: [], extra: ['z', 'y'] });
  assert.deepEqual(judgeNames(['a', 'a'], ['a']), { missing: ['a'], extra: [] });
  assert.deepEqual(judgeNames(['a'], ['a', 'a']), { missing: [], extra: ['a'] });
});

test('applyFloor: below the floor turns a PASS or a SKIP into FAIL naming both numbers; at or above it, and any other status, are untouched', () => {
  const r = (status, tests) => ({ file: 'a.test.mjs', status, reason: '', counts: tests === null ? null : { tests } });
  assert.equal(applyFloor(r(STATUS.PASS, 3), 3).status, STATUS.PASS);
  assert.equal(applyFloor(r(STATUS.PASS, 9), 3).status, STATUS.PASS);
  const low = applyFloor(r(STATUS.PASS, 2), 3);
  assert.equal(low.status, STATUS.FAIL);
  assert.match(low.reason, /ran 2 test\(s\), below its floor of 3/);
  assert.equal(applyFloor(r(STATUS.SKIP, 1), 3).status, STATUS.FAIL);
  for (const s of [STATUS.FAIL, STATUS.VACUOUS, STATUS.NOT_RUN]) assert.equal(applyFloor(r(s, 0), 3).status, s);
  assert.equal(applyFloor(r(STATUS.PASS, null), 3).status, STATUS.FAIL, 'a pass with no counts has run no test');
});

test('testTotals: sums tests, passes and skipped TESTS over the files that reported a summary, and passes over a file with none', () => {
  const r = (counts) => ({ file: 'x', counts });
  assert.deepEqual(testTotals([]), { tests: 0, pass: 0, skipped: 0 });
  assert.deepEqual(testTotals([r({ tests: 5, pass: 4, skipped: 1 }), r({ tests: 3, pass: 3, skipped: 0 }), r(null), undefined, r({ tests: 2, pass: 0, skipped: 2 })]), { tests: 10, pass: 7, skipped: 3 });
});

// ---- the loss at the end of a file process on a POSIX pipe (08e RUNNER RED FIX) ------------------------------------------------------------------------------------------
test('the simulation bites: through the canon wave-run alone, a file of 300 tests reports fewer than 300 when its stdout queues writes and the process is force-exited', async () => {
  const r = await runWaves({ files: ['many.fixture.mjs'], cwd: SANDBOX, env: { ...process.env, NODE_OPTIONS: SIM_NODE_OPTIONS }, ...LIMITS, serial: true });
  const res = r.results[0];
  assert.ok(!(res.status === STATUS.PASS && res.counts && res.counts.tests === MANY), 'the control must lose events, or the legs below prove nothing: ' + res.status + ' ' + JSON.stringify(res.counts));
});

test('a file of 300 tests whose stdout would queue writes (a POSIX pipe) still reports all 300 to the floors lane -- RED before the RED FIX (counts differed from leg to leg on the CI of 4744791)', async () => {
  const r = await run({ files: ['many.fixture.mjs'], env: { ...process.env, NODE_OPTIONS: SIM_NODE_OPTIONS }, expect: { floors: { 'many.fixture.mjs': MANY }, names: {} } });
  const res = byName(r, 'many.fixture.mjs');
  assert.equal(res.status, STATUS.PASS, res.reason);
  assert.equal(res.counts.tests, MANY);
  assert.equal(r.exitCode, 0);
});

test('the same for the names lane: every one of the 300 listed names is reported -- RED before the RED FIX', async () => {
  const names = Array.from({ length: MANY }, (_, i) => 't' + i);
  const r = await run({ files: ['many.fixture.mjs'], env: { ...process.env, NODE_OPTIONS: SIM_NODE_OPTIONS }, expect: { floors: {}, names: { 'many.fixture.mjs': names } } });
  const res = byName(r, 'many.fixture.mjs');
  assert.equal(res.status, STATUS.PASS, res.reason);
  assert.equal(r.exitCode, 0);
});

test('withStdoutSync: the preload goes AFTER what the caller already set in NODE_OPTIONS, once, and the other variables are kept', () => {
  const url = pathToFileURL(path.join(HERE, 'stdout-sync.mjs')).href;
  assert.equal(withStdoutSync({ A: '1' }).NODE_OPTIONS, '--import ' + url);
  assert.equal(withStdoutSync({ A: '1' }).A, '1');
  const mine = '--import file:///sim.mjs --max-old-space-size=512';
  assert.equal(withStdoutSync({ NODE_OPTIONS: mine }).NODE_OPTIONS, mine + ' --import ' + url);
  const once = withStdoutSync({ NODE_OPTIONS: mine });
  assert.equal(withStdoutSync(once), once, 'a second call adds nothing');
});

test('the stdout preload is silent and harmless: with stdout a pipe, a file or nothing it exits 0 and says nothing', () => {
  const url = pathToFileURL(path.join(HERE, 'stdout-sync.mjs')).href;
  const out = path.join(SANDBOX, 'preload-out.txt');
  const fd = fs.openSync(out, 'w');
  try {
    const piped = spawnSync(process.execPath, ['--import', url, '-e', "process.stdout.write('hello'); process.stderr.write('')"], { encoding: 'utf8', timeout: 30000 });
    assert.equal(piped.status, 0);
    assert.equal(piped.stdout, 'hello');
    assert.equal(piped.stderr, '');
    const toFile = spawnSync(process.execPath, ['--import', url, '-e', "process.stdout.write('hello')"], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 30000 });
    assert.equal(toFile.status, 0);
    assert.equal(toFile.stderr, '');
    const none = spawnSync(process.execPath, ['--import', url, '-e', '1'], { stdio: 'ignore', timeout: 30000 });
    assert.equal(none.status, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.readFileSync(out, 'utf8'), 'hello');
});

// ---- the waved files: floors ----------------------------------------------------------------------------------------------------------------
test('a clean file at its floor is green; a file that exited 0 AFTER its first test passed (3 tests listed, 1 reported) is FAIL below its floor, which the TAP alone calls a pass -- RED before 08e', async () => {
  const ok = await run({ files: fx('three'), expect: { floors: { 'three.fixture.mjs': 3 }, names: {} } });
  assert.equal(ok.exitCode, 0);
  assert.equal(byName(ok, 'three.fixture.mjs').status, STATUS.PASS);
  const gone = await run({ files: fx('exit-after-first'), expect: { floors: { 'exit-after-first.fixture.mjs': 3 }, names: {} } });
  assert.equal(gone.exitCode, 1);
  const r = byName(gone, 'exit-after-first.fixture.mjs');
  assert.equal(r.status, STATUS.FAIL);
  assert.match(r.reason, /ran 1 test\(s\), below its floor of 3/);
  const unfloored = await run({ files: fx('exit-after-first'), expect: { floors: { 'exit-after-first.fixture.mjs': 1 }, names: {} } });
  assert.equal(unfloored.exitCode, 0, 'with the floor at what it reports, the vanished test is invisible: this is the case the floor exists for');
});

test('a file that exits 0 before any test registered is VACUOUS in the waves, and the run is red -- RED before 08e', async () => {
  const r = await run({ files: fx('exit-before', 'three'), expect: { floors: { 'exit-before.fixture.mjs': 1, 'three.fixture.mjs': 3 }, names: {} } });
  assert.equal(r.exitCode, 1);
  assert.equal(byName(r, 'exit-before.fixture.mjs').status, STATUS.VACUOUS);
  assert.equal(byName(r, 'three.fixture.mjs').status, STATUS.PASS);
  assert.match(r.summary.line, /vacuous 1/);
});

test('a failing file keeps its own status (the floor does not rewrite a FAIL), and the other files still ran', async () => {
  const r = await run({ files: fx('fail', 'three'), expect: { floors: { 'fail.fixture.mjs': 5, 'three.fixture.mjs': 3 }, names: {} } });
  assert.equal(r.exitCode, 1);
  assert.equal(byName(r, 'fail.fixture.mjs').status, STATUS.FAIL);
  assert.match(byName(r, 'fail.fixture.mjs').reason, /not ok: alpha/);
  assert.equal(byName(r, 'three.fixture.mjs').status, STATUS.PASS);
});

// ---- the files with a names manifest ---------------------------------------------------------------------------------------------------------
test('a names-manifest file passes when it reports every listed name, in any order, and an unlisted name is reported in extras without failing -- the control', async () => {
  const exact = await run({ files: fx('three'), expect: { floors: {}, names: { 'three.fixture.mjs': ['gamma', 'alpha', 'beta'] } } });
  assert.equal(exact.exitCode, 0);
  assert.deepEqual(exact.extras, {});
  const extra = await run({ files: fx('four'), expect: { floors: {}, names: { 'four.fixture.mjs': ['alpha', 'beta', 'gamma'] } } });
  assert.equal(extra.exitCode, 0);
  assert.deepEqual(extra.extras, { 'four.fixture.mjs': ['delta'] });
});

test('a names-manifest file that reports fewer names than listed is FAIL naming the missing ones, though its exit code is 0 and its TAP says "# pass 1" -- RED before 08e', async () => {
  const r = await run({ files: fx('exit-after-first'), expect: { floors: {}, names: { 'exit-after-first.fixture.mjs': ['alpha', 'beta', 'gamma'] } } });
  assert.equal(r.exitCode, 1);
  const res = byName(r, 'exit-after-first.fixture.mjs');
  assert.equal(res.status, STATUS.FAIL);
  assert.match(res.reason, /expected test name\(s\) missing: beta, gamma/);
});

test('a names-manifest file that exits 0 before its tests is VACUOUS (its own status), and a renamed test is a missing name, not a pass', async () => {
  const v = await run({ files: fx('exit-before'), expect: { floors: {}, names: { 'exit-before.fixture.mjs': ['alpha'] } } });
  assert.equal(v.exitCode, 1);
  assert.equal(byName(v, 'exit-before.fixture.mjs').status, STATUS.VACUOUS);
  const renamed = await run({ files: fx('three'), expect: { floors: {}, names: { 'three.fixture.mjs': ['alpha', 'beta', 'the old name'] } } });
  assert.equal(renamed.exitCode, 1);
  assert.match(byName(renamed, 'three.fixture.mjs').reason, /missing: the old name/);
  assert.deepEqual(renamed.extras, { 'three.fixture.mjs': ['gamma'] });
});

test('a failing names-manifest file keeps FAIL with the failing test named, and its diagnostics are kept', async () => {
  const r = await run({ files: fx('fail'), expect: { floors: {}, names: { 'fail.fixture.mjs': ['alpha'] } } });
  assert.equal(r.exitCode, 1);
  const res = byName(r, 'fail.fixture.mjs');
  assert.equal(res.status, STATUS.FAIL);
  assert.match(res.reason, /not ok: alpha/);
  assert.ok(res.stdout.includes('not ok'));
});

// ---- the manifest drifts loudly -------------------------------------------------------------------------------------------------------------
test('a manifest that does not match the roster runs NOTHING and is red with every problem named', async () => {
  const marker = path.join(SANDBOX, 'marker-ran.txt');
  const r = await run({ files: fx('marker'), env: { ...process.env, MARKER_FILE: marker }, expect: { floors: {}, names: {} } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.summary, null);
  assert.match(r.problems.join('|'), /marker\.fixture\.mjs has no entry/);
  assert.equal(fs.existsSync(marker), false, 'no child was started');
  const ran = await run({ files: fx('marker'), env: { ...process.env, MARKER_FILE: marker }, expect: { floors: { 'marker.fixture.mjs': 1 }, names: {} } });
  assert.equal(ran.exitCode, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'the control: with an entry the same file runs');
});

// ---- the hang before the first test: the whole-run deadline kills the TREE ----------------------------------------------------------------------
const gone = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (e) { return e.code === 'ESRCH'; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test('a file that hangs before its first test is bounded by the whole-run deadline: FAIL, its grandchild killed with it, the next file NOT-RUN -- RED before 08e (the old runner ran to the outer kill)', async () => {
  const pidFile = path.join(SANDBOX, 'wave-grandchild.pid');
  const r = await run({ files: fx('top-hang', 'three'), env: { ...process.env, GRANDCHILD_PID_FILE: pidFile }, deadlineMs: 2500, expect: { floors: { 'top-hang.fixture.mjs': 1, 'three.fixture.mjs': 3 }, names: {} } });
  assert.equal(r.exitCode, 1);
  assert.equal(byName(r, 'top-hang.fixture.mjs').status, STATUS.FAIL);
  assert.match(byName(r, 'top-hang.fixture.mjs').reason, /killed at the whole-run deadline/);
  assert.equal(byName(r, 'three.fixture.mjs').status, STATUS.NOT_RUN);
  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true, 'the grandchild died with the tree');
});

test('the same for a names-manifest file (it runs in the pinned lane, not in wave-run): killed at the deadline with its tree, and the file after it is NOT-RUN with the remaining budget spent', async () => {
  const pidFile = path.join(SANDBOX, 'pinned-grandchild.pid');
  const r = await run({ files: fx('top-hang', 'three'), env: { ...process.env, GRANDCHILD_PID_FILE: pidFile }, deadlineMs: 2500, expect: { floors: {}, names: { 'top-hang.fixture.mjs': ['alpha'], 'three.fixture.mjs': ['alpha', 'beta', 'gamma'] } } });
  assert.equal(r.exitCode, 1);
  assert.match(byName(r, 'top-hang.fixture.mjs').reason, /killed at the whole-run deadline/);
  assert.equal(byName(r, 'three.fixture.mjs').status, STATUS.NOT_RUN);
  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true, 'the grandchild died with the tree');
});

test('the pinned lane is GIVEN only the budget the earlier files left: after a slow file the hang gets less than the whole deadline, and is killed at that budget', async () => {
  const pidFile = path.join(SANDBOX, 'budget-grandchild.pid');
  const given = [];
  const r = await run({
    files: fx('slow', 'top-hang'), env: { ...process.env, GRANDCHILD_PID_FILE: pidFile }, deadlineMs: 6000,
    onEvent: (e) => { if (e.type === 'pinned') given.push(e); },
    expect: { floors: {}, names: { 'slow.fixture.mjs': ['alpha'], 'top-hang.fixture.mjs': ['alpha'] } },
  });
  assert.equal(byName(r, 'slow.fixture.mjs').status, STATUS.PASS);
  assert.deepEqual(given.map((e) => e.file), ['slow.fixture.mjs', 'top-hang.fixture.mjs']);
  assert.ok(given[0].deadlineMs > 5000 && given[0].deadlineMs <= 6000, 'the first pinned file is given what the run has: ' + given[0].deadlineMs);
  // the slow file's own test waits 2500 ms, so at least that much is gone whatever the host does: a LOWER bound on elapsed time, which a loaded box can only widen
  assert.ok(given[1].deadlineMs > 0 && given[1].deadlineMs <= 6000 - 2000, 'the hang is given the remainder, not the whole deadline: ' + given[1].deadlineMs);
  assert.match(byName(r, 'top-hang.fixture.mjs').reason, /killed at the whole-run deadline/);
  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
});

test('runPinned: a file that cannot start is FAIL, never a throw; the pinned lane takes the room heap cap and drops a parent runner\'s NODE_TEST_CONTEXT', async () => {
  const none = await runPinned({ file: 'does-not-exist.fixture.mjs', cwd: SANDBOX, env: process.env, ...LIMITS });
  assert.equal(none.result.status, STATUS.FAIL);
  const withCtx = await runPinned({ file: fx('three')[0], cwd: SANDBOX, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }, ...LIMITS });
  assert.equal(withCtx.result.status, STATUS.PASS, 'with the parent variable left in, the child would print a binary format and no TAP');
  assert.deepEqual(withCtx.names, ['alpha', 'beta', 'gamma']);
});

test('runPinned: the pinned lane runs under the room heap cap (NODE_OPTIONS), and a names-manifest file whose tests are all skipped is still judged by its names', async () => {
  const heapFile = path.join(SANDBOX, 'heap-limit.txt');
  const env = { ...process.env, HEAP_FILE: heapFile };
  delete env.NODE_OPTIONS; // this box may export its own cap, which would mask a missing one
  const r = await runPinned({ file: fx('heap')[0], cwd: SANDBOX, env, ...LIMITS, heapMb: 512 });
  assert.equal(r.result.status, STATUS.PASS);
  const limit = Number(fs.readFileSync(heapFile, 'utf8'));
  assert.ok(limit > 0 && limit < 1024 * 1024 * 1024, `the child saw a heap limit of ${limit} bytes under a 512 MB cap`);
  const skipped = await run({ files: fx('skip'), expect: { floors: {}, names: { 'skip.fixture.mjs': ['alpha', 'beta'] } } });
  assert.equal(skipped.exitCode, 1);
  assert.match(byName(skipped, 'skip.fixture.mjs').reason, /missing: beta/);
  const skippedOk = await run({ files: fx('skip'), expect: { floors: {}, names: { 'skip.fixture.mjs': ['alpha'] } } });
  assert.equal(byName(skippedOk, 'skip.fixture.mjs').status, STATUS.SKIP);
  assert.equal(skippedOk.exitCode, 0);
});

// ---- the command line, driven on a planted repository ---------------------------------------------------------------------------------------
let repoN = 0;
function plantRepo({ roster, expect, extraOnDisk = [] }) {
  const repo = path.join(SANDBOX, `repo-${++repoN}`);
  for (const d of ['scripts', 'scripts/lib', 'lib', 'bin']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  for (const [rel, fixture] of Object.entries(roster)) fs.writeFileSync(path.join(repo, rel), FIXTURES[`${fixture}.fixture.mjs`]);
  for (const rel of extraOnDisk) fs.writeFileSync(path.join(repo, rel), FIXTURES['three.fixture.mjs']);
  if (expect !== null) fs.writeFileSync(path.join(repo, 'scripts', 'test-expect.json'), typeof expect === 'string' ? expect : JSON.stringify(expect));
  return repo;
}
async function drive(repo, roster, argv = []) {
  const out = [];
  const err = [];
  const code = await cli({
    repo, tests: Object.keys(roster), dirs: ['scripts', 'scripts/lib', 'lib', 'bin'], expectFile: 'scripts/test-expect.json', argv,
    limits: { ...LIMITS, serial: true }, io: { out: (l) => out.push(l), err: (l) => err.push(l) },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('cli: a green run prints one summary line and returns 0; a name the manifest does not list is noted and does not fail', async () => {
  const roster = { 'scripts/a.test.mjs': 'three', 'lib/b.test.mjs': 'four', 'bin/c.test.js': 'skip' };
  const repo = plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 3, 'bin/c.test.js': 1 }, names: { 'lib/b.test.mjs': ['alpha', 'beta', 'gamma'] } } });
  const r = await drive(repo, roster);
  assert.equal(r.code, 0);
  assert.match(r.out, /wave-run: 3 files · pass 2 · fail 0 .* skipped 1/);
  assert.match(r.out, /^test runner: 8 test\(s\) · pass 7 · skipped 1 \(per test, summed/m, 'the skipped TESTS are counted, beside the files');
  assert.doesNotMatch(r.out, /^SKIP /m, 'a skipped file is counted, not printed as a problem');
  assert.match(r.out, /name\(s\) the manifest does not list .*lib\/b\.test\.mjs 1/);
  assert.equal(r.err, '');
});

test('cli: a vacuous file and a file below its floor make it return 1, each printed with its status and reason, the diagnostics of the vacuous one on stderr', async () => {
  const roster = { 'scripts/a.test.mjs': 'exit-before', 'scripts/b.test.mjs': 'exit-after-first', 'scripts/c.test.mjs': 'three' };
  const repo = plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 1, 'scripts/b.test.mjs': 3, 'scripts/c.test.mjs': 3 }, names: {} } });
  const r = await drive(repo, roster);
  assert.equal(r.code, 1);
  assert.match(r.out, /VACUOUS scripts\/a\.test\.mjs: /);
  assert.match(r.out, /FAIL scripts\/b\.test\.mjs: ran 1 test\(s\), below its floor of 3/);
  assert.match(r.out, /vacuous 1/);
  assert.match(r.err, /--- scripts\/a\.test\.mjs \(VACUOUS\) ---/);
});

test('cli: a listed file that is missing, a test file on disk that is not listed, an unreadable manifest and a manifest that does not match the roster each return 1 with a message and run nothing', async () => {
  const roster = { 'scripts/a.test.mjs': 'marker' };
  const marker = path.join(SANDBOX, 'cli-marker.txt');
  process.env.MARKER_FILE = marker; // the child inherits it; removed below
  try {
    const gone = plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 1 }, names: {} } });
    fs.rmSync(path.join(gone, 'scripts', 'a.test.mjs'));
    const m = await drive(gone, roster);
    assert.equal(m.code, 1);
    assert.match(m.err, /1 listed test file\(s\) MISSING — scripts\/a\.test\.mjs/);
    const orphan = plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 1 }, names: {} }, extraOnDisk: ['bin/x.test.js'] });
    const o = await drive(orphan, roster);
    assert.equal(o.code, 1);
    assert.match(o.err, /1 on-disk test\(s\) NOT in the suite — bin\/x\.test\.js/);
    for (const bad of [null, '{ not json']) {
      const b = await drive(plantRepo({ roster, expect: bad }), roster);
      assert.equal(b.code, 1);
      assert.match(b.err, /cannot read scripts\/test-expect\.json/);
    }
    const drift = await drive(plantRepo({ roster, expect: { floors: {}, names: {} } }), roster);
    assert.equal(drift.code, 1);
    assert.match(drift.err, /scripts\/test-expect\.json: scripts\/a\.test\.mjs has no entry/);
    assert.equal(fs.existsSync(marker), false, 'nothing ran');
    const ok = await drive(plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 1 }, names: {} } }), roster);
    assert.equal(ok.code, 0);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'the control: with a matching manifest the file runs');
  } finally {
    delete process.env.MARKER_FILE;
  }
});

test('cli: --names prints the top-level names of one roster file as JSON and returns 0; a file outside the roster and an unknown argument return 64', async () => {
  const roster = { 'scripts/a.test.mjs': 'three' };
  const repo = plantRepo({ roster, expect: { floors: { 'scripts/a.test.mjs': 3 }, names: {} } });
  const ok = await drive(repo, roster, ['--names', 'scripts/a.test.mjs']);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.out), ['alpha', 'beta', 'gamma']);
  assert.match(ok.err, /scripts\/a\.test\.mjs is PASS with 3 top-level name\(s\)/);
  assert.equal((await drive(repo, roster, ['--names', 'scripts/other.test.mjs'])).code, 64);
  assert.equal((await drive(repo, roster, ['--names'])).code, 64);
  const unknown = await drive(repo, roster, ['--wat']);
  assert.equal(unknown.code, 64);
  assert.match(unknown.err, /unknown argument --wat/);
});

test('scripts/test.mjs is wired to the judge: --names on a roster file prints JSON, an unknown argument exits 64', () => {
  const ok = spawnSync(process.execPath, ['scripts/test.mjs', '--names', 'scripts/lib/jsonc.test.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
  assert.equal(ok.status, 0);
  const names = JSON.parse(ok.stdout);
  assert.ok(Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === 'string'));
  const unknown = spawnSync(process.execPath, ['scripts/test.mjs', '--wat'], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
  assert.equal(unknown.status, 64);
});

test('scripts/test.mjs without its judge is a clean message and a red exit, never a link-time stack', () => {
  const lone = path.join(SANDBOX, 'lone-repo');
  fs.mkdirSync(path.join(lone, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'test.mjs'), path.join(lone, 'scripts', 'test.mjs'));
  const r = spawnSync(process.execPath, ['scripts/test.mjs'], { cwd: lone, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test runner: cannot load scripts\/lib\/suite-run\.mjs \(ERR_MODULE_NOT_FOUND\)/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack frame');
});
