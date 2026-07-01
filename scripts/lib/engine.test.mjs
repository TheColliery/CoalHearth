// CoalHearth — lib unit tests (the direct-call layer under the hermetic hook tests).
// Zero-dep (node:test only). Covers the class contracts:
//   HandoffJournal   — atomic save, unserializable fail-silent, ENOSPC prune, retry-exhaust
//   ResumeEngine     — detect(null/resumable/corrupt-quarantine), generate stale-advice,
//                      sweepOrphans resolve-and-contain (no blind delete, no path escape)
//   BudgetTracker    — estimateFromChars (ASCII vs non-ASCII ratio), evaluateLimits advisory
//   config-schema    — validateValue / validateConfig
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
const { BudgetTracker } = require(path.join(REPO, 'lib', 'budget-tracker.js'));
import { validateValue, validateConfig, CONFIG_SCHEMA } from './config-schema.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-unit-'));
}

// --- HandoffJournal ---------------------------------------------------------

test('HandoffJournal.save writes atomically (no .tmp left) and returns true', () => {
  const dir = tmp();
  try {
    const ok = new HandoffJournal({ outputDirectory: dir }).save({ status: 'in_progress' });
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
    assert.doesNotThrow(() => { ok = new HandoffJournal({ outputDirectory: dir }).save(circular); });
    assert.strictEqual(ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffJournal.save prunes non-journal files on ENOSPC then succeeds, keeping the core json', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale\n');
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 });
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
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 });
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

// --- ResumeEngine -----------------------------------------------------------

test('ResumeEngine.detectAbortedSession returns null when no journal exists', () => {
  const dir = tmp();
  try {
    assert.strictEqual(new ResumeEngine({ outputDirectory: dir }).detectAbortedSession(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResumeEngine.detectAbortedSession returns data for in_progress/limit_reached, null for completed', () => {
  const dir = tmp();
  try {
    const engine = new ResumeEngine({ outputDirectory: dir });
    const p = path.join(dir, 'session_handoff.json');
    for (const s of ['in_progress', 'limit_reached']) {
      fs.writeFileSync(p, JSON.stringify({ status: s, sessionId: s }));
      assert.strictEqual(engine.detectAbortedSession()?.status, s, `${s} is resumable`);
    }
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
    const engine = new ResumeEngine({ outputDirectory: dir });
    fs.writeFileSync(path.join(dir, 'session_handoff.json'), '{ broken json');
    assert.strictEqual(engine.detectAbortedSession(), null, 'corrupt -> null (boot clean)');
    assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json')), false, 'corrupt removed');
    assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.corrupt.json')), true, 'quarantined');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResumeEngine.generateHandoffPrompt renders goal/checklist and ALWAYS advises verify-vs-git (never blind-trust)', () => {
  const md = new ResumeEngine({ outputDirectory: tmp() }).generateHandoffPrompt({
    sessionId: 's1',
    timestamp: '2026-07-01T00:00:00.000Z',
    status: 'limit_reached',
    checklist: [{ task: 'A', status: 'done' }, { task: 'B', status: 'doing' }],
    modifiedFiles: ['x.js'],
    activePlan: { goal: 'Do X', nextSteps: ['step 1'], constraints: ['c1'] },
  });
  assert.match(md, /Do X/);
  assert.match(md, /Do not blind-trust this snapshot/i, 'stale-advice present');
  assert.match(md, /VERIFY against git|git status|working tree/i);
  assert.match(md, /\[x\] A/); // done rendered
  assert.match(md, /\[\/\] B/); // doing rendered
  assert.strictEqual(new ResumeEngine({ outputDirectory: tmp() }).generateHandoffPrompt(null), '', 'null -> empty');
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

    const counts = new ResumeEngine({ outputDirectory: path.join(root, '.claude', 'coalhearth') }).sweepOrphans(root);

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

test('ResumeEngine.sweepOrphans never escapes root even if a scratch dir is a symlink out', () => {
  const root = tmp();
  const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'probe_escape.mjs'), 'must survive');
    // Point an OWNED scratch dir at an OUTSIDE dir via symlink; the resolve-and-contain
    // guard must refuse to sweep files whose resolved path leaves root.
    fs.mkdirSync(path.join(root, '.claude', 'coalhearth'), { recursive: true });
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, '.claude', 'coalhearth', 'scratch'), 'dir');
      linked = true;
    } catch {
      return; // symlink not permitted on this box (e.g. no admin on Windows) -> skip
    }
    if (linked) {
      new ResumeEngine({ outputDirectory: path.join(root, '.claude', 'coalhearth') }).sweepOrphans(root);
      assert.strictEqual(
        fs.existsSync(path.join(outside, 'probe_escape.mjs')),
        true,
        'a symlinked-out scratch dir must NOT be swept (resolve-and-contain)'
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// --- BudgetTracker (advisory only) -----------------------------------------

test('BudgetTracker.estimateFromChars uses 4 chars/tok for ASCII, ~1.5 for non-ASCII', () => {
  const t = new BudgetTracker({});
  assert.strictEqual(t.estimateFromChars('abcd', true), 1, 'ASCII: 4 chars -> 1 tok');
  assert.strictEqual(t.estimateFromChars('abcdefgh', true), 2, 'ASCII: 8 chars -> 2 tok');
  // 3 non-ASCII chars -> ceil(3 / 1.5) = 2
  assert.strictEqual(new BudgetTracker({}).estimateFromChars('ก็ไม่', false) >= 3, true, 'non-ASCII denser ratio');
  assert.strictEqual(new BudgetTracker({}).estimateFromChars('', true), 0, 'empty -> 0');
  assert.strictEqual(new BudgetTracker({}).estimateFromChars(null, true), 0, 'null -> 0 (no throw)');
});

test('BudgetTracker.evaluateLimits flags near-turn-limit as shouldBlockSpawning (advisory)', () => {
  const t = new BudgetTracker({ maxTurns: 3, warningTurnThreshold: 5 });
  const r = t.evaluateLimits();
  assert.strictEqual(r.shouldBlockSpawning, true, 'turnsRemaining(3) <= threshold(5)');
  assert.match(r.reason, /turns remaining/i);
  assert.strictEqual(r.limitReached, false);
});

test('BudgetTracker.evaluateLimits reports limitReached once turns are exhausted', () => {
  const t = new BudgetTracker({ maxTurns: 1, warningTurnThreshold: 0 });
  t.incrementTurn(); // 1 used, 0 remaining
  const r = t.evaluateLimits();
  assert.strictEqual(r.limitReached, true, 'no turns remaining -> limitReached');
});

test('BudgetTracker.evaluateLimits stays OK with headroom (advisory, never a hard promise)', () => {
  const t = new BudgetTracker({ maxTurns: 30, warningTurnThreshold: 5, maxTokens: 1000000 });
  t.estimateFromChars('a'.repeat(4), true); // 1 token used, ~100% headroom
  const r = t.evaluateLimits();
  assert.strictEqual(r.shouldBlockSpawning, false);
  assert.strictEqual(r.limitReached, false);
  assert.strictEqual(r.reason, 'OK');
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
    budgets: { maxTurns: 30, maxTokens: 2000000, warningTurnThreshold: 5, warningTokenPercentage: 0.15 },
    journal: { outputDirectory: '.claude/coalhearth', historyLimit: 5, atomicityRetries: 3 },
    recovery: { autoInjectPrompt: true, stashUnsavedChanges: true },
  };
  assert.deepStrictEqual(validateConfig(factory), [], 'factory config is valid');
  assert.ok(Object.keys(CONFIG_SCHEMA).length === 3, 'three config groups');
  assert.deepStrictEqual(validateConfig({ nope: {} }), ["group 'nope' not in schema"]);
  assert.deepStrictEqual(validateConfig({ budgets: { bogus: 1 } }), ["'budgets.bogus' not in schema"]);
  assert.deepStrictEqual(validateConfig({ budgets: { maxTurns: 0 } }), ["'budgets.maxTurns' must be >= 1"]);
});
