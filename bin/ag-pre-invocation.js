#!/usr/bin/env node
// CoalHearth resume shim — the ONE session-start entry for every non-Claude-Code hook
// platform, discriminated by an argv mode (the CoalMine v3.11 pattern: named modes are
// exact-matched BEFORE the generic-truthy AG branch, so a named mode never falls through
// into the AG shape). Claude Code keeps its own bin/session-start.js.
//
//   'SessionStart' -> Gemini CLI: a GENUINE per-session SessionStart (fires startup/
//                     resume/clear), so no marker workaround is needed — fire as-is.
//                     Emit = Gemini's NESTED {"hookSpecificOutput":{"additionalContext"}}
//                     (geminicli.com/docs/hooks/reference, verified 2026-07-15 — the flat
//                     AG shape is silently DROPPED by Gemini's SessionStart).
//   'FileCopy'     -> the CC-shaped file-copy platforms (Copilot CLI sessionStart /
//                     Devin CLI SessionStart / Kiro agentSpawn / Augment SessionStart):
//                     each has a real session-start-class event (no marker), and their
//                     hook protocols model Claude Code's — emit = the plain CC stdout
//                     block (Augment's stdout inject is doc-verified; the rest are
//                     best-guess, named in each config's $comment).
//   anything else  -> Antigravity (the shipped template passes 'PreInvocation'): the
//                     original adapter below — AG has NO one-shot session-start event
//                     (SessionStart is a valid name but never fires in the AG CLI/IDE —
//                     pilot 2026-07-12), so warm-resume rides the FIRST `PreInvocation`
//                     of a session, guarded so it runs EXACTLY ONCE per session.
//
// Why AG needs a guard (and the journal-status transition is not enough): PreInvocation
// fires per model call (many times/session), and ag-post-tool-use.js re-writes the
// journal to `in_progress` after each tool call — so a status check alone would re-inject
// the recovery block every turn. The guard is a per-session marker file in os.tmpdir()
// (Phoenix #6 — session state in tmp, scoped by session id): first PreInvocation writes
// it and runs the resume check; every later PreInvocation of the same session sees it and
// returns immediately (the ~5ms happy path). The named modes skip the guard AND the
// session-key requirement entirely — their events already fire once per session.
//
// v1.2.1 write-ordering lesson (bin/session-start.js) is PRESERVED: the guard marker is
// written BEFORE the recovery block is emitted; if that write fails (e.g. a read-only
// tmp), the block still emits but carries an honest "may repeat" note — never a silent
// re-inject-every-turn loop. Phoenix-13 throughout: fail-silent, zero-dep, no network, no
// child process, no process.exit(); the ONLY emit is each platform's one sanctioned
// stdout channel (AG = the injectSteps JSON below).
//
// NOT validated live on ANY of these platforms (tier: wired): the emit shapes follow each
// platform's primary docs, but no live session has proven delivery of the injected context
// into the agent. Nothing here claims validated-on-<platform>.
//
// Deliberately NOT ported to any mode: the self-update nudge that session-start.js
// schedules. Its payload ("run claude plugin update coalhearth@coalhearth") is
// Claude-Code-plugin-specific; every platform this file serves installs by file-copy,
// so a CC plugin command would be a wrong instruction there.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeEngine } = require('../lib/resume-engine.js');
const { findWorkspaceRoot } = require('../lib/contained-dir.js');
const { loadConfig } = require('../lib/load-config.js');
const { firstString } = require('../lib/journal-step.js');

// The argv mode table lives in the file header. Exact-match-first (CoalMine's ordering
// rule): 'SessionStart'/'FileCopy' are claimed here; ANY other value — the shipped AG
// template's 'PreInvocation', or none — is the Antigravity branch.
const MODE = process.argv[2] || '';
const GEMINI = MODE === 'SessionStart';
const FILE_COPY = MODE === 'FileCopy';

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

  // The payload names the AUTHORITATIVE workspace — AG's hook spawn cwd is NOT the
  // workspace (documented: hook cwd = the directory containing hooks.json); a mismatch
  // would silently aim the journal read/mark-resumed + sweep at the wrong dir.
  // `workspacePaths[0]` = the CURRENT AG spec's field (re-derived 2026-07-23); `cwd` is
  // kept as the legacy-AG + named-mode (Gemini/FileCopy) fallback. Mechanism = one-flock
  // with CoalFace's AG adapter: chdir ONCE at entry — safe here because CommonJS requires
  // are __dirname-anchored (cwd-independent) and every later path (config walk,
  // ResumeEngine root, sweep) is MEANT to be workspace-relative.
  // chdir-fail (absent dir) -> keep the spawn cwd, best-effort (Phoenix #12).
  const wsPaths = payload.workspacePaths;
  const wsCwd = (Array.isArray(wsPaths) && typeof wsPaths[0] === 'string' && wsPaths[0])
    ? wsPaths[0] : firstString(payload, ['cwd', 'Cwd']);
  if (wsCwd) { try { process.chdir(wsCwd); } catch { /* keep spawn cwd */ } }

  let markerWritten = true;
  if (!GEMINI && !FILE_COPY) {
    // AG only. The named modes ride a genuine once-per-session event, so they need
    // neither the key nor the marker below — a missing key must not block THEIR resume.

    // A per-session key is REQUIRED to guarantee once-per-session. `conversationId` =
    // the CURRENT spec's documented common field (re-derived 2026-07-23); the rest stay
    // defensive fallbacks (transcriptPath is also documented + per-conversation).
    // Absent -> we cannot dedupe across turns, so skip silently (Phoenix #12) rather
    // than risk re-injecting on every PreInvocation.
    const key = firstString(payload, ['conversationId', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath']);
    if (!key) return;

    // The once-per-session guard is an ATOMIC create-exclusive latch (CodeQL js/insecure-
    // temporary-file, one-flock fix 2026-07-14). The marker lives in a private per-tool
    // subdir (mode 0o700 — closes the shared-/tmp exposure on Unix, a no-op on Windows), and
    // is created with the `wx` flag (O_CREAT|O_EXCL): the write atomically FAILS with EEXIST
    // if the path already exists in ANY form (a prior turn's marker, or an attacker's planted
    // file/symlink) — that EEXIST IS the "already ran this session" signal, so it kills the
    // old check-then-write TOCTOU race AND refuses to write through a symlink target in one
    // syscall.
    // The wx flag guards the marker FILE; the subdir needs its own guard: mkdirSync(recursive)
    // SILENTLY succeeds on a PRE-PLANTED symlink at markerDir (following it, the 0o700 mode NOT
    // applied), so the wx marker would then write THROUGH it into an attacker's dir. lstatSync
    // (does NOT follow the link) rejects a symlink subdir before the write — routed to the SAME
    // per-repo branch as a marker-write failure (CF/CM fail-closed skip; CH emits with the note).
    // ponytail: session-scoped, OS-tmp-cleaner reaped. AG's Stop is per-RESPONSE
    // (many/session) -> no safe per-session "completion" hook to delete it on; accumulation
    // is bounded (~one tiny file per session).
    const markerDir = path.join(os.tmpdir(), 'coalhearth');
    const marker = path.join(markerDir, `ag-resume-${hashKey(key)}.marker`);
    // Write the guard BEFORE emitting (v1.2.1 ordering). EEXIST -> this session already ran ->
    // silent return. Any OTHER failure (read-only / unwritable tmp) -> markerWritten=false:
    // the block still emits (CH's recovery payload is worth repeating) with an honest "may
    // repeat" note appended below.
    try {
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(markerDir).isSymbolicLink()) {
        markerWritten = false; // symlink subdir: refuse to write through it; emit with the may-repeat note
      } else {
        fs.writeFileSync(marker, '', { flag: 'wx' });
      }
    } catch (err) {
      if (err && err.code === 'EEXIST') return; // this session already did its resume check
      markerWritten = false;
    }
  }

  // ownDir (namespace campaign #69+#39): this file's own mode booleans ARE the running
  // agent's identity, so they feed the SAME identity into the project-config read order
  // (lib/load-config.js's own header explains why `.claude` cannot be hardcoded here).
  // FileCopy covers 4 platforms with no clean match in the .claude/.agents/.gemini set
  // -> omit ownDir, same `.claude`-first default as today.
  const ownDir = GEMINI ? '.gemini' : (FILE_COPY ? undefined : '.agents');
  const config = loadConfig({ ownDir });
  const recovery = config.recovery || {};
  const engine = new ResumeEngine(config.journal || {}, recovery);

  // One sanctioned emit per platform (Phoenix #13), shared by the H5 note AND the recovery
  // block so both ride the right channel: Gemini's SessionStart injects ONLY via the nested
  // hookSpecificOutput field (geminicli.com/docs/hooks/reference, verified 2026-07-15 — the
  // flat AG shape is dropped there); the CC-shaped file-copy platforms take the plain stdout
  // block (bin/session-start.js's channel); AG takes the CURRENT PreInvocation output
  // contract {"injectSteps":[{"ephemeralMessage":...}]} (camelCase protojson, re-derived
  // 2026-07-23 from the installed engine's own docs — the pilot-era `additionalContext`
  // key is a DEAD LETTER there, 0 hits in the engine; no dual-emit, protojson may reject
  // an unknown field and drop the whole payload). ephemeralMessage = a transient system
  // message — the right class for a recovery block (userMessage would fabricate a user turn).
  const emit = (text) => {
    if (GEMINI) console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }));
    else if (FILE_COPY) console.log(text);
    else console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] }));
  };

  // H5: the journal dir could not be created (a FILE occupies .claude/coalhearth, or perms) —
  // warm-resume then silently no-ops FOREVER. Signal it once (AG is once-per-session-guarded
  // above; the named modes fire once natively) and stop — there is nothing to resume. Gated on
  // a REAL project existing here (hooks-safety.md §8): a stray/no-project cwd is silent and
  // expected (containedOutputDir's own auto-anchor already refused it, same as the CC hook) —
  // only warn when there IS a project and its journal dir is still blocked.
  if (!engine.outputDir && findWorkspaceRoot(process.cwd())) {
    emit('[CoalHearth] Cannot create the journal directory (.claude/coalhearth) — a file may be occupying that path. Warm-resume protection is OFF until it is cleared.');
    return;
  }
  if (!engine.outputDir) return; // no real project here -> nothing to resume, stay silent

  const aborted = engine.detectAbortedSession();
  if (!aborted) return; // nothing to resume -> silent (the once-per-session check still ran)

  // Scoped resume-time orphan sweep (MEMORY.md Incident B) — same as the CC adapter:
  // no argument, so the delete path anchors to the resolved project root rather than a
  // drifted cwd (hooks-safety.md §8). The entry chdir already put us in the workspace.
  try {
    aborted._orphanSweep = engine.sweepOrphans();
  } catch {
    // fail-silent: a failed sweep never blocks the resume
  }

  // recovery.autoInjectPrompt gates the INJECTION only; marking resumed is NOT flag-gated —
  // a dead session A left unmarked would (via the status proxy) leak its modifiedFiles/
  // inFlightAgents into session B's first journal save (rot-canary HIGH 2026-07-13). The
  // id-keyed sameSession (recordStep) is now the primary guard, but marking still stops a
  // later boot from re-detecting. CC-adapter parity.
  if (recovery.autoInjectPrompt === false) {
    engine.markResumed(aborted);
    return;
  }

  // BUILD first (H4): generateHandoffPrompt is array-coercion-safe, but mark resumed only
  // AFTER a successful build so a nothing-built path never leaves the journal 'resumed' with
  // no block. Mark BEFORE emitting (v1.2.1 ordering) via the shared ATOMIC markResumed (per-pid
  // temp+rename, H6/H7) so a read-only-fs failure is reported, never a silent re-inject loop.
  let prompt = engine.generateHandoffPrompt(aborted);
  if (!prompt) return;
  const markedResumed = engine.markResumed(aborted);
  if (!markerWritten) {
    prompt += '\n> ⚠️ Could not persist the once-per-session marker (a temp write failed — possibly a read-only temp dir). This recovery block may repeat on the next model call.\n';
  }
  if (!markedResumed) {
    prompt += '\n> ⚠️ Could not mark this session resumed (the journal write failed — possibly a read-only filesystem). This recovery block may repeat next session, and the interrupted session\'s file list may bleed into this session\'s journal.\n';
  }
  emit(prompt);
}

try {
  main();
} catch {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
}
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
