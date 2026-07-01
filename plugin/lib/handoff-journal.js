// CoalHearth HandoffJournal — the recovery core (COALHEARTH_BLUEPRINT.md §3B, DESIGN.md §5 FMEA).
// Zero-dep (fs/path only), fail-silent (per hooks-safety.md Phoenix-13): never throws.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_NAME = 'session_handoff.json';
const RETRY_BASE_MS = 20; // ponytail: tiny sync backoff, not a real scheduler

class HandoffJournal {
  constructor(config) {
    this.config = config || {};
    this.outputDir = path.resolve(this.config.outputDirectory || '.claude/coalhearth');
    this.retries = this.config.atomicityRetries || 3;
    this.historyLimit = this.config.historyLimit || 5;

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

  // FMEA "Disk Quota Exceeded": drop everything except the core journal
  // (error.log, .tmp leftovers, corrupt quarantines) so the retry above has
  // room to write session_handoff.json.
  _pruneOldLogs() {
    try {
      const entries = fs.readdirSync(this.outputDir);
      for (const name of entries) {
        if (name === JOURNAL_NAME) continue; // keep the core json
        try {
          fs.unlinkSync(path.join(this.outputDir, name));
        } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = { HandoffJournal };
