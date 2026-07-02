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

test('near-limit config -> advisory nudge on stdout (best-effort, non-blocking)', () => {
  const cwd = mk();
  const home = mk();
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    // Token-only guardrail: a tiny maxTokens + a large stdin payload -> the
    // estimated headroom drops under the warning fraction -> one nudge line.
    fs.writeFileSync(
      path.join(cwd, '.coalhearth.json'),
      JSON.stringify({ budgets: { maxTokens: 100, warningTokenPercentage: 0.15 } })
    );
    const r = run(cwd, home, 'x'.repeat(400)); // ~100 tok estimated -> 0% headroom
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /\[CoalHearth\]/);
    assert.match(r.stdout, /advisory/);
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
