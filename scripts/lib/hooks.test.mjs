// CoalHearth — the COMPLETE hermetic hook case-set (hooks-safety.md §7).
// Every case spawns the REAL hook (bin/session-start.js / bin/post-tool-use.js) as a
// child process with a sandboxed TEMP + HOME + cwd, so real session state and the real
// ~/.claude/.coalhearth.json can never leak in (the sandbox sits UNDER the real home,
// so config resolution must STOP AT HOME — asserted in case 7b).
//
// NEVER a real crash: the "death" of a session/worker is SIMULATED by writing the
// journal a PostToolUse hook would have left, then booting the SessionStart hook and
// asserting graceful recovery. Real limit-hits are rare -> all coverage is fake-simulated.
//
// Preferred pattern per case: REAL PostToolUse writes the journal from a fixture ->
// simulate the death (just stop calling it / mutate status) -> REAL SessionStart boots
// -> assert exit0 + silence-except-sanctioned + the state effect.
//
// CORE 6 + EDGE 5 + SELF-UPDATE 3 = 14 cases. Each asserts the three observable surfaces:
//   (1) exit code 0 on every path;
//   (2) stderr silent (Phoenix #13 — SessionStart's context-injection stdout is sanctioned);
//   (3) the expected state effect (journal read/written/quarantined, sweep, or nothing).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const SESSION_START = path.join(REPO, 'bin', 'session-start.js');
const POST_TOOL_USE = path.join(REPO, 'bin', 'post-tool-use.js');
const JOURNAL_REL = path.join('.claude', 'coalhearth', 'session_handoff.json');
const CORRUPT_REL = path.join('.claude', 'coalhearth', 'session_handoff.corrupt.json');

// A fresh sandbox: an isolated HOME and an isolated cwd, both under os.tmpdir().
// HOME/USERPROFILE/TEMP/TMP all redirected so no real state is touched or read.
function sandbox() {
  // realpath the tmpdir sandboxes: on macOS os.tmpdir() is /var -> /private/var
  // (a symlink), and a spawned hook's process.cwd() returns the resolved
  // /private/var form. Resolving here keeps the paths we pass and assert against
  // in the SAME physical form the hook sees, so a lexical path.relative in the
  // hook (modifiedFiles) yields the clean relative path the assertions expect.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-home-')));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cwd-')));
  return { home, cwd };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function run(hook, cwd, home, stdin = '') {
  return spawnSync(process.execPath, [hook], {
    cwd,
    // CLAUDE_CONFIG_DIR emptied: the config loader honors it, so a real machine value
    // would point the "global" config outside the sandbox home (hooks-safety §7).
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    input: stdin,
    encoding: 'utf8',
    timeout: 20000,
  });
}
// Write a sandbox GLOBAL config (home/.claude/.coalhearth.json).
function writeGlobalCfg(home, cfg) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify(cfg), 'utf8');
}
// A fresh sandbox home means the self-update check is "due" on the very first boot;
// cases that assert STRICT SILENCE mute it so their assertion stays about the journal
// path only (the update directive has its own cases 12-14).
function muteUpdate(home) {
  writeGlobalCfg(home, { update: { updateMode: 'off' } });
}
// Write a journal exactly where a PostToolUse hook would leave it.
function writeJournal(cwd, state) {
  const p = path.join(cwd, JOURNAL_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof state === 'string' ? state : JSON.stringify(state), 'utf8');
  return p;
}
function readJournal(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, JOURNAL_REL), 'utf8'));
}
// The three universal assertions every hook path must satisfy.
function assertGraceful(r) {
  assert.strictEqual(r.status, 0, 'hook must exit 0 on every path (Phoenix #4)');
  assert.strictEqual(r.stderr, '', 'hook must be silent on stderr (Phoenix #13)');
  assert.strictEqual(r.signal, null, 'hook must not be killed by a signal');
}

const FIXTURE = {
  sessionId: 's-fixture',
  timestamp: '2026-07-01T00:00:00.000Z',
  status: 'in_progress',
  checklist: [{ task: 'implement widget', status: 'doing' }],
  modifiedFiles: ['lib/widget.js'],
  activePlan: { goal: 'Ship the widget', nextSteps: ['write tests'], constraints: ['no network'] },
};

// ---------------------------------------------------------------------------
// CORE 6
// ---------------------------------------------------------------------------

// (1) MAIN death -> SessionStart injects the recovery markdown.
test('case 1: main death -> SessionStart injects the recovery block', () => {
  const { home, cwd } = sandbox();
  try {
    // REAL PostToolUse writes the journal from a task.md fixture, THEN we simulate the
    // main dying (status stays in_progress — the hook never got to mark it completed).
    fs.writeFileSync(path.join(cwd, 'task.md'), '# Ship the widget\n\n- [ ] write tests\n');
    const ptu = run(POST_TOOL_USE, cwd, home);
    assertGraceful(ptu);
    assert.strictEqual(readJournal(cwd).status, 'in_progress', 'PostToolUse leaves in_progress');

    // Boot: SessionStart must inject the recovery markdown on its sanctioned channel.
    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.match(ss.stdout, /CoalHearth Warm-Resume Recovery/);
    assert.match(ss.stdout, /Ship the widget/);
    assert.strictEqual(readJournal(cwd).status, 'resumed', 'journal marked resumed after inject');
  } finally {
    clean(home, cwd);
  }
});

// (2) WORKER death in a fan-out, main survives -> main journal intact + a flag that
// the workers' partial work is unrecoverable.
test('case 2: worker death in fan-out -> main journal intact + unrecoverable-work flag', () => {
  const { home, cwd } = sandbox();
  try {
    // Main survived and journaled in_progress; a killed worker left a scratch file
    // (it could not run its own finally-cleanup — Incident B).
    writeJournal(cwd, { ...FIXTURE, status: 'in_progress' });
    const scratchDir = path.join(cwd, '.claude', 'coalhearth', 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, 'probe_worker.mjs'), '// dead worker scratch');

    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    // Main journal is intact (recovery fires) and the prompt flags the loss.
    assert.match(ss.stdout, /CoalHearth Warm-Resume Recovery/);
    assert.match(ss.stdout, /unrecoverable/i, 'must flag killed workers\' partial work as lost');
    // The orphan scratch file was swept.
    assert.strictEqual(
      fs.existsSync(path.join(scratchDir, 'probe_worker.mjs')),
      false,
      'orphan worker scratch swept'
    );
  } finally {
    clean(home, cwd);
  }
});

// (3) Journal LOCKED (EBUSY) on save -> retry+backoff then fail-silent (exit 0).
// Simulated by making the output dir a READ-ONLY location: we put a plain FILE where
// the journal file itself must be written, so writeFileSync throws (EISDIR/EEXIST-ish)
// on every retry -> HandoffJournal exhausts retries and returns false; the hook exits 0.
test('case 3: journal locked on save -> retry then fail-silent, exit 0', () => {
  const { home, cwd } = sandbox();
  try {
    const outDir = path.join(cwd, '.claude', 'coalhearth');
    fs.mkdirSync(outDir, { recursive: true });
    // Make session_handoff.json.tmp a DIRECTORY -> writeFileSync(tmp) throws EISDIR on
    // every retry (a deterministic stand-in for EBUSY that works cross-platform).
    fs.mkdirSync(path.join(outDir, 'session_handoff.json.tmp'), { recursive: true });

    const ptu = run(POST_TOOL_USE, cwd, home);
    assertGraceful(ptu); // never crashes even though the save could not complete
    // The blocked tmp path is still a directory (write never succeeded) -> proves the
    // save failed yet the hook stayed graceful.
    assert.ok(fs.statSync(path.join(outDir, 'session_handoff.json.tmp')).isDirectory());
  } finally {
    clean(home, cwd);
  }
});

// (4) Journal CORRUPT (bad JSON) on load -> quarantine + boot clean.
test('case 4: corrupt journal on load -> quarantine + boot clean, exit 0 silent', () => {
  const { home, cwd } = sandbox();
  try {
    muteUpdate(home); // keep the strict-silence assertion about the JOURNAL path only
    writeJournal(cwd, '{ this is not : valid json ]');
    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.strictEqual(ss.stdout, '', 'no recovery block on a corrupt (unreadable) journal');
    assert.strictEqual(fs.existsSync(path.join(cwd, JOURNAL_REL)), false, 'corrupt file removed');
    assert.strictEqual(fs.existsSync(path.join(cwd, CORRUPT_REL)), true, 'quarantined aside');
  } finally {
    clean(home, cwd);
  }
});

// (5) Disk ENOSPC on save -> prune old logs + fail-silent, keep the core json.
// We can't force a real ENOSPC from a spawned hook, so this case is covered at the
// unit level (engine.test.mjs mocks fs.writeFileSync to throw ENOSPC). Here we assert
// the SPAWNED hook stays graceful when the journal folder is pre-populated with prunable
// junk (the realistic pre-ENOSPC state) — the pruning path itself is unit-tested.
test('case 5: ENOSPC-shaped disk pressure -> hook graceful, core json survives (prune is unit-tested)', () => {
  const { home, cwd } = sandbox();
  try {
    const outDir = path.join(cwd, '.claude', 'coalhearth');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'error.log'), 'old junk\n');
    fs.writeFileSync(path.join(outDir, 'old-diff.txt'), 'stale diff\n');

    const ptu = run(POST_TOOL_USE, cwd, home);
    assertGraceful(ptu);
    assert.ok(fs.existsSync(path.join(cwd, JOURNAL_REL)), 'core journal written');
  } finally {
    clean(home, cwd);
  }
});

// (6) killed-worker ORPHAN scratch files -> a SCOPED resume-time sweep
// (staging/scratch dirs ONLY, resolve-and-contain, NEVER a blind delete).
test('case 6: orphan scratch files -> scoped sweep, real files outside scope untouched', () => {
  const { home, cwd } = sandbox();
  try {
    writeJournal(cwd, FIXTURE);
    // In-scope scratch = a CoalHearth-OWNED dir (must be swept):
    const scratchDir = path.join(cwd, '.claude', 'coalhearth', 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, '__probe_a.mjs'), 'x');
    fs.writeFileSync(path.join(scratchDir, 'probe_b.js'), 'x');
    // NOT a scratch pattern (must survive): a real file in the owned dir.
    fs.writeFileSync(path.join(scratchDir, 'build.mjs'), 'real source');
    // USER TERRITORY (must survive): a probe_*-named file the user wrote in their own
    // scripts/ is NEVER swept (work-review MED #2 — the Incident B blind-delete hazard).
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'scripts', 'probe_user.mjs'), 'user file');
    // Out-of-scope dir entirely (must survive): a probe-named file NOT in an allow-listed dir.
    fs.writeFileSync(path.join(cwd, 'probe_root.mjs'), 'not in a scratch dir');

    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.strictEqual(fs.existsSync(path.join(scratchDir, '__probe_a.mjs')), false, 'owned scratch swept');
    assert.strictEqual(fs.existsSync(path.join(scratchDir, 'probe_b.js')), false, 'owned scratch swept');
    assert.strictEqual(fs.existsSync(path.join(scratchDir, 'build.mjs')), true, 'real file in owned dir untouched');
    assert.strictEqual(fs.existsSync(path.join(cwd, 'scripts', 'probe_user.mjs')), true, "the user's own scripts/probe is NEVER swept");
    assert.strictEqual(fs.existsSync(path.join(cwd, 'probe_root.mjs')), true, 'out-of-scope file untouched');
  } finally {
    clean(home, cwd);
  }
});

// ---------------------------------------------------------------------------
// EDGE 5
// ---------------------------------------------------------------------------

// (7) STALE journal (<=1 tool-use behind) -> resume advises verify-vs-git, no blind trust.
test('case 7a: stale journal -> recovery advises verify-vs-git, never blind-trust', () => {
  const { home, cwd } = sandbox();
  try {
    // A journal that is one edit behind reality (it lists a file since reverted).
    writeJournal(cwd, { ...FIXTURE, modifiedFiles: ['lib/widget.js', 'lib/gone.js'] });
    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.match(ss.stdout, /Do not blind-trust this snapshot/i);
    assert.match(ss.stdout, /git status|git diff|against the working tree/i);
  } finally {
    clean(home, cwd);
  }
});

// (7b) sandbox-isolation invariant: a .coalhearth.json placed ABOVE home must never be
// read by a cwd nested under home (config resolution stops at home).
test('case 7b: config resolution stops at home (no walk above the sandbox home)', () => {
  const { home, cwd } = sandbox();
  const aboveHome = path.dirname(home);
  const marker = path.join(aboveHome, `.coalhearth-leak-${Date.now()}.json`);
  const nested = fs.mkdtempSync(path.join(home, 'nested-'));
  try {
    muteUpdate(home); // keep the strict-silence assertion about config isolation only
    // If the walk escaped home it would find THIS bogus config; a clean run proves it didn't.
    fs.writeFileSync(marker, '{"budgets":{"maxTokens":-999}}');
    const ss = run(SESSION_START, nested, home);
    assertGraceful(ss);
    assert.strictEqual(ss.stdout, '', 'no journal + no leaked config -> silent clean boot');
  } finally {
    fs.rmSync(marker, { force: true });
    clean(home, cwd);
  }
});

// (8) /compact (context-loss not death) -> journal survives + re-injects.
// /compact does NOT kill the process or change the journal on disk; a fresh
// SessionStart still finds the in_progress journal and re-injects it.
test('case 8: /compact context-loss -> journal survives, SessionStart re-injects', () => {
  const { home, cwd } = sandbox();
  try {
    writeJournal(cwd, FIXTURE);
    // First boot injects and marks resumed.
    const first = run(SESSION_START, cwd, home);
    assertGraceful(first);
    assert.match(first.stdout, /CoalHearth Warm-Resume Recovery/);
    assert.strictEqual(readJournal(cwd).status, 'resumed');

    // Simulate work continuing after /compact: a PostToolUse re-writes an in_progress
    // journal (the recovery core keeps journaling), so the NEXT boot re-injects.
    fs.writeFileSync(path.join(cwd, 'task.md'), '# Ship the widget\n\n- [ ] finish\n');
    const ptu = run(POST_TOOL_USE, cwd, home);
    assertGraceful(ptu);
    assert.strictEqual(readJournal(cwd).status, 'in_progress', 'journal survives /compact, keeps recording');

    const second = run(SESSION_START, cwd, home);
    assertGraceful(second);
    assert.match(second.stdout, /CoalHearth Warm-Resume Recovery/, 're-injects after /compact');
  } finally {
    clean(home, cwd);
  }
});

// (9) HALF-APPLIED edits -> the file the dying session was mid-edit on is journaled
// (from the tool payload the hook OBSERVED — no git spawn, Phoenix #5) + resume
// advises reconciling against the working tree, never blind-trust.
test('case 9: half-applied edits -> payload-derived modifiedFiles + reconcile advice', () => {
  const { home, cwd } = sandbox();
  try {
    // The session died right after a Write touched half.js — the edit may be
    // half-applied on disk. The hook saw the Write payload and journals the path.
    fs.writeFileSync(path.join(cwd, 'half.js'), 'half applied\n');
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'half.js') },
    });
    const ptu = run(POST_TOOL_USE, cwd, home, payload);
    assertGraceful(ptu);
    const j = readJournal(cwd);
    assert.ok(j.modifiedFiles.includes('half.js'), 'payload-observed half-applied edit captured');

    // Boot: recovery advises reconcile against the working tree.
    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.match(ss.stdout, /VERIFY against git|verify it against the actual repo state|working tree/i);
    assert.match(ss.stdout, /half\.js/, 'the half-applied file is listed for reconciliation');
  } finally {
    clean(home, cwd);
  }
});

// (10) NO-USER (headless/cron) -> report-only, no interactive resume-offer.
// The SessionStart hook only PRINTS to the sanctioned channel; it never asks a
// question / waits for input -> it is safe by construction in a headless run.
test('case 10: no-user headless -> report-only, no prompt/wait, exit 0', () => {
  const { home, cwd } = sandbox();
  try {
    writeJournal(cwd, FIXTURE);
    // Run with stdin CLOSED (empty input) — a headless/cron invocation. If the hook
    // ever blocked on interactive input it would hang and hit the spawn timeout.
    const ss = run(SESSION_START, cwd, home, '');
    assertGraceful(ss);
    // It still emits the report (context injection), but purely one-way.
    assert.match(ss.stdout, /CoalHearth Warm-Resume Recovery/);
    // No "y/n?", "[Enter]", or interactive-offer language in the output.
    assert.doesNotMatch(ss.stdout, /\(y\/n\)|press enter|type resume|\[Y\/n\]/i);
  } finally {
    clean(home, cwd);
  }
});

// (11) ORPHAN worktree -> scoped stale-worktree sweep.
test('case 11: orphan worktree -> scoped sweep of CoalHearth-owned stale worktrees', () => {
  const { home, cwd } = sandbox();
  try {
    writeJournal(cwd, FIXTURE);
    const wtBase = path.join(cwd, '.claude', 'coalhearth', 'worktrees');
    const stale = path.join(wtBase, 'ch-worker-dead');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'leftover.txt'), 'orphan worktree content');
    // A NON-CoalHearth-named dir in the same base must survive (never a blind wipe).
    const keep = path.join(wtBase, 'user-owned');
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, 'keep.txt'), 'not ours');

    const ss = run(SESSION_START, cwd, home);
    assertGraceful(ss);
    assert.strictEqual(fs.existsSync(stale), false, 'stale ch-worker worktree swept');
    assert.strictEqual(fs.existsSync(keep), true, 'unowned worktree dir untouched');
    assert.match(ss.stdout, /unrecoverable/i, 'flags the killed worker\'s lost work');
  } finally {
    clean(home, cwd);
  }
});

// ---------------------------------------------------------------------------
// SELF-UPDATE 3 (kind-1, series-standard) — the SessionStart hook only SCHEDULES
// via a throttled crash-safe stamp under the sandbox home (~/.claude/
// .coalhearth-update-check); the online check is the agent's /coalhearth:update.
// ---------------------------------------------------------------------------

// (12) stamp-throttle: the 1st boot (first ever) nudges + stamps; the 2nd is silent.
test('case 12: self-update stamp-throttle -> 1st SessionStart nudges + stamps, 2nd silent', () => {
  const { home, cwd } = sandbox();
  try {
    const r1 = run(SESSION_START, cwd, home);
    assertGraceful(r1);
    assert.match(r1.stdout, /self-update due/, 'run #1 (first ever) is due -> nudges');
    assert.ok(fs.existsSync(path.join(home, '.claude', '.coalhearth-update-check')), 'crash-safe stamp written under home/.claude');
    const r2 = run(SESSION_START, cwd, home);
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'run #2 inside the window -> throttled silent');
  } finally {
    clean(home, cwd);
  }
});

// (13) update.updateMode:off -> fully silent, and nothing is even scheduled.
test('case 13: update.updateMode:off -> silent, no stamp scheduled', () => {
  const { home, cwd } = sandbox();
  try {
    writeGlobalCfg(home, { update: { updateMode: 'off' } });
    const r = run(SESSION_START, cwd, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'updateMode:off -> no update directive');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalhearth-update-check')), false, 'off never writes a stamp');
  } finally {
    clean(home, cwd);
  }
});

// (14) updateCheckDays:0 is CLAMPED on read -> the 2nd boot is throttled, not re-nagged.
// Taken literally, 0 would make EVERY session "due" (now - last >= 0 always); the clamp
// (out-of-range -> 14) restores the throttle. Mirrors CoalBoard's #3 regression test.
test('case 14: updateCheckDays:0 clamped -> 2nd SessionStart throttled, not re-nagged', () => {
  const { home, cwd } = sandbox();
  try {
    writeGlobalCfg(home, { update: { updateMode: 'auto', updateCheckDays: 0 } });
    const r1 = run(SESSION_START, cwd, home);
    const r2 = run(SESSION_START, cwd, home);
    assertGraceful(r1);
    assertGraceful(r2);
    assert.match(r1.stdout, /self-update due/, 'run #1 (first ever) is due -> nudges + stamps');
    assert.strictEqual(r2.stdout, '', 'run #2 must be throttled: updateCheckDays:0 clamps to 14, the window holds');
  } finally {
    clean(home, cwd);
  }
});
