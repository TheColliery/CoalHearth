#!/usr/bin/env node
// CoalHearth resume shim — Antigravity (AG 2.0 hooks.json) adapter, the SessionStart
// replacement. AG has NO one-shot session-start event (SessionStart is a valid name but
// never fires in the AG CLI/IDE — pilot 2026-07-12), so warm-resume rides the FIRST
// `PreInvocation` of a session, guarded so it runs EXACTLY ONCE per session.
//
// Why a guard is needed (and the journal-status transition is not enough): PreInvocation
// fires per model call (many times/session), and ag-post-tool-use.js re-writes the
// journal to `in_progress` after each tool call — so a status check alone would re-inject
// the recovery block every turn. The guard is a per-session marker file in os.tmpdir()
// (Phoenix #6 — session state in tmp, scoped by session id): first PreInvocation writes
// it and runs the resume check; every later PreInvocation of the same session sees it and
// returns immediately (the ~5ms happy path).
//
// v1.2.1 write-ordering lesson (bin/session-start.js) is PRESERVED: the guard marker is
// written BEFORE the recovery block is emitted; if that write fails (e.g. a read-only
// tmp), the block still emits but carries an honest "may repeat" note — never a silent
// re-inject-every-turn loop. Phoenix-13 throughout: fail-silent, zero-dep, no network, no
// child process, no process.exit(); the ONLY emit is the sanctioned additionalContext JSON.
//
// NOT validated live on AG: whether AG delivers PreInvocation `additionalContext` into the
// agent's context (re-prompt semantics) is pilot-UNCONFIRMED. The injection KEY is correct
// per spec; delivery is a separate later step. Nothing here claims validated-on-AG.
//
// Deliberately NOT ported: the self-update nudge that session-start.js schedules. Its
// payload ("run claude plugin update coalhearth@coalhearth") is Claude-Code-plugin-specific;
// AG installs by file-copy (~/.gemini/config/skills), so a CC plugin command would be a
// wrong instruction on AG. The AG self-update path is a separate design item, not this port.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeEngine } = require('../lib/resume-engine.js');
const { loadConfig } = require('../lib/load-config.js');
const { firstString } = require('../lib/journal-step.js');

// Deterministic djb2 (Phoenix #8: same input -> same marker name, no random/time). Turns
// an arbitrary session key (UUID or a transcript path) into a filesystem-safe token, so
// the marker name is stable across a session's turns and collision-safe between sessions.
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
  return h.toString(36);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin -> no session key -> skip below */ }
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* garbage stdin -> {} -> skip below */ }

  // The payload's `cwd` is the AUTHORITATIVE workspace — the locked spec provides it
  // precisely because AG's hook spawn cwd is NOT guaranteed to be the workspace; a
  // mismatch would silently aim the journal read/mark-resumed + sweep at the wrong dir.
  // Mechanism = one-flock with CoalWash's AG adapter: chdir ONCE at entry — safe here
  // because CommonJS requires are __dirname-anchored (cwd-independent) and every later
  // path (config walk, ResumeEngine root, sweep) is MEANT to be workspace-relative.
  // chdir-fail (absent dir) -> keep the spawn cwd, best-effort (Phoenix #12).
  const wsCwd = firstString(payload, ['cwd', 'Cwd']);
  if (wsCwd) { try { process.chdir(wsCwd); } catch { /* keep spawn cwd */ } }

  // A per-session key is REQUIRED to guarantee once-per-session (core AG fields are
  // snake_case; accept camelCase defensively). Absent -> we cannot dedupe across turns,
  // so skip silently (Phoenix #12) rather than risk re-injecting on every PreInvocation.
  const key = firstString(payload, ['session_id', 'sessionId', 'transcript_path', 'transcriptPath']);
  if (!key) return;

  // The once-per-session guard is an ATOMIC create-exclusive latch (CodeQL js/insecure-
  // temporary-file, one-flock fix 2026-07-14). The marker lives in a private per-tool
  // subdir (mode 0o700 — closes the shared-/tmp exposure on Unix, a no-op on Windows), and
  // is created with the `wx` flag (O_CREAT|O_EXCL): the write atomically FAILS with EEXIST
  // if the path already exists in ANY form (a prior turn's marker, or an attacker's planted
  // file/symlink) — that EEXIST IS the "already ran this session" signal, so it kills the
  // old check-then-write TOCTOU race AND refuses to write through a symlink target in one
  // syscall. ponytail: session-scoped, OS-tmp-cleaner reaped. AG's Stop is per-RESPONSE
  // (many/session) -> no safe per-session "completion" hook to delete it on; accumulation
  // is bounded (~one tiny file per session).
  const markerDir = path.join(os.tmpdir(), 'coalhearth');
  const marker = path.join(markerDir, `ag-resume-${hashKey(key)}.marker`);
  // Write the guard BEFORE emitting (v1.2.1 ordering). EEXIST -> this session already ran ->
  // silent return. Any OTHER failure (read-only / unwritable tmp) -> markerWritten=false:
  // the block still emits (CH's recovery payload is worth repeating) with an honest "may
  // repeat" note appended below.
  let markerWritten = true;
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '', { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return; // this session already did its resume check
    markerWritten = false;
  }

  const config = loadConfig();
  const recovery = config.recovery || {};
  const engine = new ResumeEngine(config.journal || {}, recovery);
  const aborted = engine.detectAbortedSession();
  if (!aborted) return; // nothing to resume -> silent (the once-per-session check still ran)

  // Scoped resume-time orphan sweep (MEMORY.md Incident B) — same as the CC adapter.
  try {
    aborted._orphanSweep = engine.sweepOrphans(process.cwd());
  } catch {
    // fail-silent: a failed sweep never blocks the resume
  }

  // Mark resumed FIRST (before emitting) — one-flock with bin/session-start.js, v1.2.1
  // ordering (write before print; a failed write is REPORTED, never silently repeated).
  // This is ALSO the cross-session contamination guard (rot-canary HIGH 2026-07-13):
  // lib/journal-step.js recordStep treats a prior `in_progress` journal as THIS session's
  // own accumulator — a dead session A left unmarked would leak its modifiedFiles/
  // inFlightAgents into session B's first journal save, growing unbounded across crash
  // chains. Marking `resumed` restores the status proxy's invariant. Tradeoff accepted
  // (the same one CC accepts): if THIS session dies before its first tool call, the next
  // session sees `resumed` and won't re-offer this recovery.
  let markedResumed = true;
  try {
    const journalPath = path.join(engine.outputDir, 'session_handoff.json');
    fs.writeFileSync(journalPath, JSON.stringify({ ...aborted, status: 'resumed' }, null, 2), 'utf8');
  } catch {
    markedResumed = false; // fail-silent (Phoenix #4): non-fatal, honest note below
  }

  // recovery.autoInjectPrompt (default true): false = detect + sweep + MARK RESUMED, but
  // suppress the injection (CC-adapter parity — marking must NOT be flag-gated, or the
  // contamination above returns for autoInjectPrompt:false users).
  if (recovery.autoInjectPrompt === false) return;
  let prompt = engine.generateHandoffPrompt(aborted);
  if (!prompt) return;
  if (!markerWritten) {
    prompt += '\n> ⚠️ Could not persist the once-per-session marker (a temp write failed — possibly a read-only temp dir). This recovery block may repeat on the next model call.\n';
  }
  if (!markedResumed) {
    prompt += '\n> ⚠️ Could not mark this session resumed (the journal write failed — possibly a read-only filesystem). This recovery block may repeat next session, and the interrupted session\'s file list may bleed into this session\'s journal.\n';
  }
  // The sanctioned AG context-injection channel (Phoenix #13): additionalContext JSON,
  // camelCase key (pilot-confirmed; snake_case was AG's own agent's WRONG guess).
  console.log(JSON.stringify({ additionalContext: prompt }));
}

try {
  main();
} catch {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
}
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
