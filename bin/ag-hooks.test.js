// Hermetic spawn tests for the non-Claude-Code adapters (hooks-safety.md §7): spawn the
// REAL bin/ag-pre-invocation.js / bin/ag-post-tool-use.js as child processes with
// platform-shaped fixture stdin (both snake_case and camelCase variants), a sandboxed
// TEMP/HOME/TMPDIR + cwd so real state can never leak, and assert the three surfaces:
// exit 0 on every path; stdout silent EXCEPT the platform's sanctioned channel;
// the expected state effect (journal written / recovery emitted / once-per-session guard).
// The default argv here is 'PreInvocation' (the AG branch) — the original AG tests double
// as the regression suite proving the platform-mode dispatch left AG byte-identical; the
// v1.4.0 'SessionStart' (Gemini) + 'FileCopy' (Copilot CLI/Devin CLI/Kiro/Augment) modes
// have their own section at the end.
// Run: node --test bin/ag-hooks.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRE = path.join(__dirname, 'ag-pre-invocation.js');
const PTU = path.join(__dirname, 'ag-post-tool-use.js');
const JOURNAL_REL = path.join('.claude', 'coalhearth', 'session_handoff.json');

// realpath the tmpdir sandbox (macOS /var -> /private/var symlink) so a spawned hook's
// process.cwd() and the payload paths share one physical form (matches the CC tests).
function mk() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ag-')));
}

// TMPDIR/TEMP/TMP -> the sandbox `home`, so the once-per-session marker os.tmpdir() writes
// lands in an isolated throwaway dir (never the real tmp, never a cross-test collision).
// `mode` (appended, optional) = the platform-dispatch argv; default 'PreInvocation' keeps
// every pre-existing call on the AG branch.
function run(script, cwd, home, stdin, extraEnv, mode) {
  return spawnSync(process.execPath, [script, mode || 'PreInvocation'], {
    cwd,
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      TEMP: home, TMP: home, TMPDIR: home,
      CLAUDE_CONFIG_DIR: '',
      ...(extraEnv || {}),
    },
    input: stdin || '',
    encoding: 'utf8',
    timeout: 20000,
  });
}

function writeJournal(cwd, state) {
  const p = path.join(cwd, JOURNAL_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof state === 'string' ? state : JSON.stringify(state), 'utf8');
  return p;
}
function readJournal(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, JOURNAL_REL), 'utf8'));
}
// Markers now live in a private per-tool subdir os.tmpdir()/coalhearth (created 0o700),
// each named ag-resume-<hash>.marker (CodeQL js/insecure-temporary-file fix 2026-07-14).
function markerCount(home) {
  try {
    return fs.readdirSync(path.join(home, 'coalhearth')).filter((n) => /^ag-resume-.*\.marker$/.test(n)).length;
  } catch {
    return 0; // subdir absent -> zero markers (e.g. the no-key path never creates it)
  }
}
// Replicate the adapter's djb2 so a test can pre-plant the EXACT marker path (EEXIST case).
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
  return h.toString(36);
}
// The sanctioned AG channel: stdout must be EMPTY or exactly one additionalContext JSON.
function parseInject(stdout) {
  if (stdout === '') return null;
  const obj = JSON.parse(stdout.trim()); // throws if stdout is not the sanctioned JSON -> test fails
  assert.ok(Object.prototype.hasOwnProperty.call(obj, 'additionalContext'), 'the only sanctioned emit is additionalContext JSON');
  return obj.additionalContext;
}

const IN_PROGRESS = {
  sessionId: 's-fixture',
  timestamp: '2026-07-01T00:00:00.000Z',
  status: 'in_progress',
  checklist: [{ task: 'implement widget', status: 'doing' }],
  modifiedFiles: ['lib/widget.js'],
  activePlan: { goal: 'Ship the widget', nextSteps: ['write tests'], constraints: ['no network'] },
};
// No `cwd` field: the hooks honor payload.cwd (chdir) when present, so the plain fixture
// leaves the spawn cwd in charge; the cwd-mismatch regression tests set it explicitly.
const SID = JSON.stringify({ session_id: 'ag-session-1' });

// =====================================================================================
// ag-pre-invocation.js — the SessionStart replacement (PreInvocation, once per session)
// =====================================================================================

test('pre: no journal + a session id -> exit 0, silent, but the once-per-session marker is written', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PRE, cwd, home, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'nothing to resume -> no additionalContext');
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(markerCount(home), 1, 'the once-per-session marker is written even when nothing resumes');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre: in_progress journal -> emits the recovery block as additionalContext JSON, journal marked resumed', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    const r = run(PRE, cwd, home, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const ctx = parseInject(r.stdout);
    assert.match(ctx, /CoalHearth Warm-Resume Recovery/);
    assert.match(ctx, /Ship the widget/);
    // CC-adapter parity (rot-canary HIGH 2026-07-13): marking `resumed` is what keeps the
    // dead session's modifiedFiles/inFlightAgents from accumulating into THIS session's
    // journal (recordStep's sameSession check is status-based).
    assert.strictEqual(readJournal(cwd).status, 'resumed', 'journal marked resumed (contamination guard)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre: once-per-session guard -> 1st PreInvocation emits, 2nd (same session) silent, 3rd (new session) re-emits', () => {
  const cwd = mk();
  const home = mk(); // shared TMPDIR across the three runs -> the marker persists between them
  try {
    writeJournal(cwd, IN_PROGRESS);
    const r1 = run(PRE, cwd, home, JSON.stringify({ session_id: 'sess-A' }));
    assert.strictEqual(r1.status, 0);
    assert.match(parseInject(r1.stdout), /Warm-Resume Recovery/, 'first PreInvocation of the session injects');

    const r2 = run(PRE, cwd, home, JSON.stringify({ session_id: 'sess-A' }));
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.stdout, '', 'same session, later PreInvocation -> guarded silent (no re-inject every turn)');

    // sess-A worked (PostToolUse re-dirtied the journal to in_progress) then died mid-task;
    // sess-B boots -> the crash chain re-injects for the NEW session.
    writeJournal(cwd, IN_PROGRESS);
    const r3 = run(PRE, cwd, home, JSON.stringify({ session_id: 'sess-B' }));
    assert.strictEqual(r3.status, 0);
    assert.match(parseInject(r3.stdout), /Warm-Resume Recovery/, 'a NEW session id re-injects (per-session, not per-tmp)');
    assert.strictEqual(markerCount(home), 2, 'one marker per distinct session');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre: accepts camelCase sessionId and the transcript_path fallback', () => {
  const cwd = mk();
  const home = mk();
  const cwd2 = mk();
  const home2 = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    const camel = run(PRE, cwd, home, JSON.stringify({ sessionId: 'camel-1' }));
    assert.strictEqual(camel.status, 0);
    assert.match(parseInject(camel.stdout), /Warm-Resume Recovery/, 'camelCase sessionId is honored');

    // No session_id at all -> falls back to transcript_path as the per-session key.
    writeJournal(cwd2, IN_PROGRESS);
    const tp = run(PRE, cwd2, home2, JSON.stringify({ transcript_path: '/tmp/t/abc.jsonl' }));
    assert.strictEqual(tp.status, 0);
    assert.match(parseInject(tp.stdout), /Warm-Resume Recovery/, 'transcript_path is the fallback key');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd2, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
  }
});

test('pre: NO per-session key -> skip silently (cannot dedupe once-per-session), exit 0, no marker', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS); // resumable, but no key to guard on
    const r = run(PRE, cwd, home, JSON.stringify({ cwd: '/x', timestamp: 'now' }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'no key -> no inject (avoid re-inject-every-turn)');
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(markerCount(home), 0, 'no key -> no marker');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre: marker cannot persist (tmp is a FILE) -> still emits, block carries the honest "may repeat" note', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    // Point TMPDIR at a FILE (not a dir): os.tmpdir() returns it, so mkdirSync(<file>/coalhearth)
    // throws ENOTDIR. (A merely-nonexistent TMPDIR would no longer fail — the recursive mkdir
    // would just create it.) The non-EEXIST failure -> markerWritten=false -> emit anyway.
    const notADir = path.join(home, 'tmp-is-a-file');
    fs.writeFileSync(notADir, 'x', 'utf8');
    const r = run(PRE, cwd, home, SID, { TMPDIR: notADir, TEMP: notADir, TMP: notADir });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const ctx = parseInject(r.stdout);
    assert.match(ctx, /Warm-Resume Recovery/);
    assert.match(ctx.toLowerCase(), /may repeat/, 'honest note when the guard marker could not persist');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Security (CodeQL js/insecure-temporary-file): the marker is created with the wx flag
// (O_CREAT|O_EXCL), so a PRE-EXISTING marker path (a prior turn, or an attacker's planted
// file/symlink) makes the create fail EEXIST -> the hook treats it as "already ran" and
// stays silent. Proves the atomic latch never writes through / past an existing path.
test('pre: a pre-existing marker path -> EEXIST silent skip (no re-inject even with a resumable journal)', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS); // resumable: an un-guarded run WOULD emit
    const markerDir = path.join(home, 'coalhearth');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, `ag-resume-${hashKey('ag-session-1')}.marker`), 'planted', 'utf8'); // SID's session_id
    const r = run(PRE, cwd, home, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'pre-existing marker -> EEXIST -> no emit');
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Security (dir-symlink residual): mkdirSync(recursive) FOLLOWS a pre-planted symlink at the
// marker subdir (silently succeeding, 0o700 unapplied), so the wx marker would write THROUGH it.
// CH's divergence (vs CF/CM's fail-closed skip): reject the symlink dir -> markerWritten=false ->
// STILL emit the recovery block (worth repeating) with the honest may-repeat note; the marker is
// NOT written into the attacker dir.
test('pre: a pre-planted SYMLINK at the marker subdir -> no marker in the target, block still emits with the may-repeat note (dir-symlink close)', (t) => {
  const cwd = mk();
  const home = mk();
  const target = mk(); // attacker-controlled dir the planted symlink points at
  try {
    writeJournal(cwd, IN_PROGRESS); // resumable: an un-guarded run WOULD emit AND drop a marker
    const markerDir = path.join(home, 'coalhearth'); // os.tmpdir()/coalhearth (TMPDIR -> home)
    try {
      fs.symlinkSync(target, markerDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction unavailable (needs privilege) — cannot exercise the dir-symlink guard');
      return; // t.skip does not stop the body; return so the case is skipped, never a vacuous pass
    }
    const r = run(PRE, cwd, home, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const ctx = parseInject(r.stdout);
    assert.match(ctx, /Warm-Resume Recovery/, 'CH still emits its recovery block (emit-with-note divergence)');
    assert.match(ctx.toLowerCase(), /may repeat/, 'honest note when the guard marker could not persist (symlink dir refused)');
    assert.strictEqual(fs.readdirSync(target).length, 0, 'no marker written THROUGH the symlink into the attacker dir');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('pre: recovery.autoInjectPrompt:false -> detect+sweep silent, no additionalContext, still marks resumed', () => {
  const cwd = mk();
  const home = mk();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), '{"recovery":{"autoInjectPrompt":false}}', 'utf8');
    writeJournal(cwd, IN_PROGRESS);
    const r = run(PRE, cwd, home, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'autoInjectPrompt:false suppresses the block');
    assert.strictEqual(r.stderr, '');
    // CC-adapter parity: the flag suppresses the INJECTION only; marking resumed must
    // still happen or the cross-session contamination returns for these users.
    assert.strictEqual(readJournal(cwd).status, 'resumed', 'still marked resumed (contamination guard is not flag-gated)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Regression (review-lane HIGH 2026-07-14, spawn cwd != workspace): AG's hook spawn cwd
// is NOT guaranteed to be the workspace — the locked spec provides payload.cwd for
// exactly this. Both adapters must anchor EVERY cwd-dependent path (config walk, journal
// root, resume read/mark, sweep) at payload.cwd, or CH silently journals/resumes in the
// wrong dir and the whole product no-ops on AG.
test('regression pre: spawn cwd != payload.cwd -> resume reads + marks the PAYLOAD workspace, spawn dir untouched', () => {
  const spawnDir = mk(); // where AG happens to spawn the hook (NOT the workspace)
  const workspace = mk(); // the real workspace the payload names
  const home = mk();
  try {
    writeJournal(workspace, IN_PROGRESS);
    const r = run(PRE, spawnDir, home, JSON.stringify({ session_id: 'sess-cwd', cwd: workspace }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.match(parseInject(r.stdout), /Warm-Resume Recovery/, 'the workspace journal was found via payload.cwd');
    assert.strictEqual(readJournal(workspace).status, 'resumed', 'mark-resumed landed at the workspace');
    assert.strictEqual(fs.existsSync(path.join(spawnDir, '.claude')), false, 'nothing created at the spawn dir');
  } finally {
    fs.rmSync(spawnDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('regression ptu: spawn cwd != payload.cwd -> journal lands at the PAYLOAD workspace, spawn dir untouched', () => {
  const spawnDir = mk();
  const workspace = mk();
  const home = mk();
  try {
    const r = run(PTU, spawnDir, home, JSON.stringify({
      tool_name: 'write_to_file',
      tool_input: { file_path: path.join(workspace, 'src', 'w.js') },
      cwd: workspace,
    }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const j = readJournal(workspace); // throws if the journal is not at the workspace -> test fails
    assert.deepStrictEqual(j.modifiedFiles, [path.join('src', 'w.js')], 'path stored relative to the WORKSPACE');
    assert.strictEqual(fs.existsSync(path.join(spawnDir, '.claude')), false, 'nothing created at the spawn dir');
  } finally {
    fs.rmSync(spawnDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Regression (rot-canary HIGH 2026-07-13, AG cross-session journal contamination):
// recordStep's sameSession check is status-based (`prior.status === 'in_progress'`), so a
// dead session A's journal left UNMARKED would be treated as session B's own accumulator —
// B's first tool call would inherit A's modifiedFiles + inFlightAgents, growing unbounded
// across crash chains. The fix: ag-pre-invocation marks `resumed` (CC parity). This test
// drives the REAL two-hook sequence a new AG session runs: PreInvocation then PostToolUse.
test('regression: dead session A state is NOT inherited by session B first tool call (crash-chain contamination)', () => {
  const cwd = mk();
  const home = mk();
  try {
    // Session A died mid-work: in_progress journal carrying A's accumulated state.
    writeJournal(cwd, {
      ...IN_PROGRESS,
      modifiedFiles: ['a-session-file.js'],
      inFlightAgents: [{ description: 'A dead sub', subagentType: 'scanner', spawnedAt: '2026-07-01T00:00:00.000Z' }],
    });
    // Session B boots: its first PreInvocation recovers A (emits the block, marks resumed).
    const pre = run(PRE, cwd, home, JSON.stringify({ session_id: 'sess-B' }));
    assert.strictEqual(pre.status, 0);
    const ctx = parseInject(pre.stdout);
    assert.match(ctx, /a-session-file\.js/, 'B is shown A\'s recovery state');
    assert.match(ctx, /A dead sub/, 'B is shown A\'s in-flight sub');
    // B's first tool call journals FRESH lists — A's state must NOT leak in.
    const ptu = run(PTU, cwd, home, JSON.stringify({
      tool_name: 'write_to_file',
      tool_input: { file_path: path.join(cwd, 'b-session-file.js') },
    }));
    assert.strictEqual(ptu.status, 0);
    const j = readJournal(cwd);
    assert.strictEqual(j.status, 'in_progress', 'B\'s own journal is live');
    assert.deepStrictEqual(j.modifiedFiles, ['b-session-file.js'], 'A\'s modifiedFiles NOT inherited');
    assert.deepStrictEqual(j.inFlightAgents, [], 'A\'s inFlightAgents NOT inherited');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre: garbage stdin and a corrupt journal -> exit 0 silent, corrupt journal quarantined', () => {
  const garbageCwd = mk();
  const home = mk();
  const cwd = mk();
  const home2 = mk();
  try {
    const g = run(PRE, garbageCwd, home, 'not json at all \0\x01');
    assert.strictEqual(g.status, 0);
    assert.strictEqual(g.stdout, '', 'garbage stdin -> no key -> silent');
    assert.strictEqual(g.stderr, '');

    writeJournal(cwd, '{ this is : not valid json ]');
    const r = run(PRE, cwd, home2, SID);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'corrupt journal -> nothing to inject');
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(fs.existsSync(path.join(cwd, JOURNAL_REL)), false, 'corrupt journal removed');
    assert.strictEqual(fs.existsSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.corrupt.json')), true, 'quarantined aside');
  } finally {
    fs.rmSync(garbageCwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
  }
});

// =====================================================================================
// ag-post-tool-use.js — the handoff journal step (AG payload normalized to CC shape)
// =====================================================================================

test('ptu: AG write_to_file (snake_case) -> file recorded in modifiedFiles, journal written, exit 0 silent', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({
      tool_name: 'write_to_file',
      tool_input: { file_path: path.join(cwd, 'src', 'a.js'), content: 'x' },
    }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'happy path is silent (no low-headroom nudge)');
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, [path.join('src', 'a.js')]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu: camelCase toolCall variant + alternate path arg (TargetFile) is normalized', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({
      toolCall: { name: 'edit_file', args: { TargetFile: path.join(cwd, 'b.js') }, result: { ok: true } },
    }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, ['b.js'], 'toolCall.args + TargetFile probed');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu: unknown/non-file AG tool (run_command) -> journal still saved, modifiedFiles empty (no-op contribution)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({ tool_name: 'run_command', tool_input: { command: 'ls -la' } }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const j = readJournal(cwd);
    assert.strictEqual(j.status, 'in_progress', 'session state still journaled');
    assert.deepStrictEqual(j.modifiedFiles, [], 'a non-file tool contributes no path');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu: AG spawn candidate -> recorded in inFlightAgents (Incident E)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({
      tool_name: 'spawn_subagent',
      tool_input: { description: 'Scan module X', subagent_type: 'scanner' },
      tool_response: { output_file: '/tmp/tasks/x.out' },
    }));
    assert.strictEqual(r.status, 0);
    const agents = readJournal(cwd).inFlightAgents;
    assert.strictEqual(agents.length, 1, 'the spawn is recorded');
    assert.strictEqual(agents[0].description, 'Scan module X');
    assert.strictEqual(agents[0].subagentType, 'scanner');
    assert.strictEqual(agents[0].outputPath, '/tmp/tasks/x.out');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu: CC-vocab payload passes through unchanged on the AG adapter (defensive)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'cc.js') } }));
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, ['cc.js'], 'a CC-shaped payload still records');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// RETIRED (H7): the AG-side advisory nudge is gone (the guardrail was structurally
// unreachable). A leftover budgets config + a payload that WOULD have tripped it now produces
// NO additionalContext — the post hook is journal-only. AG-side "removed path is gone" proof.
test('ptu: retired budget nudge -> NO additionalContext even with a budgets config, journal still records', () => {
  const cwd = mk();
  const home = mk();
  try {
    fs.writeFileSync(path.join(cwd, '.coalhearth.json'), JSON.stringify({ budgets: { maxTokens: 100, warningTokenPercentage: 0.15 } }));
    const r = run(PTU, cwd, home, JSON.stringify({ tool_name: 'run_command', tool_input: { command: 'x'.repeat(400) } }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(r.stdout, '', 'no nudge — the guardrail is retired (the AG post hook emits nothing)');
    assert.strictEqual(readJournal(cwd).status, 'in_progress', 'the journal step still ran');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu: garbage stdin -> exit 0 silent, journal still written with empty defaults', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, 'not json \0\x01');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// =====================================================================================
// v1.4.0 config-only platform modes — argv 'SessionStart' (Gemini CLI: nested
// hookSpecificOutput emit, NO marker) and 'FileCopy' (Copilot CLI / Devin CLI / Kiro /
// Augment: plain CC stdout, NO marker). The AG tests above (argv 'PreInvocation') are
// the regression suite proving the dispatch left the default AG branch untouched.
// =====================================================================================

test('pre gemini: in_progress journal -> NESTED hookSpecificOutput emit, marked resumed, NO tmp marker', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    const r = run(PRE, cwd, home, SID, null, 'SessionStart');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const obj = JSON.parse(r.stdout.trim());
    assert.match(obj.hookSpecificOutput.additionalContext, /Warm-Resume Recovery/, 'the block rides Gemini\'s nested field');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(obj, 'additionalContext'), false, 'no flat AG key — Gemini silently drops it');
    assert.strictEqual(readJournal(cwd).status, 'resumed', 'contamination guard holds on Gemini too');
    assert.strictEqual(markerCount(home), 0, 'a genuine per-session SessionStart needs no marker');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre gemini: NO session key -> still resumes (native one-shot event needs no dedupe key, unlike AG)', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    const r = run(PRE, cwd, home, JSON.stringify({ cwd }), null, 'SessionStart'); // no session_id/transcript_path
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const obj = JSON.parse(r.stdout.trim());
    assert.match(obj.hookSpecificOutput.additionalContext, /Warm-Resume Recovery/, 'keyless payload must NOT block a named-mode resume');
    assert.strictEqual(markerCount(home), 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre gemini: nothing to resume -> exit 0 silent, no marker', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PRE, cwd, home, SID, null, 'SessionStart');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'no aborted journal -> nothing injected');
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(markerCount(home), 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre filecopy: in_progress journal -> PLAIN stdout block (CC parity, not JSON), marked resumed, no marker', () => {
  const cwd = mk();
  const home = mk();
  try {
    writeJournal(cwd, IN_PROGRESS);
    const r = run(PRE, cwd, home, SID, null, 'FileCopy');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.match(r.stdout, /Warm-Resume Recovery/, 'the block rides plain stdout (the CC-shaped platforms\' channel)');
    assert.ok(!r.stdout.trimStart().startsWith('{'), 'plain markdown, never a JSON wrapper');
    assert.strictEqual(readJournal(cwd).status, 'resumed');
    assert.strictEqual(markerCount(home), 0, 'a real session-start event needs no marker');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu gemini (AfterTool): write_file + replace journaled via the shared normalizer, journal-only (no emit)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r1 = run(PTU, cwd, home, JSON.stringify({
      tool_name: 'write_file', // Gemini's write tool
      tool_input: { file_path: path.join(cwd, 'src', 'g.js'), content: 'x'.repeat(400) },
    }), null, 'AfterTool');
    assert.strictEqual(r1.status, 0);
    assert.strictEqual(r1.stdout, '', 'the post hook is journal-only (the advisory nudge was retired)');
    assert.strictEqual(r1.stderr, '');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, [path.join('src', 'g.js')], 'write_file mapped to a journal step');

    const r2 = run(PTU, cwd, home, JSON.stringify({
      tool_name: 'replace', // Gemini's edit tool
      tool_input: { file_path: path.join(cwd, 'h.js'), old_string: 'a', new_string: 'b'.repeat(400) },
    }), null, 'AfterTool');
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.stdout, '', 'journal-only on the edit-tool path too');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, [path.join('src', 'g.js'), 'h.js'], 'replace accumulates onto the same session');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ptu filecopy: camelCase toolName + toolInput (Copilot-CLI shape) -> recorded', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(PTU, cwd, home, JSON.stringify({
      toolName: 'Write',
      toolInput: { file_path: path.join(cwd, 'c.js') },
    }), null, 'FileCopy');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'happy path silent');
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual(readJournal(cwd).modifiedFiles, ['c.js'], 'the camelCase toolInput probe is live');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
