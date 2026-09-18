// Hermetic spawn test for the PostToolUse hook (hooks-safety.md §7).
// Spawns the real hook as a child process with a sandboxed TEMP/HOME + cwd so real
// session state and the real ~/.claude/.coalhearth.json can never affect the test.
// Run: node --test bin/post-tool-use.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'post-tool-use.js');

function mk() {
  // realpath the tmpdir sandbox: on macOS os.tmpdir() (/var) is a symlink to
  // /private/var, and the spawned hook's process.cwd() resolves to the
  // /private/var form. Resolving here keeps the payload path and the hook's cwd
  // in the same physical form so the hook's lexical path.relative yields the
  // clean relative modifiedFiles entry the assertions expect (no-op off macOS).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ptu-')));
}

// A project cwd for containedOutputDir's auto-anchor walk (hooks-safety.md §8):
// every test below spawns the hook with cwd = this, and needs it to resolve as a
// real project root rather than fail closed. Plain mk() (used for `home` / any
// non-cwd sandbox) deliberately stays marker-free — it must never itself resolve
// as a project.
function mkProject() {
  const dir = mk();
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function run(cwd, home, stdin) {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env,
    input: stdin || '',
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('happy path: writes session_handoff.json, exit 0, no stderr', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const journalPath = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
    assert.ok(fs.existsSync(journalPath), 'journal must be written on the happy path');
    const data = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(data.status, 'in_progress');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('task.md checklist is parsed into the journal', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    fs.writeFileSync(
      path.join(cwd, 'task.md'),
      '# Ship the widget\n\n- [x] design\n- [ ] implement\n- [ ] test\n'
    );
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    const data = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')
    );
    assert.strictEqual(data.activePlan.goal, 'Ship the widget');
    assert.strictEqual(data.checklist.length, 3);
    assert.deepStrictEqual(data.activePlan.nextSteps, ['implement', 'test']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no task.md / no tool payload -> still succeeds with empty defaults (no-external-assumption)', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    const data = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')
    );
    assert.deepStrictEqual(data.modifiedFiles, []);
    assert.deepStrictEqual(data.checklist, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// RETIRED (H7): the advisory budget nudge is gone (it was structurally unreachable — a fresh
// per-call tracker never accumulated). Even a tiny `budgets` config (which USED to force the
// nudge here) must now produce NO stdout. The CC-side "removed path is gone" proof; the
// recovery core still journals the step. RED-PROOF: restore the nudge in bin/post-tool-use.js
// and this goes red.
test('retired budget nudge: a leftover budgets config produces NO stdout, journal still records', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    fs.writeFileSync(
      path.join(cwd, '.coalhearth.json'),
      JSON.stringify({ budgets: { maxTokens: 100, warningTokenPercentage: 0.15 } }) // a retired key, loaded-but-ignored
    );
    const r = run(cwd, home, 'x'.repeat(400)); // a payload that WOULD have tripped the old nudge
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'no budget nudge — the guardrail is retired');
    assert.strictEqual(r.stderr, '');
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8'));
    assert.strictEqual(j.status, 'in_progress', 'the recovery core still records the step');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// FIX (audit 2026-07-02 MED, Phoenix #5): modifiedFiles comes from the tool-call
// payloads the hook OBSERVES — no git spawn. Accumulates across calls via the
// journal, dedupes, and ignores non-file tools.
test('modifiedFiles accumulates from Write/Edit payloads across hook runs, deduped, no git', () => {
  const cwd = mkProject();
  const home = mk();
  const journalPath = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
  const payload = (tool, file) =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: file } });
  try {
    // 1st call: a Write names a file inside cwd -> recorded relative.
    let r = run(cwd, home, payload('Write', path.join(cwd, 'src', 'a.js')));
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(journalPath, 'utf8')).modifiedFiles,
      [path.join('src', 'a.js')]
    );
    // 2nd call: an Edit on another file ACCUMULATES onto the prior list.
    r = run(cwd, home, payload('Edit', path.join(cwd, 'src', 'b.js')));
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(journalPath, 'utf8')).modifiedFiles,
      [path.join('src', 'a.js'), path.join('src', 'b.js')]
    );
    // 3rd call: the same file re-touched -> deduped; a Read tool adds nothing.
    r = run(cwd, home, payload('Write', path.join(cwd, 'src', 'a.js')));
    assert.strictEqual(r.status, 0);
    r = run(cwd, home, payload('Read', path.join(cwd, 'src', 'c.js')));
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(journalPath, 'utf8')).modifiedFiles,
      [path.join('src', 'a.js'), path.join('src', 'b.js')],
      'dedup holds and a non-file tool contributes nothing'
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Incident E (MEMORY.md Field Evidence): the hook journals every Agent/Task spawn so
// a resume knows which subs were in-flight. Captures description + subagent_type from
// tool_input and a best-effort residue path from tool_response; accumulates across
// runs; a non-spawn tool adds nothing.
test('inFlightAgents: an Agent spawn is journaled (description/type/residue), a non-spawn tool adds none', () => {
  const cwd = mkProject();
  const home = mk();
  const journalPath = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
  const read = () => JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  try {
    // 1st: an Agent spawn with a tool_response carrying an output_file residue path.
    let r = run(cwd, home, JSON.stringify({
      tool_name: 'Agent',
      tool_input: { description: 'Scan module X', subagent_type: 'coalmine-scanner', prompt: 'go' },
      tool_response: { output_file: '/tmp/tasks/abc.output' },
    }));
    assert.strictEqual(r.status, 0);
    let agents = read().inFlightAgents;
    assert.strictEqual(agents.length, 1, 'the spawn is recorded');
    assert.strictEqual(agents[0].description, 'Scan module X');
    assert.strictEqual(agents[0].subagentType, 'coalmine-scanner');
    assert.strictEqual(agents[0].outputPath, '/tmp/tasks/abc.output');
    assert.ok(agents[0].spawnedAt, 'a spawn timestamp is stamped');

    // 2nd: a legacy `Task` name ACCUMULATES a second record.
    r = run(cwd, home, JSON.stringify({
      tool_name: 'Task',
      tool_input: { description: 'Review the diff', subagent_type: 'code-reviewer' },
    }));
    assert.strictEqual(r.status, 0);
    agents = read().inFlightAgents;
    assert.strictEqual(agents.length, 2, 'Task alias accumulates');
    assert.strictEqual(agents[1].description, 'Review the diff');
    assert.strictEqual(agents[1].outputPath, undefined, 'no tool_response -> no residue path (best-effort)');

    // 3rd: a non-spawn tool (Write) records the file but adds NO agent.
    r = run(cwd, home, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a.js') } }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(read().inFlightAgents.length, 2, 'a non-spawn tool contributes no agent');

    // 4th: a Workflow run is journaled by its own identifier shape (name/scriptPath,
    // no description/subagent_type) — the 2026-07-08 field evidence: a limit-hit
    // mid-workflow left zero outer-session record of the run's existence.
    r = run(cwd, home, JSON.stringify({
      tool_name: 'Workflow',
      tool_input: { name: 'verify-chapters', script: 'export const meta = {}' },
      tool_response: { transcriptDir: '/tmp/workflows/wf_abc123' },
    }));
    assert.strictEqual(r.status, 0);
    agents = read().inFlightAgents;
    assert.strictEqual(agents.length, 3, 'a Workflow spawn accumulates');
    assert.strictEqual(agents[2].description, 'verify-chapters', 'workflow name serves as the description');
    assert.strictEqual(agents[2].subagentType, 'workflow', 'tagged as a workflow run');
    assert.strictEqual(agents[2].outputPath, '/tmp/workflows/wf_abc123', 'transcriptDir probed as the residue path');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Board #94 (issue #13): the operator's own highest-ranked gap -- "no per-subagent
// progress record ... a single line would have changed the decision immediately".
// This hook fires exactly once per spawn call, AT RESOLUTION, so tool_response is
// always the RESOLVED outcome -- deriveStatus/deriveOutcome must capture it instead
// of discarding it. status is deliberately NOT trusted blind: an unrecognized/absent
// status reads 'unknown', never silently 'completed' (the reported incident's own
// 2nd subagent said `failed` while having actually finished -- assuming success from
// silence would repeat that mistake in the other direction).
test('inFlightAgents captures status + a capped outcome snippet from tool_response at resolution', () => {
  const cwd = mkProject();
  const home = mk();
  const journalPath = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
  const read = () => JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  try {
    // Reported-failed but the vocabulary is not trusted blind -- captured as 'failed'
    // with the error text, exactly the "7 of 11 checks done" shape the issue asks for.
    let r = run(cwd, home, JSON.stringify({
      tool_name: 'Agent',
      tool_input: { description: 'QC gate', subagent_type: 'qa' },
      tool_response: { status: 'failed', error: 'Agent terminated early due to an API error: session limit' },
    }));
    assert.strictEqual(r.status, 0);
    let a = read().inFlightAgents[0];
    assert.strictEqual(a.status, 'failed');
    assert.strictEqual(a.outcome, 'Agent terminated early due to an API error: session limit');

    // A recognizable success vocabulary -> 'completed'.
    r = run(cwd, home, JSON.stringify({
      tool_name: 'Task',
      tool_input: { description: 'Lint pass', subagent_type: 'linter' },
      tool_response: { status: 'success', summary: '0 errors, 3 warnings' },
    }));
    assert.strictEqual(r.status, 0);
    a = read().inFlightAgents[1];
    assert.strictEqual(a.status, 'completed');
    assert.strictEqual(a.outcome, '0 errors, 3 warnings');

    // No status field at all, or an unrecognized word -> 'unknown', NEVER silently
    // 'completed' -- an absent/unrecognized status is not evidence of success.
    r = run(cwd, home, JSON.stringify({
      tool_name: 'Agent',
      tool_input: { description: 'Silent one', subagent_type: 'x' },
      tool_response: {},
    }));
    assert.strictEqual(r.status, 0);
    a = read().inFlightAgents[2];
    assert.strictEqual(a.status, 'unknown');
    assert.strictEqual(a.outcome, undefined);

    // A huge outcome field is capped, never left to bloat the journal unbounded.
    const huge = 'x'.repeat(1000);
    r = run(cwd, home, JSON.stringify({
      tool_name: 'Agent',
      tool_input: { description: 'Verbose one', subagent_type: 'x' },
      tool_response: { status: 'failed', error: huge },
    }));
    assert.strictEqual(r.status, 0);
    a = read().inFlightAgents[3];
    assert.ok(a.outcome.length <= 301, `outcome capped, got ${a.outcome.length} chars`);
    assert.ok(a.outcome.endsWith('…'), 'a truncated outcome is marked, not silently cut');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('garbage stdin -> exit 0, no crash (Phoenix fail-silent)', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    const r = run(cwd, home, 'not json at all \0\x01');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unwritable outputDir (blocked by a file) -> fail-silent, exit 0', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    // Put a FILE where the journal dir would be created -> mkdirSync must fail inside
    // HandoffJournal's own try/catch, and the hook must still exit 0 silently.
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'coalhearth'), 'blocker');
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ROOT 1 / H1 (concurrent lost-update — crash-test repro: "at 10-agent fan-out, dropped
// 6/10 dead-worker records"; the shipped code lost 30/30 in the repro). N PostToolUse hooks
// fire CONCURRENTLY, each recording a distinct file. The load->merge->save RMW is now
// serialized under a per-dir O_EXCL lock (lib/handoff-journal.js updateUnderLock), so every
// writer's file must survive. RED-PROOF: point recordStep back at plain journal.load()+save()
// (drop updateUnderLock) and this goes red (last-save-wins drops most files).
//
// CORRECTED (board #142/U11-B1, 2026-08-31): the paragraph below used to read
// "observed not reproduced" / "never in isolation" and blamed external scheduler
// contention. FALSE — this test IS flaky in isolation on a quiescent box, reproduced
// directly (1/8 runs failed with zero other suites running). The real mechanism was
// found by instrumenting all 10 concurrent writers: a losing `wx`-lock-create race can
// surface as EPERM on Windows, not EEXIST, and the old _acquireLock code treated any
// non-EEXIST error as "unlockable" and bailed LOCK-FREE on its first attempt — nothing
// to do with LOCK_WAIT_MS or scheduler load. Fixed in handoff-journal.js's
// _acquireLock (its own comment there carries the full finding); 50/50 and separately
// 60/60 clean sweeps after the fix (failure was common before it, ~12-18% of runs).
// If this flakes again on a future
// contained-dir.js/handoff-journal.js touch, re-run the A/B this room's coder memory
// records (revert the touch, run the full suite N times, restore, run N more) — but do
// not default to "external load" as the explanation; check the errno first.
test('ROOT1/H1: concurrent PostToolUse writers do not lose each other\'s modifiedFiles', async () => {
  const { spawn } = require('node:child_process');
  const cwd = mkProject();
  const home = mk();
  const N = 10; // the crash-test's reachable "10-agent fan-out"; lossless with a huge margin (verified to 30)
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' };
    await Promise.all([...Array(N)].map((_, i) => new Promise((resolve) => {
      const p = spawn(process.execPath, [HOOK], { cwd, env });
      p.on('close', () => resolve());
      p.stdin.end(JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: path.join(cwd, `f${i}.js`) } }));
    })));
    const files = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')).modifiedFiles;
    assert.strictEqual(files.length, N, `all ${N} concurrent writers' files survive (got ${files.length})`);
    for (let i = 0; i < N; i++) assert.ok(files.includes(`f${i}.js`), `f${i}.js survived the concurrent RMW`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ROOT 1 / H2 (transient corruption erased). A corrupt journal must be QUARANTINED to
// session_handoff.corrupt.json (bytes preserved) before the RMW starts fresh — the old
// load()->null path silently overwrote the corrupt file, losing the bytes AND any hope of
// forensic recovery. RED-PROOF: drop the atomicWriteJournal(CORRUPT_NAME,...) call in
// HandoffJournal._loadOrQuarantine and the .corrupt.json assertion goes red.
test('ROOT1/H2: a corrupt journal is quarantined (exact bytes preserved), not silently overwritten', () => {
  const cwd = mkProject();
  const home = mk();
  const dir = path.join(cwd, '.claude', 'coalhearth');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const jp = path.join(dir, 'session_handoff.json');
    const corrupt = '{ half-written torn json ][';
    fs.writeFileSync(jp, corrupt);
    const r = run(cwd, home, JSON.stringify({ session_id: 'S', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.js') } }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const quarantine = path.join(dir, 'session_handoff.corrupt.json');
    assert.ok(fs.existsSync(quarantine), 'the corrupt bytes are quarantined aside');
    assert.strictEqual(fs.readFileSync(quarantine, 'utf8'), corrupt, 'the exact corrupt bytes are preserved');
    const j = JSON.parse(fs.readFileSync(jp, 'utf8')); // a valid fresh journal was written
    assert.strictEqual(j.status, 'in_progress');
    assert.deepStrictEqual(j.modifiedFiles, ['x.js']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ROOT 2 / H3 (no session identity — contamination half). recordStep now stamps the
// payload's session_id into the journal (CoalWash's estate guard reads it; the resume block
// prints it) AND keys "same session" on that id, so a DIFFERENT session writing into the same
// in_progress journal does NOT inherit the prior session's files. RED-PROOF: drop the
// sessionId thread in bin/post-tool-use.js (or revert recordStep's id-keyed sameSession to
// status-only) and the second block's assertions go red.
test('ROOT2/H3: the journal is stamped with session_id, and a different session does not inherit prior files', () => {
  const cwd = mkProject();
  const home = mk();
  const jp = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
  try {
    run(cwd, home, JSON.stringify({ session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a0.js') } }));
    run(cwd, home, JSON.stringify({ session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a1.js') } }));
    let j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.strictEqual(j.sessionId, 'sess-A', 'the journal is stamped with the owner session id (was always undefined before)');
    assert.deepStrictEqual(j.modifiedFiles, ['a0.js', 'a1.js']);

    // Session B (different id) writes into A's still-in_progress journal.
    run(cwd, home, JSON.stringify({ session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'b0.js') } }));
    j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.strictEqual(j.sessionId, 'sess-B', 'B now owns the journal');
    assert.deepStrictEqual(j.modifiedFiles, ['b0.js'], 'B did NOT inherit A\'s files (cross-session contamination prevented)');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// PHANTOM-SLUG (hooks-safety.md §8, USER 2026-07-25). Pre-fix, containedOutputDir
// defaulted `root` to raw process.cwd() with no anchor walk — a hook spawned from a
// project SUBDIRECTORY (any Bash `cd`, any subagent whose cwd drifted) planted its OWN
// `.claude/coalhearth/` right there. Live evidence: 26 phantom dirs measured across the
// TheColliery tree, 25 sharing one sessionId, none at a real project root. RED-PROOF:
// revert contained-dir.js's containedOutputDir to `root = process.cwd()` and both of
// these go red (a phantom appears at the subdir / with no project anywhere).
test('PHANTOM-SLUG: no real project anywhere up to home -> no journal is manufactured', () => {
  const home = mk();
  const cwd = path.join(home, 'no', 'project', 'here');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.ok(!fs.existsSync(path.join(cwd, '.claude')), 'no directory is manufactured to prove a project that is not there');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('PHANTOM-SLUG: a subdir of a real project anchors to the project root, not the subdir; a pre-existing legacy phantom there is self-cleaned', () => {
  const home = mk();
  const projectRoot = path.join(home, 'fakeproject');
  const subCwd = path.join(projectRoot, 'sub', 'dir');
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true }); // the project marker
  fs.mkdirSync(subCwd, { recursive: true });
  // Pre-plant a legacy phantom exactly where the pre-fix code would have written it.
  const legacyDir = path.join(subCwd, '.claude', 'coalhearth');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'session_handoff.json'), JSON.stringify({ status: 'in_progress', sessionId: 'stale' }));
  try {
    const r = run(subCwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const anchored = path.join(projectRoot, '.claude', 'coalhearth', 'session_handoff.json');
    assert.ok(fs.existsSync(anchored), 'the journal lands at the anchored project root, not the subdir');
    assert.ok(!fs.existsSync(path.join(legacyDir, 'session_handoff.json')), 'the legacy phantom file is self-cleaned');
    assert.ok(!fs.existsSync(legacyDir), 'the now-empty legacy dir is removed too');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// LOW (station-3, 2026-07-27): self-ignore plants its own `.gitignore` alongside
// session_handoff*, so a legacy phantom created back when both the phantom-slug bug
// AND self-ignore were live together holds BOTH files — the mop-up's unlink loop only
// knew the session_handoff family, so `.gitignore` survived and rmdir failed ENOTEMPTY
// forever after. RED-PROOF: drop the `.gitignore` name from selfCleanLegacyPhantom's
// own-file check in lib/contained-dir.js and this goes red (the dir survives).
test('PHANTOM-SLUG self-clean also removes its own leftover .gitignore, not just session_handoff*', () => {
  const home = mk();
  const projectRoot = path.join(home, 'fakeproject2');
  const subCwd = path.join(projectRoot, 'sub', 'dir');
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.mkdirSync(subCwd, { recursive: true });
  const legacyDir = path.join(subCwd, '.claude', 'coalhearth');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'session_handoff.json'), JSON.stringify({ status: 'in_progress', sessionId: 'stale' }));
  fs.writeFileSync(path.join(legacyDir, '.gitignore'), '*\n'); // planted by a past run's self-ignore
  try {
    const r = run(subCwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.ok(!fs.existsSync(legacyDir), 'the legacy dir (including its own .gitignore) is fully removed, not left ENOTEMPTY');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Does THIS VOLUME let a child's raw process.cwd() differ from its physical spelling?
// Case-insensitivity and 8.3 aliasing are properties of the VOLUME, never of
// process.platform (node/runtime.md §4) — so probe, never branch on the OS name.
// Returns null when the asymmetry is available, else the reason it is not.
function cwdSpellingProbe(scriptDir, spelling) {
  const probe = path.join(scriptDir, 'cwd-spelling-probe.js');
  fs.writeFileSync(probe, 'console.log(process.cwd());console.log(require("node:fs").realpathSync.native(process.cwd()));');
  const r = spawnSync(process.execPath, [probe], { cwd: spelling, encoding: 'utf8', timeout: 20000 });
  if (r.error) return `probe spawn failed: ${r.error.code || r.error.message}`;
  const [raw, physical] = String(r.stdout).trim().split(/\r?\n/);
  return raw === physical ? `volume is case-sensitive (raw cwd "${raw}" already equals its physical spelling)` : null;
}

// SELF-CLEAN NO-DRIFT (station-3 HIGH #1, 2026-07-26). selfCleanLegacyPhantom's
// "did drift happen" guard compared a FRESH RAW process.cwd() against a root that had
// descended through fs.realpathSync.native. Where a volume spells one directory two
// ways — a mis-cased cwd on any case-insensitive volume, an 8.3 alias on Windows
// (C:\Users\RUNNER~1 on CI) — the two sides differ on the ordinary NO-DRIFT case, the
// drift branch fires, and self-clean unlinks the session_handoff* files in the very
// directory containedOutputDir just created: warm-resume silently dead, and an existing
// journal/quarantine destroyed. Same bug class the pre-commit RED run caught once
// already (comparing a value DERIVED from one side against the other) — this is that
// bug on the axis its tests never touched.
// RED-PROOF: restore `selfCleanLegacyPhantom(process.cwd(), rootAbs)` in
// lib/contained-dir.js and this goes red (no journal written, quarantine unlinked).
test('SELF-CLEAN NO-DRIFT: a non-canonically-spelled cwd is not drift — the journal it just created survives', (t) => {
  const home = mk();
  const projectRoot = path.join(home, 'project');
  const misSpelled = path.join(home, 'PROJECT'); // same physical dir, second spelling
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  try {
    const why = cwdSpellingProbe(home, misSpelled);
    if (why) {
      t.skip(`raw-vs-physical cwd asymmetry unavailable here — ${why}`);
      return;
    }
    // A forensic quarantine already sitting in the journal dir: self-clean's unlink
    // loop matches the whole `session_handoff*` family, so a false drift destroys it.
    const journalDir = path.join(projectRoot, '.claude', 'coalhearth');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'session_handoff.corrupt.json'), '{"forensic":true}');

    const r = run(misSpelled, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    // Liveness by STATE EFFECT, not by exit 0 — Phoenix #4 guarantees exit 0 on every
    // bail path, so a dead hook and a working hook are indistinguishable by status.
    assert.ok(
      fs.existsSync(path.join(journalDir, 'session_handoff.json')),
      'the journal must be written when cwd IS the project root, however it is spelled'
    );
    assert.ok(
      fs.existsSync(path.join(journalDir, 'session_handoff.corrupt.json')),
      'a pre-existing quarantine must NOT be self-cleaned — there was no drift'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
