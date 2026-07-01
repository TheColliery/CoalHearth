#!/usr/bin/env node
'use strict';
// CoalHearth SessionStart hook (Phoenix-13 hook: fail-silent, zero-dep, no network,
// no spawn, never process.exit — see hooks-safety.md). Detects a session the
// HandoffJournal marked in_progress/limit_reached and injects the ResumeEngine's
// recovery markdown on the sanctioned SessionStart channel (§13). NO-USER (a
// headless/cron invocation) is safe by construction: the hook only PRINTS —
// it never asks anything, so there's no consent step to skip.
const fs = require('node:fs');
const path = require('node:path');
const { ResumeEngine } = require('../lib/resume-engine.js');
// Shared with post-tool-use.js — both hooks MUST resolve the journal dir IDENTICALLY
// (this honors CLAUDE_CONFIG_DIR). The earlier inline copy hardcoded '.claude', so a
// custom config dir silently diverged the WRITE path (post-tool) from the READ path
// (session-start) and broke warm-resume — the whole value-prop (work-review MED #1).
const { loadConfig } = require('../lib/load-config.js');

function main() {
  const config = loadConfig();
  const engine = new ResumeEngine(config.journal || {});
  const aborted = engine.detectAbortedSession();
  if (!aborted) return;

  // Scoped resume-time orphan sweep (MEMORY.md Incident B): a killed worker leaves
  // scratch/worktree artifacts it could not clean up itself. Only fires on a real
  // resume, only removes allow-listed patterns, contained under cwd. Counts feed the
  // recovery prompt (which flags the killed workers' partial work as unrecoverable).
  try {
    aborted._orphanSweep = engine.sweepOrphans(process.cwd());
  } catch {
    // fail-silent: a failed sweep never blocks the resume
  }

  const prompt = engine.generateHandoffPrompt(aborted);
  if (prompt) console.log(prompt); // sanctioned SessionStart context-injection channel (Phoenix #13)

  // Mark resumed so the same journal doesn't re-inject every subsequent boot.
  try {
    const journalPath = path.join(engine.outputDir, 'session_handoff.json');
    fs.writeFileSync(journalPath, JSON.stringify({ ...aborted, status: 'resumed' }, null, 2), 'utf8');
  } catch {
    // fail-silent: a stuck "resumed" write just means the prompt may repeat next boot —
    // non-fatal, never blocks startup.
  }
}

try {
  main();
} catch {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
}
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
