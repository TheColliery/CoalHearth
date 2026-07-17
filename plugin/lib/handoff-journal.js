// CoalHearth HandoffJournal — the recovery core (COALHEARTH_BLUEPRINT.md §3B, DESIGN.md §5 FMEA).
// Zero-dep (fs/path only), fail-silent (per hooks-safety.md Phoenix-13): never throws.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { containedOutputDir } = require('./contained-dir.js');

const JOURNAL_NAME = 'session_handoff.json';
const CORRUPT_NAME = 'session_handoff.corrupt.json'; // forensic quarantine (shared with resume-engine.js)
const LOCK_NAME = 'session_handoff.json.lock';
const RETRY_BASE_MS = 20; // ponytail: tiny sync backoff, not a real scheduler
const MAX_RETRIES = 5; // hard clamp: save() runs on the PostToolUse hot-path and
// _sleepSync is a SYNCHRONOUS busy-wait, so an untrusted `.coalhearth.json` with a
// huge atomicityRetries would spin the hook for seconds per tool call (audit
// 2026-07-02 MED: retries:50 → 25.5s). Total backoff is bounded by
// RETRY_BASE_MS × Σ(1..MAX_RETRIES-1) = 20×10 = 200ms worst-case.
// The RMW lock (updateUnderLock, H1 lost-update fix): a real load→merge→save critical
// section is a few small sync fs ops (~1-5ms). A lock older than LOCK_STALE_MS is therefore
// a CRASHED holder → steal it (1s >> any real section, so a live holder is never falsely
// stolen); a live waiter polls (Atomics.wait, no CPU burn) up to LOCK_WAIT_MS then proceeds
// LOCK-FREE best-effort. 500ms comfortably serializes a realistic fan-out (10 agents ≈ 50ms;
// the crash-test's reachable case) with headroom, and the non-spinning sleep makes the wait
// free on the happy path. Beyond ~20 truly-simultaneous writers the fallback may still drop
// one — far past any reachable concurrency; the alternative (unbounded wait) risks a hang.
const LOCK_STALE_MS = 1000;
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 4;
// CoalHearth-owned transient junk the ENOSPC prune may drop for headroom. Allow-list,
// NOT delete-all: excludes session_handoff.json (the journal), *.corrupt.json (the
// forensic quarantine) and *.lock (a live RMW lock) by construction. `.tmp` covers the
// per-pid session_handoff.json.<pid>.tmp write leftovers.
const PRUNABLE_RE = /^(?:error\.log|.*\.tmp)$/;

// Atomic single-file write via a PER-PID temp + rename. Per-pid (not a fixed name, not
// random — Phoenix #8 determinism) because two PROCESSES are the only real concurrency
// (Node is single-threaded; one process's saves are sequential), so pid uniquely
// disambiguates writers → two concurrent saves never truncate each other's temp (H6/H7).
// Fail-silent boolean. Shared by save(), ResumeEngine.markResumed and _quarantine so every
// journal write is atomic (a torn half-write is exactly the corruption H2 then has to clean).
function atomicWriteJournal(dir, name, content) {
  const target = path.join(dir, name);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch (_) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    return false;
  }
}

class HandoffJournal {
  /**
   * @param {Object} config journal config ({ outputDirectory, atomicityRetries }).
   * @param {string} [root] workspace root the outputDirectory is realpath-contained
   *   under (default process.cwd()). An untrusted project `.coalhearth.json`
   *   outputDirectory escaping root clamps to the default owned dir; if even that
   *   fails containment, outputDir is null and save()/load()/prune no-op
   *   (fail-closed — audit 2026-07-02 MED, see lib/contained-dir.js).
   */
  constructor(config, root) {
    this.config = config || {};
    this.outputDir = containedOutputDir(this.config.outputDirectory, root);
    // Clamp to [1, MAX_RETRIES]: a non-positive/absent value -> 3 (default), an
    // over-large one -> MAX_RETRIES, so the synchronous busy-wait backoff stays bounded.
    const wanted = Number.isInteger(this.config.atomicityRetries) && this.config.atomicityRetries > 0
      ? this.config.atomicityRetries
      : 3;
    this.retries = Math.min(wanted, MAX_RETRIES);
  }

  /**
   * Best-effort read of the last saved journal. Returns the parsed object or
   * null on any failure (absent, corrupt, uncontained dir) — never throws.
   */
  load() {
    if (!this.outputDir) return null;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.outputDir, JOURNAL_NAME), 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Atomically persist session state. Returns true on success, false on
   * failure — never throws (fail-silent).
   * @param {Object} state
   */
  save(state) {
    if (!this.outputDir) return false; // fail-closed: no contained dir -> never write
    const targetPath = path.join(this.outputDir, JOURNAL_NAME);
    const tempPath = `${targetPath}.${process.pid}.tmp`; // per-pid: two concurrent writers never collide on one temp (H6/H7)

    let payload;
    try {
      payload = JSON.stringify(
        { timestamp: new Date().toISOString(), ...state },
        null,
        2
      );
    } catch (_) {
      return false; // unserializable state (circular refs etc.) — nothing to write
    }

    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        fs.writeFileSync(tempPath, payload, 'utf8');
        fs.renameSync(tempPath, targetPath);
        return true;
      } catch (err) {
        if (err && err.code === 'ENOSPC') {
          this._pruneOldLogs();
          continue; // retry once space is freed; still bounded by `retries`
        }
        this._sleepSync(RETRY_BASE_MS * (attempt + 1)); // backoff on EBUSY/EACCES/etc.
      }
    }
    return false;
  }

  /**
   * Atomic read-modify-write of the journal under a per-dir lock (H1 lost-update fix).
   * Loads the current journal (quarantining a corrupt one — H2), hands it to mergeFn, and
   * saves the result — the whole load→merge→save inside ONE lock, so N concurrent
   * PostToolUse hooks can no longer clobber each other's accumulated modifiedFiles/
   * inFlightAgents (last-save-wins). Fail-silent: never throws.
   * @param {(prior: Object|null) => Object} mergeFn builds the new state from the prior.
   * @returns {boolean} save()'s result (false if no contained dir or the write failed).
   */
  updateUnderLock(mergeFn) {
    if (!this.outputDir) return false; // fail-closed: no contained dir -> nothing to write
    const release = this._acquireLock();
    try {
      const prior = this._loadOrQuarantine();
      let state;
      try {
        state = mergeFn(prior);
      } catch (_) {
        return false; // a hostile prior shape must never crash the hook (fail-silent)
      }
      return this.save(state);
    } finally {
      release();
    }
  }

  /**
   * Like load(), but a CORRUPT (present-but-unparseable) journal is QUARANTINED to
   * session_handoff.corrupt.json (preserving the bytes) before returning null — so the RMW
   * starts fresh WITHOUT destroying the forensic evidence (H2; mirrors ResumeEngine._quarantine,
   * which the OTHER read path already did). An absent journal -> null (a normal fresh start).
   * Never throws.
   */
  _loadOrQuarantine() {
    if (!this.outputDir) return null;
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.outputDir, JOURNAL_NAME), 'utf8');
    } catch (_) {
      return null; // absent -> fresh session
    }
    try {
      const data = JSON.parse(raw);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) {
      // corrupt: preserve the bytes aside (atomic), then start fresh. save() overwrites the
      // corrupt journal next; the quarantine keeps the evidence a plain overwrite would erase.
      atomicWriteJournal(this.outputDir, CORRUPT_NAME, raw);
      return null;
    }
  }

  /**
   * Best-effort exclusive lock for the load→merge→save critical section (H1). The O_EXCL
   * (`wx`) create IS the atomic latch. A STALE lock (older than LOCK_STALE_MS = a crashed
   * holder; real sections are ~ms) is stolen; if the lock is still held after LOCK_WAIT_MS
   * the caller proceeds LOCK-FREE — journaling this step best-effort beats losing it, and
   * save() is atomic regardless, so the worst case is the rare lost-update this lock exists
   * to make rarer, never a torn file. Returns a release() (a no-op when it went lock-free).
   * ponytail: file-lock + stale-break + bounded wait; enough for short-lived (<100ms) hooks.
   */
  _acquireLock() {
    const noop = () => {};
    if (!this.outputDir) return noop;
    const lockPath = path.join(this.outputDir, LOCK_NAME);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // atomic acquire
        return () => { try { fs.rmSync(lockPath, { force: true }); } catch (_) {} };
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return noop; // unlockable (perms/etc.) -> lock-free
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockPath, { force: true }); // crashed holder -> steal + retry
            continue;
          }
        } catch (_) { continue; } // lock vanished between calls -> retry the create
        if (Date.now() >= deadline) return noop; // bounded -> proceed lock-free (best-effort)
        this._sleepSync(LOCK_POLL_MS);
      }
    }
  }

  // Non-spinning synchronous sleep for backoff + lock polling — fine here: hooks are
  // short-lived CLI processes, not a server event loop. Atomics.wait (Node permits it on the
  // main thread, unlike a browser) blocks WITHOUT burning CPU — a busy-wait would saturate the
  // CPU under lock contention and slow every holder's critical section, making the lock LESS
  // effective. Zero-dep (JS built-in), deterministic. Falls back to a bounded busy-wait only
  // if SharedArrayBuffer is disabled in some sandbox. ponytail: no setTimeout/promise needed.
  _sleepSync(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
    } catch (_) {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* busy-wait, bounded by the caller */ }
    }
  }

  // FMEA "Disk Quota Exceeded": free space for the journal retry by deleting ONLY
  // CoalHearth-owned transient junk (error.log, *.tmp leftovers) — an ALLOW-LIST, not
  // a blind delete-all (audit 2026-07-02 HIGH). Two containment layers: the
  // constructor already realpath-contains outputDir under the WORKSPACE root (so an
  // untrusted `{journal:{outputDirectory:"../secrets"}}` never anchors the prune
  // outside it — audit 2026-07-02 MED, round 2), and every target here is
  // realpath-and-contained inside outputDir (same discipline as resume-engine.js
  // sweepOrphans) so a symlinked FILE inside the dir can't redirect an unlink out.
  // We deliberately KEEP the *.corrupt.json forensic quarantine and any unrecognized file.
  _pruneOldLogs() {
    if (!this.outputDir) return; // fail-closed: no contained dir -> nothing to prune
    try {
      let root;
      try {
        root = fs.realpathSync(this.outputDir); // physical (tmpdir/macOS is a symlink)
      } catch (_) {
        return; // unresolvable owned dir -> nothing safe to prune, fail-closed
      }
      // resolve-and-contain PHYSICALLY: realpath the candidate so a symlink escape
      // (a name symlinked outside root that still looks contained lexically) is caught.
      const containedInRoot = (p) => {
        let real;
        try {
          real = fs.realpathSync(p);
        } catch (_) {
          return false; // absent/broken link -> never touch it
        }
        const rel = path.relative(root, real);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      };
      for (const name of fs.readdirSync(root)) {
        if (!PRUNABLE_RE.test(name)) continue; // allow-list: only owned transient junk
        const target = path.join(root, name);
        if (!containedInRoot(target)) continue; // fail-closed on any escape
        try {
          if (fs.statSync(target).isFile()) fs.unlinkSync(target);
        } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = { HandoffJournal, atomicWriteJournal, JOURNAL_NAME, CORRUPT_NAME };
