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

const JOURNAL_FILE = 'session_handoff.json';
const CORRUPT_FILE = 'session_handoff.corrupt.json';
const RESUMABLE_STATUSES = new Set(['in_progress', 'limit_reached']);

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
   */
  constructor(config) {
    this.config = config || {};
    this.outputDir = path.resolve(this.config.outputDirectory || '.claude/coalhearth');
  }

  /**
   * Detects a resumable session left behind by a prior run.
   * @returns {Object|null} the parsed journal, or null if none / not resumable.
   */
  detectAbortedSession() {
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
      fs.writeFileSync(path.join(this.outputDir, CORRUPT_FILE), raw, 'utf8');
      fs.rmSync(journalPath, { force: true });
    } catch {
      // ponytail: best-effort cleanup; a stuck corrupt file is still non-fatal,
      // detectAbortedSession's JSON.parse guard keeps every future boot clean too.
    }
  }

  /**
   * Builds the markdown recovery block injected into the next session's context.
   * @param {Object} data The parsed journal state from detectAbortedSession().
   * @returns {string} markdown, or '' if data is missing.
   */
  generateHandoffPrompt(data) {
    if (!data) return '';

    const plan = data.activePlan || {};
    const checklist = (data.checklist || [])
      .map((item) => `- [${item.status === 'done' ? 'x' : item.status === 'doing' ? '/' : ' '}] ${item.task}`)
      .join('\n') || 'None';
    const files = (data.modifiedFiles || []).map((f) => `- \`${f}\``).join('\n') || 'None';
    const nextSteps = (plan.nextSteps || []).map((s) => `- ${s}`).join('\n') || 'None';
    const constraints = (plan.constraints || []).map((c) => `- ${c}`).join('\n') || 'None';
    const staleNote = data.status === 'limit_reached'
      ? 'The session hit its budget limit mid-work — some listed files may be partially edited.'
      : 'The session was interrupted before it reported completion.';

    const orphanNote = data._orphanSweep && (data._orphanSweep.scratch || data._orphanSweep.worktrees)
      ? `\n> ⚠️ A prior worker was killed and left artifacts behind — CoalHearth swept ${data._orphanSweep.scratch || 0} scratch file(s) / ${data._orphanSweep.worktrees || 0} stale worktree(s). **Partial work from those killed workers is unrecoverable** (they journaled nothing); re-run any missing sub-task from scratch.`
      : '';

    return `> [!IMPORTANT]
> **CoalHearth Warm-Resume Recovery**
> Session \`${data.sessionId || 'unknown'}\` (last update: ${data.timestamp || 'unknown'}) looks interrupted.
> ${staleNote} **Do not blind-trust this snapshot** — verify it against the actual repo state (\`git status\`, \`git diff\`) before continuing; the journal may be stale or half-applied.${orphanNote}

### Goal
${plan.goal || 'N/A'}

### Checklist
${checklist}

### Modified files (VERIFY against git before trusting)
${files}

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
   * @param {string} [workspaceRoot] the project root (default process.cwd()).
   * @returns {{scratch: number, worktrees: number}} counts removed.
   */
  sweepOrphans(workspaceRoot = process.cwd()) {
    const root = path.resolve(workspaceRoot);
    let scratch = 0;
    let worktrees = 0;

    // resolve-and-contain: a candidate must stay strictly under root (path.relative
    // must not start with '..' or be absolute — catches both `..` and symlink escapes
    // on Windows and POSIX; a bare split('/') would miss `\`).
    const contained = (p) => {
      const rel = path.relative(root, path.resolve(p));
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
