// CoalHearth ResumeEngine — warm-resume recovery loader.
// Contract (see COALHEARTH_BLUEPRINT.md §3C): reads the handoff journal written by
// HandoffJournal and, if a session was interrupted, produces a markdown recovery
// block for the next session. Fail-silent (hooks-safety.md): never throws, a
// corrupt journal is quarantined rather than crashing the boot.
//
// Honest frame: the journal is a best-effort snapshot, not a guarantee it's still
// accurate — code may have moved since the last save. generateHandoffPrompt()
// always tells the agent to VERIFY against git, never to blind-trust the journal.
const fs = require('node:fs');
const path = require('node:path');
const { containedOutputDir, findWorkspaceRoot } = require('./contained-dir.js');
// One source of truth for the journal file layout + the atomic writer (H6/H7 one-flock:
// mark-resumed and quarantine go through the SAME per-pid temp+rename as HandoffJournal.save).
const { atomicWriteJournal, JOURNAL_NAME: JOURNAL_FILE, CORRUPT_NAME: CORRUPT_FILE } = require('./handoff-journal.js');

// Only 'in_progress' is ever written now. 'limit_reached' was the status the retired budget
// guardrail was meant to set on a limit-hit, but NO code path ever wrote it (buildStateSnapshot
// always writes 'in_progress') — removed with the guardrail rather than left as a dead branch.
const RESUMABLE_STATUSES = new Set(['in_progress']);
const asArray = (v) => (Array.isArray(v) ? v : []); // H4: a wrong-typed field never .map()-throws

// Scoped orphan sweep (MEMORY.md Incident B: a limit-killed worker cannot run its
// own finally-cleanup, so it leaves scratch files [probe_*.mjs, __probe_*.mjs] a
// live worktree behind). We remove ONLY known scratch/worktree patterns, ONLY
// inside a small allow-list of staging/scratch dirs, and ONLY resolve-and-contained
// under the workspace root — NEVER a blind recursive delete. Best-effort, fail-silent.
// ONLY CoalHearth-OWNED scratch dirs — NEVER the user's own tree (scripts/, src/, ...).
// A probe_*.js the USER wrote would be blind-deleted on resume otherwise (work-review
// MED #2, the exact "delete in user territory" hazard Incident B warned against). A
// worker that leaves scratch MUST write it under a CoalHearth-owned dir; we sweep only
// what we own.
const SCRATCH_DIRS = ['.claude/coalhearth/scratch', '.agents/coalhearth/scratch'];
const SCRATCH_FILE_RE = /^(?:__)?probe_.*\.(?:mjs|js|cjs)$/;
const WORKTREE_DIRS = ['.claude/coalhearth/worktrees', '.agents/coalhearth/worktrees'];
const STALE_WORKTREE_RE = /^ch-worker-/; // CoalHearth-owned stale worker worktree dirs

class ResumeEngine {
  /**
   * @param {Object} config CoalHearth journal configuration ({ outputDirectory }).
   * @param {Object} [recovery] recovery.* flags ({ stashUnsavedChanges }); the
   *   stash-advice line in the recovery prompt is gated on stashUnsavedChanges
   *   (default true) — otherwise the key was inert (audit 2026-07-02 L7).
   * @param {string} [root] workspace root the outputDirectory is realpath-contained
   *   under. OMITTED (what both shipped hooks pass) -> auto-anchored to the resolved
   *   project root, never raw process.cwd() (hooks-safety.md §8) — the quarantine +
   *   mark-resumed writes go through
   *   it, so an untrusted config must not aim them outside (audit 2026-07-02 MED;
   *   see lib/contained-dir.js). Escape -> clamp to default; null -> no-op.
   */
  constructor(config, recovery, root) {
    this.config = config || {};
    this.recovery = recovery || {};
    this.outputDir = containedOutputDir(this.config.outputDirectory, root);
  }

  /**
   * Detects a resumable session left behind by a prior run.
   * @returns {Object|null} the parsed journal, or null if none / not resumable.
   */
  detectAbortedSession() {
    if (!this.outputDir) return null; // fail-closed: no contained dir -> boot clean
    const journalPath = path.join(this.outputDir, JOURNAL_FILE);
    let raw;
    try {
      raw = fs.readFileSync(journalPath, 'utf8');
    } catch {
      return null; // no journal -> nothing to resume, boot clean
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      this._quarantine(journalPath, raw);
      return null; // corrupt -> quarantined, boot clean (FMEA §5)
    }

    if (!data || typeof data !== 'object' || !RESUMABLE_STATUSES.has(data.status)) {
      return null;
    }
    return data;
  }

  /**
   * Moves a corrupt journal aside so it never blocks the next boot.
   * Fail-silent: a failed quarantine still lets the caller return null.
   */
  _quarantine(journalPath, raw) {
    try {
      atomicWriteJournal(this.outputDir, CORRUPT_FILE, raw); // per-pid temp+rename (H6/H7)
      fs.rmSync(journalPath, { force: true });
    } catch {
      // ponytail: best-effort cleanup; a stuck corrupt file is still non-fatal,
      // detectAbortedSession's JSON.parse guard keeps every future boot clean too.
    }
  }

  /**
   * Marks a detected journal `resumed` so a later boot won't re-detect it (and the
   * contamination guard's status proxy holds for id-less sessions). ATOMIC (per-pid
   * temp+rename, H6/H7) — the old inline fs.writeFileSync in each hook wrote the live
   * journal directly, so a crash mid-write left a torn journal that then read as corrupt.
   * Fail-silent boolean: false on a read-only fs (the hook appends its honest "may repeat"
   * note) or an uncontained dir. The two SessionStart adapters share this ONE writer.
   * @param {Object} data the detected journal (its sessionId/lists are preserved).
   * @returns {boolean} whether the mark stuck.
   */
  markResumed(data) {
    if (!this.outputDir) return false;
    return atomicWriteJournal(this.outputDir, JOURNAL_FILE, JSON.stringify({ ...data, status: 'resumed' }, null, 2));
  }

  /**
   * Builds the markdown recovery block injected into the next session's context.
   * @param {Object} data The parsed journal state from detectAbortedSession().
   * @returns {string} markdown, or '' if data is missing.
   */
  generateHandoffPrompt(data) {
    if (!data) return '';

    // H4: every list is coerced with asArray() before .map — a corrupt/foreign journal whose
    // checklist/modifiedFiles/inFlightAgents/nextSteps/constraints is a non-array (a string, a
    // number) must NOT throw here. A throw would be swallowed fail-silent AND (before the
    // reorder in the hooks) leave the journal already marked `resumed` = permanently
    // unrecoverable. checklist items are filtered to objects for the same reason.
    const plan = (data.activePlan && typeof data.activePlan === 'object') ? data.activePlan : {};
    const checklist = asArray(data.checklist)
      .filter((item) => item && typeof item === 'object')
      .map((item) => `- [${item.status === 'done' ? 'x' : item.status === 'doing' ? '/' : ' '}] ${item.task}`)
      .join('\n') || 'None';
    const files = asArray(data.modifiedFiles).map((f) => `- \`${f}\``).join('\n') || 'None';
    // In-flight subagents at interruption (Incident E). HONEST SCOPE: this lists that
    // a sub was RUNNING + where its residue may live — it does NOT recover the sub's
    // work (a killed sub journals nothing); the resumed session verifies/re-spawns.
    const agents = asArray(data.inFlightAgents)
      .filter((a) => a && typeof a === 'object')
      .map((a) => {
        const type = a.subagentType ? ` [${a.subagentType}]` : '';
        const out = a.outputPath ? ` — residue: \`${a.outputPath}\`` : '';
        const at = a.spawnedAt ? ` (spawned ${a.spawnedAt})` : '';
        return `- ${a.description || '(no description)'}${type}${out}${at}`;
      })
      .join('\n') || 'None';
    const nextSteps = asArray(plan.nextSteps).map((s) => `- ${s}`).join('\n') || 'None';
    const constraints = asArray(plan.constraints).map((c) => `- ${c}`).join('\n') || 'None';
    const staleNote = 'The session was interrupted before it reported completion.';

    const orphanNote = data._orphanSweep && (data._orphanSweep.scratch || data._orphanSweep.worktrees)
      ? `\n> ⚠️ A prior worker was killed and left artifacts behind — CoalHearth swept ${data._orphanSweep.scratch || 0} scratch file(s) / ${data._orphanSweep.worktrees || 0} stale worktree(s). **Partial work from those killed workers is unrecoverable** (they journaled nothing); re-run any missing sub-task from scratch.`
      : '';

    // recovery.stashUnsavedChanges (default true): advise stashing before continuing.
    // Advisory text only — the hook NEVER runs `git stash` itself (Phoenix #5, zero
    // side-effects). Setting it false drops this line (audit 2026-07-02 L7 — was inert).
    const stashNote = this.recovery.stashUnsavedChanges === false
      ? ''
      : '\n> Before continuing, consider `git stash` (or a WIP commit) to protect any uncommitted work the interrupted session left behind.';

    // GC'd-transcript detection. data.transcriptPath = the aborted session's CC transcript,
    // recorded at journal-write time. CC hard-`unlink()`s transcripts on a version-dependent
    // retention sweep (field: a ~4-day-old one was already gone; the "30-day" default is not
    // reliable — GH#59248 drift + a startup-only GC). If it's gone, `claude --resume` for this
    // session is dead, so the block must NOT imply a live resume path — say it's GC'd and route
    // deeper recovery to CoalWash's estate index (the CH×CW seam), degrade-safe if CW is absent.
    // Read-only (fs.statSync — no read of content, no write, no delete through the path).
    let transcriptGone = false;
    if (typeof data.transcriptPath === 'string' && data.transcriptPath) {
      try {
        fs.statSync(data.transcriptPath); // present -> the resume path is still alive
      } catch (err) {
        if (err && err.code === 'ENOENT') transcriptGone = true; // truly absent -> GC'd
        // any other stat error (EACCES, a glitch) -> leave false; never cry "GC'd" on a fluke
      }
    }
    const transcriptNote = transcriptGone
      ? `\n> ⚠️ The Claude Code transcript for this session (\`${data.transcriptPath}\`) has been **garbage-collected** — CC's transcript retention is version-dependent, not the guaranteed 30 days its docs imply, so \`claude --resume\` for this session will not work. **The journal below is your recovery source.** If a needed fact predates or slipped past the journal and **CoalWash** is installed, dig the archived transcripts (read-only): \`node <CoalWash>/scripts/lib/cli.mjs estate-search <topic>\` then \`estate-restore\` — skip if CoalWash is not installed.`
      : '';

    return `> [!IMPORTANT]
> **CoalHearth Warm-Resume Recovery**
> Session \`${data.sessionId || 'unknown'}\` (last update: ${data.timestamp || 'unknown'}) looks interrupted.
> ${staleNote} **Do not blind-trust this snapshot** — verify it against the actual repo state (\`git status\`, \`git diff\`) before continuing; the journal may be stale or half-applied.${transcriptNote}${orphanNote}${stashNote}

### Goal
${plan.goal || 'N/A'}

### Checklist
${checklist}

### Modified files (VERIFY against git before trusting)
${files}

### In-flight subagents at interruption (verify/re-spawn as needed)
${agents}

### Planned next steps
${nextSteps}

### Constraints
${constraints}

Verify the above against the working tree, then continue — or restart the task if the state looks unreliable.
`;
  }

  /**
   * Resume-time SCOPED sweep of orphan artifacts a killed worker left behind
   * (MEMORY.md Incident B). SAFE by construction: only known name patterns, only
   * inside the SCRATCH_DIRS/WORKTREE_DIRS allow-list, only resolve-and-contained
   * under `workspaceRoot`. NEVER a blind recursive delete. Fail-silent.
   * @param {string} [workspaceRoot] the project root. Omitted (what both shipped hooks
   *   now pass) -> the RESOLVED project root, never raw process.cwd(): the phantom-slug
   *   anchor (hooks-safety.md §8) binds this delete path exactly as it binds the journal
   *   write, or a drifted cwd aims the two at different trees and a killed worker's
   *   orphans under the real project are never collected. No project -> no-op.
   * @returns {{scratch: number, worktrees: number}} counts removed.
   */
  sweepOrphans(workspaceRoot) {
    const anchored = workspaceRoot === undefined ? findWorkspaceRoot(process.cwd()) : workspaceRoot;
    if (!anchored) return { scratch: 0, worktrees: 0 }; // no real project boundary -> nothing to sweep
    let root = path.resolve(anchored);
    // .native, not plain (node/runtime.md §4, superseding the older plain-variant
    // wording): plain leaves an 8.3 alias and a mis-cased spelling untouched, so a plain
    // root against the .native candidates below would spell one directory two ways.
    // Resolving the root is needed for LEGIT sweeps too (os.tmpdir/macOS is a symlink),
    // not only to catch escapes.
    try {
      root = fs.realpathSync.native(root);
    } catch {
      // root unresolvable -> candidates will fail realpath too -> sweep is a no-op
    }
    let scratch = 0;
    let worktrees = 0;

    // resolve-and-contain, PHYSICAL: realpath the candidate — a lexical path.resolve
    // catches `..` but NOT a symlink escape (a scratch dir symlinked outside root
    // still LOOKS under root lexically; caught live by CI on the beta.2 push).
    // Both root and candidate go through the SAME canonicalizer (.native) so the
    // comparison is like-for-like — upgrading one side alone refuses every legit sweep.
    const contained = (p) => {
      let real;
      try {
        real = fs.realpathSync.native(p);
      } catch {
        return false; // unresolvable (absent/broken link) -> never touch it
      }
      const rel = path.relative(root, real);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    for (const relDir of SCRATCH_DIRS) {
      const dir = path.join(root, relDir);
      if (!contained(dir)) continue;
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // dir absent -> nothing to sweep
      }
      for (const name of names) {
        if (!SCRATCH_FILE_RE.test(name)) continue;
        const file = path.join(dir, name);
        if (!contained(file)) continue;
        try {
          if (fs.statSync(file).isFile()) {
            fs.rmSync(file, { force: true });
            scratch++;
          }
        } catch {
          // best-effort; a locked file just stays, non-fatal
        }
      }
    }

    for (const relDir of WORKTREE_DIRS) {
      const base = path.join(root, relDir);
      if (!contained(base)) continue;
      let names;
      try {
        names = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!STALE_WORKTREE_RE.test(name)) continue;
        const wt = path.join(base, name);
        if (!contained(wt)) continue;
        try {
          if (fs.statSync(wt).isDirectory()) {
            fs.rmSync(wt, { recursive: true, force: true });
            worktrees++;
          }
        } catch {
          // best-effort
        }
      }
    }

    return { scratch, worktrees };
  }
}

module.exports = { ResumeEngine };
