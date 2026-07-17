#!/usr/bin/env node
'use strict';
// CoalHearth SessionStart hook (Phoenix-13 hook: fail-silent, zero-dep, no network,
// no spawn, never process.exit — see hooks-safety.md). Detects a session the
// HandoffJournal marked in_progress and injects the ResumeEngine's
// recovery markdown on the sanctioned SessionStart channel (§13). NO-USER (a
// headless/cron invocation) is safe by construction: the hook only PRINTS —
// it never asks anything, so there's no consent step to skip.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeEngine } = require('../lib/resume-engine.js');
// Shared with post-tool-use.js — both hooks MUST resolve the journal dir IDENTICALLY
// (this honors CLAUDE_CONFIG_DIR). The earlier inline copy hardcoded '.claude', so a
// custom config dir silently diverged the WRITE path (post-tool) from the READ path
// (session-start) and broke warm-resume — the whole value-prop (work-review MED #1).
const { loadConfig } = require('../lib/load-config.js');

// Self-update is kind-1 (series-standard, mirrors the CoalBoard/CoalTipple conductor):
// the HOOK only SCHEDULES (a throttled, crash-safe stamp — written BEFORE the directive
// prints, so a crash never re-nags; no network ever, Phoenix #7); the AGENT verifies the
// latest tag online (the /coalhearth:update procedure) and offers the update.
function updateDue(config) {
  try {
    const u = (config && config.update) || {};
    if (String(u.updateMode || 'ask').toLowerCase() === 'off') return false;
    // Clamp on read: an out-of-range updateCheckDays silently degrades to the default
    // (14), never misbehaves — updateCheckDays:0 must NOT mean "nag every session".
    const days = (Number.isInteger(u.updateCheckDays) && u.updateCheckDays >= 1 && u.updateCheckDays <= 365) ? u.updateCheckDays : 14;
    const stamp = path.join(os.homedir(), '.claude', '.coalhearth-update-check');
    let last = 0;
    try { last = Number(String(fs.readFileSync(stamp, 'utf8')).trim()) || 0; } catch {}
    const now = Date.now();
    if (last && now - last < days * 86400000) return false; // inside the window: not due
    try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, String(now)); } catch {} // schedule: stamp the check now
    return true; // due — first run (last === 0) or the window has elapsed
  } catch { return false; }
}

function main() {
  const config = loadConfig();
  const recovery = config.recovery || {};
  const engine = new ResumeEngine(config.journal || {}, recovery);

  // H5: the journal dir could not be created (a FILE occupies .claude/coalhearth, or a perms
  // block) — save()/detectAbortedSession then silently no-op FOREVER while the user believes
  // they're protected. Say so ONCE on the sanctioned SessionStart channel (Phoenix #13 allows
  // the resume channel), where the recovery block would otherwise render.
  if (!engine.outputDir) {
    console.log('[CoalHearth] Cannot create the journal directory (.claude/coalhearth) — a file may be occupying that path. Warm-resume protection is OFF until it is cleared.');
  }

  const aborted = engine.detectAbortedSession();
  if (aborted) {
    // Scoped resume-time orphan sweep (MEMORY.md Incident B): a killed worker leaves
    // scratch/worktree artifacts it could not clean up itself. Only fires on a real
    // resume, only removes allow-listed patterns, contained under cwd. Counts feed the
    // recovery prompt (which flags the killed workers' partial work as unrecoverable).
    try {
      aborted._orphanSweep = engine.sweepOrphans(process.cwd());
    } catch {
      // fail-silent: a failed sweep never blocks the resume
    }

    // recovery.autoInjectPrompt (default true) gates the INJECTION only; marking resumed is
    // NOT flag-gated (a never-marked in_progress journal bleeds into the next session).
    if (recovery.autoInjectPrompt === false) {
      engine.markResumed(aborted);
    } else {
      // BUILD the recovery block FIRST (H4): generateHandoffPrompt is now array-coercion-safe,
      // but ordering still matters — mark resumed only AFTER a successful build, so a build that
      // somehow yields nothing does NOT leave the journal already 'resumed' with no block shown
      // (the permanently-unrecoverable bug). Mark BEFORE printing (v1.2.1 ordering) via the
      // shared ATOMIC markResumed (per-pid temp+rename, H6/H7) so a read-only-fs failure is
      // detected and the honest "may repeat" note appended — never a silent re-inject loop.
      const prompt = engine.generateHandoffPrompt(aborted);
      const markedResumed = engine.markResumed(aborted);
      let out = prompt;
      if (out && !markedResumed) {
        out += '\n> ⚠️ Could not mark this session resumed (the journal write failed — possibly a read-only filesystem). This recovery block may repeat next session.\n';
      }
      if (out) console.log(out); // sanctioned SessionStart context-injection channel (Phoenix #13)
    }
  }

  // Orthogonal to the resume path (its own off-switch is update.updateMode) — rides the
  // same sanctioned SessionStart context-injection channel.
  if (updateDue(config)) {
    console.log('[CoalHearth] [self-update due] Offer the /coalhearth:update check: web-check the latest CoalHearth tag vs the installed plugin.json version; if newer, OFFER `claude plugin update coalhearth@coalhearth`; if current, say "up to date"; if git/network is unavailable, say so and suggest updating manually later (never assume). Consent-gated; the hook only scheduled it.');
  }
}

try {
  main();
} catch {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
}
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
