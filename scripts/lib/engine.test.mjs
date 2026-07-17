// CoalHearth — lib unit tests (the direct-call layer under the hermetic hook tests).
// Zero-dep (node:test only). Covers the class contracts:
//   HandoffJournal   — atomic save, unserializable fail-silent, ENOSPC prune, retry-exhaust
//   ResumeEngine     — detect(null/resumable/corrupt-quarantine), generate stale-advice,
//                      sweepOrphans resolve-and-contain (no blind delete, no path escape)
//   config-schema    — validateValue / validateConfig
// (BudgetTracker removed — the advisory budget guardrail was retired; see CHANGELOG.)
//
// The lib is CJS (require()); this ESM test uses createRequire to load it, and a
// per-test tmp dir under os.tmpdir() so nothing touches real state.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { HandoffJournal } = require(path.join(REPO, 'lib', 'handoff-journal.js'));
const { ResumeEngine } = require(path.join(REPO, 'lib', 'resume-engine.js'));
const { containedOutputDir } = require(path.join(REPO, 'lib', 'contained-dir.js'));
import { validateValue, validateConfig, CONFIG_SCHEMA } from './config-schema.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-unit-'));
}

// --- HandoffJournal ---------------------------------------------------------

test('HandoffJournal.save writes atomically (no .tmp left) and returns true', () => {
  const dir = tmp();
  try {
    const ok = new HandoffJournal({ outputDirectory: dir }, dir).save({ status: 'in_progress' });
    assert.strictEqual(ok, true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'session_handoff.json'), 'utf8'));
    assert.strictEqual(written.status, 'in_progress');
    assert.ok(written.timestamp, 'save stamps a timestamp');
    assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json.tmp')), false, 'tmp renamed away');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffJournal.save is fail-silent (returns false, no throw) on unserializable state', () => {
  const dir = tmp();
  try {
    const circular = {};
    circular.self = circular;
    let ok;
    assert.doesNotThrow(() => { ok = new HandoffJournal({ outputDirectory: dir }, dir).save(circular); });
    assert.strictEqual(ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffJournal.save prunes non-journal files on ENOSPC then succeeds, keeping the core json', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale\n');
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 }, dir);
  const realWrite = fs.writeFileSync;
  let n = 0;
  fs.writeFileSync = (...a) => {
    if (++n === 1) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }
    return realWrite(...a);
  };
  try {
    const ok = journal.save({ status: 'in_progress' });
    assert.strictEqual(ok, true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'error.log')), false, 'prunable log removed on ENOSPC');
    assert.ok(fs.existsSync(path.join(dir, 'session_handoff.json')), 'core json survives');
  } finally {
    fs.writeFileSync = realWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffJournal.save returns false after exhausting retries on a persistent lock (EBUSY)', () => {
  const dir = tmp();
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 }, dir);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  try {
    let ok;
    assert.doesNotThrow(() => { ok = journal.save({ status: 'in_progress' }); });
    assert.strictEqual(ok, false);
  } finally {
    fs.writeFileSync = realWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression (audit 2026-07-02 MED): atomicityRetries is clamped to [1,5], so a
// hostile `.coalhearth.json` (retries:50) can't spin save()'s SYNCHRONOUS busy-wait
// backoff for seconds on the PostToolUse hot-path (the audit reproduced 25,504ms).
test('HandoffJournal clamps atomicityRetries to a small max (no multi-second busy-wait)', () => {
  const d = tmp();
  assert.strictEqual(new HandoffJournal({ outputDirectory: d, atomicityRetries: 50 }, d).retries, 5, 'clamped to 5');
  assert.strictEqual(new HandoffJournal({ outputDirectory: d, atomicityRetries: 3 }, d).retries, 3, 'in-range kept');
  assert.strictEqual(new HandoffJournal({ outputDirectory: d, atomicityRetries: 0 }, d).retries, 3, 'non-positive -> default');
  assert.strictEqual(new HandoffJournal({ outputDirectory: d }, d).retries, 3, 'absent -> default');
  fs.rmSync(d, { recursive: true, force: true });

  // A persistent write failure with a huge configured retry count must return fast.
  const dir = tmp();
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 50 }, dir);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  try {
    const t0 = Date.now();
    const ok = journal.save({ status: 'in_progress' });
    const elapsed = Date.now() - t0;
    assert.strictEqual(ok, false);
    assert.ok(elapsed < 1000, `save() returned in ${elapsed}ms — clamp holds it well under the 25.5s unclamped case`);
  } finally {
    fs.writeFileSync = realWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- ResumeEngine -----------------------------------------------------------

test('ResumeEngine.detectAbortedSession returns null when no journal exists', () => {
  const dir = tmp();
  try {
    assert.strictEqual(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResumeEngine.detectAbortedSession returns data for in_progress, null for completed/aborted/retired-limit_reached', () => {
  const dir = tmp();
  try {
    const engine = new ResumeEngine({ outputDirectory: dir }, {}, dir);
    const p = path.join(dir, 'session_handoff.json');
    fs.writeFileSync(p, JSON.stringify({ status: 'in_progress', sessionId: 's' }));
    assert.strictEqual(engine.detectAbortedSession()?.status, 'in_progress', 'in_progress is resumable');
    // limit_reached is no longer resumable — no code path ever writes it (retired with the
    // budget guardrail); a stray one from an old journal is treated as non-resumable.
    fs.writeFileSync(p, JSON.stringify({ status: 'limit_reached' }));
    assert.strictEqual(engine.detectAbortedSession(), null, 'retired limit_reached is not resumable');
    fs.writeFileSync(p, JSON.stringify({ status: 'completed' }));
    assert.strictEqual(engine.detectAbortedSession(), null, 'completed is not resumable');
    fs.writeFileSync(p, JSON.stringify({ status: 'aborted' }));
    assert.strictEqual(engine.detectAbortedSession(), null, 'aborted is not resumable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResumeEngine.detectAbortedSession quarantines a corrupt journal and boots clean', () => {
  const dir = tmp();
  try {
    const engine = new ResumeEngine({ outputDirectory: dir }, {}, dir);
    fs.writeFileSync(path.join(dir, 'session_handoff.json'), '{ broken json');
    assert.strictEqual(engine.detectAbortedSession(), null, 'corrupt -> null (boot clean)');
    assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json')), false, 'corrupt removed');
    assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.corrupt.json')), true, 'quarantined');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResumeEngine.generateHandoffPrompt renders goal/checklist and ALWAYS advises verify-vs-git (never blind-trust)', () => {
  const d = tmp();
  const md = new ResumeEngine({ outputDirectory: d }, {}, d).generateHandoffPrompt({
    sessionId: 's1',
    timestamp: '2026-07-01T00:00:00.000Z',
    status: 'in_progress',
    checklist: [{ task: 'A', status: 'done' }, { task: 'B', status: 'doing' }],
    modifiedFiles: ['x.js'],
    activePlan: { goal: 'Do X', nextSteps: ['step 1'], constraints: ['c1'] },
  });
  assert.match(md, /Do X/);
  assert.match(md, /Do not blind-trust this snapshot/i, 'stale-advice present');
  assert.match(md, /VERIFY against git|git status|working tree/i);
  assert.match(md, /\[x\] A/); // done rendered
  assert.match(md, /\[\/\] B/); // doing rendered
  assert.strictEqual(new ResumeEngine({ outputDirectory: d }, {}, d).generateHandoffPrompt(null), '', 'null -> empty');
  fs.rmSync(d, { recursive: true, force: true });
});

// Regression (audit 2026-07-02 L7): recovery.stashUnsavedChanges was inert. It now
// gates the stash-advice line in the recovery prompt (default on; false drops it).
test('ResumeEngine.generateHandoffPrompt gates the stash-advice line on recovery.stashUnsavedChanges', () => {
  const data = {
    sessionId: 's1', timestamp: '2026-07-01T00:00:00.000Z', status: 'in_progress',
    checklist: [], modifiedFiles: [], activePlan: { goal: 'X', nextSteps: [], constraints: [] },
  };
  const d = tmp();
  const on = new ResumeEngine({ outputDirectory: d }, {}, d).generateHandoffPrompt(data); // default on
  const explicitOn = new ResumeEngine({ outputDirectory: d }, { stashUnsavedChanges: true }, d).generateHandoffPrompt(data);
  const off = new ResumeEngine({ outputDirectory: d }, { stashUnsavedChanges: false }, d).generateHandoffPrompt(data);
  assert.match(on, /git stash/i, 'default -> stash advice present');
  assert.match(explicitOn, /git stash/i, 'explicit true -> present');
  assert.doesNotMatch(off, /git stash/i, 'false -> stash advice dropped');
  fs.rmSync(d, { recursive: true, force: true });
});

// Incident E (MEMORY.md Field Evidence): the recovery block LISTS in-flight subagents
// at interruption so a resume knows which subs were running + where residue lives. The
// section is honestly scoped (verify/re-spawn — it does not recover the sub's work).
test('ResumeEngine.generateHandoffPrompt lists in-flight subagents (Incident E), None when absent', () => {
  const d = tmp();
  const engine = new ResumeEngine({ outputDirectory: d }, {}, d);
  const base = {
    sessionId: 's1', timestamp: '2026-07-01T00:00:00.000Z', status: 'in_progress',
    checklist: [], modifiedFiles: [], activePlan: { goal: 'X', nextSteps: [], constraints: [] },
  };
  const withAgents = engine.generateHandoffPrompt({
    ...base,
    inFlightAgents: [
      { description: 'Scan module X', subagentType: 'coalmine-scanner', outputPath: '/tmp/tasks/abc.output', spawnedAt: '2026-07-01T00:00:01.000Z' },
      { description: 'Review the diff', subagentType: undefined, outputPath: undefined, spawnedAt: '2026-07-01T00:00:02.000Z' },
    ],
  });
  assert.match(withAgents, /In-flight subagents at interruption/, 'section header present');
  assert.match(withAgents, /Scan module X/);
  assert.match(withAgents, /\[coalmine-scanner\]/, 'subagent type rendered when present');
  assert.match(withAgents, /residue: `\/tmp\/tasks\/abc\.output`/, 'residue path rendered when present');
  assert.match(withAgents, /Review the diff/);
  // No inFlightAgents -> the section renders "None" (never a crash / stray field).
  assert.match(engine.generateHandoffPrompt(base), /In-flight subagents at interruption \(verify\/re-spawn as needed\)\n+None/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('ResumeEngine.sweepOrphans removes OWNED scratch/worktrees only, never the user tree, never a blind delete', () => {
  const root = tmp();
  try {
    // In-scope scratch = a CoalHearth-OWNED dir (NEVER the user's own scripts/):
    const scratch = path.join(root, '.claude', 'coalhearth', 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'probe_x.mjs'), 'x');
    fs.writeFileSync(path.join(scratch, '__probe_y.js'), 'x');
    fs.writeFileSync(path.join(scratch, 'keep.mjs'), 'real'); // non-scratch pattern survives
    // In-scope stale worktree + an unowned sibling that must survive:
    const wt = path.join(root, '.claude', 'coalhearth', 'worktrees');
    fs.mkdirSync(path.join(wt, 'ch-worker-1'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'mine'), { recursive: true });
    // USER TERRITORY (must survive): a probe_*-named file the USER wrote in their own
    // scripts/ — the sweep NEVER touches it (work-review MED #2, the Incident B hazard).
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'probe_user.mjs'), 'user file');
    // Out-of-scope probe file at root (must survive — not in an allow-listed dir):
    fs.writeFileSync(path.join(root, 'probe_root.mjs'), 'x');

    const counts = new ResumeEngine({ outputDirectory: path.join(root, '.claude', 'coalhearth') }, {}, root).sweepOrphans(root);

    assert.strictEqual(counts.scratch, 2, 'both OWNED scratch files counted');
    assert.strictEqual(counts.worktrees, 1, 'the ch-worker worktree counted');
    assert.strictEqual(fs.existsSync(path.join(scratch, 'probe_x.mjs')), false);
    assert.strictEqual(fs.existsSync(path.join(scratch, '__probe_y.js')), false);
    assert.strictEqual(fs.existsSync(path.join(scratch, 'keep.mjs')), true, 'non-scratch untouched');
    assert.strictEqual(fs.existsSync(path.join(wt, 'ch-worker-1')), false);
    assert.strictEqual(fs.existsSync(path.join(wt, 'mine')), true, 'unowned worktree untouched');
    assert.strictEqual(fs.existsSync(path.join(root, 'scripts', 'probe_user.mjs')), true, "the user's own scripts/probe_*.js is NEVER swept");
    assert.strictEqual(fs.existsSync(path.join(root, 'probe_root.mjs')), true, 'out-of-scope file untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ResumeEngine.sweepOrphans never escapes root even if a scratch dir is a symlink out', (t) => {
  const root = tmp();
  const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'probe_escape.mjs'), 'must survive');
    // Point an OWNED scratch dir at an OUTSIDE dir via symlink; the resolve-and-contain
    // guard must refuse to sweep files whose resolved path leaves root.
    fs.mkdirSync(path.join(root, '.claude', 'coalhearth'), { recursive: true });
    try {
      // 'junction' creates unprivileged on Windows (no admin/Dev-Mode needed); the
      // type arg is ignored on POSIX. A silent vacuous pass here hid a real escape
      // bug until CI's first run — skip VISIBLY if the filesystem truly can't link.
      fs.symlinkSync(outside, path.join(root, '.claude', 'coalhearth', 'scratch'), 'junction');
    } catch {
      t.skip('symlink/junction not permitted on this filesystem');
      return;
    }
    new ResumeEngine({ outputDirectory: path.join(root, '.claude', 'coalhearth') }, {}, root).sweepOrphans(root);
    assert.strictEqual(
      fs.existsSync(path.join(outside, 'probe_escape.mjs')),
      true,
      'a symlinked-out scratch dir must NOT be swept (resolve-and-contain)'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// Regression (audit 2026-07-02 MED, round 2): ResumeEngine's quarantine +
// mark-resumed writes go through outputDir, so its constructor routes through the
// same realpath containment as HandoffJournal — an untrusted outputDirectory
// escaping the workspace clamps to the default owned dir.
test('ResumeEngine clamps an outputDirectory escaping the workspace root', () => {
  const base = tmp();
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const engine = new ResumeEngine({ outputDirectory: path.join('..', 'victim') }, {}, workspace);
    assert.strictEqual(engine.outputDir, path.join(workspace, '.claude', 'coalhearth'), 'escape clamped to the default owned dir');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- contained-dir ----------------------------------------------------------

// Regression (audit 2026-07-02 L3): containedOutputDir must run the PHYSICAL
// containment check BEFORE mkdir, so a lexically-inside dir that symlink-escapes
// root never leaks an incidental empty dir OUTSIDE root (the old order mkdir'd
// first, then returned null on the failed containment — fail-closed on the return,
// but the outside dir already existed). Repro (show-me lens): root/.claude junctioned
// to a victim + outputDirectory ".claude/coalhearth" must NOT create victim/coalhearth.
test('containedOutputDir creates NO outside dir when a path symlink-escapes root (check-before-mkdir)', (t) => {
  // realpath the sandboxes: macOS os.tmpdir() is a /var->/private/var symlink; the
  // relative containment compare needs like-for-like physical paths (no-op elsewhere).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cdir-root-')));
  const victim = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cdir-victim-')));
  try {
    // Junction root/.claude -> victim (unprivileged on Windows; type ignored on POSIX).
    try {
      fs.symlinkSync(victim, path.join(root, '.claude'), 'junction');
    } catch {
      t.skip('symlink/junction not permitted on this filesystem');
      return;
    }
    const out = containedOutputDir('.claude/coalhearth', root);
    // The configured path resolves through the junction to victim/coalhearth (outside
    // root) -> rejected; the default `.claude/coalhearth` routes through the SAME
    // junction -> also rejected -> fail-closed null.
    assert.strictEqual(out, null, 'a fully-escaping config + default -> null (fail-closed)');
    assert.strictEqual(
      fs.existsSync(path.join(victim, 'coalhearth')),
      false,
      'NO dir is created outside root before the containment check refuses'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

// The happy path still works: a legit in-workspace dir (no symlink) is created and returned.
test('containedOutputDir creates + returns a legit in-workspace dir (happy path intact)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cdir-ok-')));
  try {
    const out = containedOutputDir('.claude/coalhearth', root);
    assert.strictEqual(out, path.join(root, '.claude', 'coalhearth'), 'returns the contained dir');
    assert.strictEqual(fs.existsSync(out), true, 'and creates it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- config-schema ----------------------------------------------------------

test('config-schema validateValue enforces type + bounds', () => {
  assert.strictEqual(validateValue({ type: 'int', min: 1 }, 5), null);
  assert.match(validateValue({ type: 'int', min: 1 }, 0), /must be >= 1/);
  assert.match(validateValue({ type: 'int' }, 1.5), /must be an integer/);
  assert.match(validateValue({ type: 'number', min: 0, max: 1 }, 2), /must be <= 1/);
  assert.strictEqual(validateValue({ type: 'bool' }, true), null);
  assert.match(validateValue({ type: 'bool' }, 'yes'), /must be a boolean/);
  assert.strictEqual(validateValue({ type: 'string' }, 'x'), null);
});

test('config-schema validateConfig passes the factory shape and flags unknown group/key', () => {
  const factory = {
    journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 3 },
    recovery: { autoInjectPrompt: true, stashUnsavedChanges: true },
    update: { updateMode: 'ask', updateCheckDays: 14 },
  };
  assert.deepStrictEqual(validateConfig(factory), [], 'factory config is valid');
  assert.ok(Object.keys(CONFIG_SCHEMA).length === 3, 'three config groups (journal/recovery/update) — budgets retired');
  assert.deepStrictEqual(validateConfig({ nope: {} }), ["group 'nope' not in schema"]);
  assert.deepStrictEqual(validateConfig({ journal: { bogus: 1 } }), ["'journal.bogus' not in schema"]);
  assert.deepStrictEqual(validateConfig({ journal: { atomicityRetries: 0 } }), ["'journal.atomicityRetries' must be >= 1"]);
  assert.match(validateValue({ type: 'enum', values: ['ask', 'auto', 'remind', 'off'] }, 'sometimes'), /must be one of/);
  assert.strictEqual(validateValue({ type: 'enum', values: ['ask', 'auto', 'remind', 'off'] }, 'OFF'), null, 'enum compares case-insensitively');
});

// Tombstone (H7): the ENTIRE `budgets` group is REMOVED with the retired budget guardrail
// (it joins the earlier beta.6 maxTurns/warningTurnThreshold tombstone — the identical
// dead-path pattern). A config still carrying it is flagged as an unknown GROUP, never
// silently accepted (same tombstone-by-removal pattern as CoalTipple's rankingMode).
test('tombstone: the budgets group is REMOVED from the schema (guardrail retired)', () => {
  assert.strictEqual(CONFIG_SCHEMA.budgets, undefined, 'the budgets group is gone from the schema');
  assert.deepStrictEqual(
    validateConfig({ budgets: { maxTokens: 100 } }),
    ["group 'budgets' not in schema"],
    'a stale config carrying the retired group is reported, not silently honored'
  );
});

// H7 RETIRE — the consolidated "removed path is gone" proof: the tracker file is deleted and
// recordStep is now journal-only (returns nothing — no shouldBlockSpawning analysis), while
// the recovery core still records the step. RED-PROOF: undelete lib/budget-tracker.js and
// restore recordStep's tracker return, and the ret/undefined assertion goes red.
test('RETIRED budget guardrail: tracker file gone + recordStep is journal-only (recovery core intact)', () => {
  assert.strictEqual(fs.existsSync(path.join(REPO, 'lib', 'budget-tracker.js')), false, 'lib/budget-tracker.js is deleted');
  const { recordStep } = require(path.join(REPO, 'lib', 'journal-step.js'));
  // recordStep contains its journal dir under process.cwd() (the workspace, as the real hook
  // runs), so chdir into a throwaway dir to keep the write out of the repo. realpath so the
  // read path matches process.cwd() on macOS (/var -> /private/var).
  const dir = fs.realpathSync(tmp());
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const ret = recordStep(process.cwd(), { journal: {} }, { sessionId: 'S', touchedFile: path.join(dir, 'x.js') });
    assert.strictEqual(ret, undefined, 'recordStep returns nothing — the budget analysis is gone');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')).status,
      'in_progress',
      'the recovery core still journals the step'
    );
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
