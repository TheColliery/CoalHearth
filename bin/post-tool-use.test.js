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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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

test('garbage stdin -> exit 0, no crash (Phoenix fail-silent)', () => {
  const cwd = mk();
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
  const cwd = mk();
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
test('ROOT1/H1: concurrent PostToolUse writers do not lose each other\'s modifiedFiles', async () => {
  const { spawn } = require('node:child_process');
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
