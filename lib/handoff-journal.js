// CoalHearth HandoffJournal — the recovery core (COALHEARTH_BLUEPRINT.md §3B, DESIGN.md §5 FMEA).
// Zero-dep (fs/path only), fail-silent (per hooks-safety.md Phoenix-13): never throws.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_NAME = 'session_handoff.json';
const RETRY_BASE_MS = 20; // ponytail: tiny sync backoff, not a real scheduler
const MAX_RETRIES = 5; // hard clamp: save() runs on the PostToolUse hot-path and
// _sleepSync is a SYNCHRONOUS busy-wait, so an untrusted `.coalhearth.json` with a
// huge atomicityRetries would spin the hook for seconds per tool call (audit
// 2026-07-02 MED: retries:50 → 25.5s). Total backoff is bounded by
// RETRY_BASE_MS × Σ(1..MAX_RETRIES-1) = 20×10 = 200ms worst-case.
// CoalHearth-owned transient junk the ENOSPC prune may drop for headroom. Allow-list,
// NOT delete-all: excludes session_handoff.json (the journal) and *.corrupt.json (the
// forensic quarantine) by construction. `.tmp` covers the session_handoff.json.tmp leftover.
const PRUNABLE_RE = /^(?:error\.log|.*\.tmp)$/;

class HandoffJournal {
  constructor(config) {
    this.config = config || {};
    this.outputDir = path.resolve(this.config.outputDirectory || '.claude/coalhearth');
    // Clamp to [1, MAX_RETRIES]: a non-positive/absent value -> 3 (default), an
    // over-large one -> MAX_RETRIES, so the synchronous busy-wait backoff stays bounded.
    const wanted = Number.isInteger(this.config.atomicityRetries) && this.config.atomicityRetries > 0
      ? this.config.atomicityRetries
      : 3;
    this.retries = Math.min(wanted, MAX_RETRIES);

    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
    } catch (_) {}
  }

  /**
   * Atomically persist session state. Returns true on success, false on
   * failure — never throws (fail-silent).
   * @param {Object} state
   */
  save(state) {
    const targetPath = path.join(this.outputDir, JOURNAL_NAME);
    const tempPath = targetPath + '.tmp';

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

  // Blocking sync sleep for backoff — fine here: hooks are short-lived CLI
  // processes, not a server event loop. ponytail: no setTimeout/promise needed.
  _sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy-wait, bounded to a few tens of ms */
    }
  }

  // FMEA "Disk Quota Exceeded": free space for the journal retry by deleting ONLY
  // CoalHearth-owned transient junk (error.log, *.tmp leftovers) — an ALLOW-LIST, not
  // a blind delete-all. Root + every target are realpath-and-contained BEFORE any
  // unlink (same discipline as resume-engine.js sweepOrphans), so an untrusted
  // `.coalhearth.json` `{journal:{outputDirectory:"../secrets"}}` cannot aim the prune
  // outside the owned journal dir on ENOSPC (audit 2026-07-02 HIGH). We deliberately
  // KEEP the *.corrupt.json forensic quarantine and any unrecognized file.
  _pruneOldLogs() {
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

module.exports = { HandoffJournal };
