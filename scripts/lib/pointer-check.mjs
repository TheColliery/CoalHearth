// CWK-075 — POINTER gate, CoalHearth's adoption. Ship-text names something that cannot be
// reached from a clone.
//
// NOT CWK-060's GATE. That one resolves config KEYS against config-schema.mjs. These are
// POINTERS — to a file or a directory — and nothing resolved them here before this module.
// Same family, different resolver: the key gate asks "is this name in the schema", this one
// asks "is the thing this name points at REACHABLE FROM A CLONE".
//
// THREE STATES, NOT TWO. tracked -> silent · GITIGNORED -> FAIL · existing-but-UNTRACKED ->
// FAIL. "Exists" is not "reachable": from any other machine a gitignored path and a missing
// one are indistinguishable, so such a citation was never durable — not even on the day it
// was written.
//
// SCRIPTS/ COMMENTS ARE NOW A WALKED SURFACE — SUPERSEDED, CWK-090 fix 3 (r30's own residue
// sentence, corrected). r30 read this as CoalMine's variable set imported unchecked and
// declared it out; main ruled the OTHER way — the surface list is a declared INPUT, the
// DEFAULT includes script comments, and a room narrows it only by deleting a row and stating
// the reason in that row's own `why` (DEFAULT_SURFACE_PLAN, below), never by a silent module
// comment. So: a backticked path written into a comment in THIS file, verify.mjs, or any
// `.mjs`/`.js` file under scripts/, bin/, or lib/ IS a citation this gate now checks — the
// self-reference hazard the rest of this header already names for its own MEASURED-numbers
// section applies here identically. See DEFAULT_SURFACE_PLAN for the one deliberate
// narrowing kept (test files' own comments, excluded with its own reason).
//
// ============================================================================
// MEASURED ON THIS ROOM'S OWN SURFACES BEFORE ANY OF IT WAS CHOSEN. Re-derive with the
// block in verify.mjs; never quote these numbers forward.
//
//   320 backticked tokens (fenced code stripped FIRST)
//    -> 64 survive the shape funnel
//    -> 52 IN SCOPE
//    -> 51 resolve, 1 unresolved = 1.9% first reading.
//
//   THE ONE UNRESOLVED WAS A REAL FINDING ABOUT THE INSTRUMENT, NOT ABOUT THE TREE, and it
//   is the collision the exemplar warns about, live here: `platform-configs/hooks/README.md`
//   cites `.github/hooks/coalhearth.json` — GitHub Copilot CLI's hook-install home IN THE
//   USER's tree — while `.github/workflows/` is genuinely ours. Same root, opposite owner,
//   indistinguishable from the token alone. It is excluded as a vendor home below, and the
//   declaration REMOVES the citation from scope rather than turning it into a resolving one:
//   52 in scope -> 1 declared out -> 51 checked, 51 resolving. Measured both ways with this
//   module (with VENDOR_HOMES: checked 51, findings 0; without it: checked 52, findings 1),
//   and the gate's own pass line already prints 51. An earlier wording here said "52 in scope
//   / 52 resolving", which is a number the instrument does not produce -- a re-derivation
//   landing on 51 would have read as a regression against a figure that was never real.
//   A false number inside the comment block of a gate whose family exists to stop false
//   ship-text is the sharpest version of this class (INSPECT MEDIUM).
//
//   A bad first reading is evidence about the instrument before it is evidence about the
//   room. This one was, and lowering the bar was never the alternative.
//
// ============================================================================
// THE CIRCULAR-COUNT QUESTION, answered with a NUMBER rather than an assertion: the same
// in-scope token must produce a `checked` count that does NOT move with the verdict, or
// membership and verdict are one predicate and the gate can never fire. Measured across
// four resolve() answers for one token — checked 1/1/1/0, findings 0/1/1/0 — so `checked`
// is stable while the verdict moves, except in the deliberately-out-of-scope case. The
// test file drives exactly that.
//
// AND THE GATE HAS FIRED: its first run over this room's real surfaces produced the
// `.github/hooks` finding above. A gate that has never fired has not been shown to be
// capable of firing.
//
// ============================================================================
// NAMED BLIND SPOT — stated as what is UNCOVERED with its measured cost, never as a denial.
//
//   AN UNBACKTICKED PATH IS INVISIBLE. Extraction keys on backticks, so a path named in
//   plain prose is never a candidate. MEASURED, and the order of operations is part of the
//   measurement: strip fenced blocks FIRST, then drop links whose backticked LABEL equals
//   the target (those ARE covered — through the label), then mask remaining backticked
//   spans, then grep. Raw grep says 19; 19 of those are link targets already covered
//   through their own backticked label, so the genuinely uncovered population is ONE — a
//   single link target in README.md whose label differs from its path. That is the cost.
//
//   THE SYMBOL AND SECTION HALVES ARE NOT MECHANISED, by the chair's ruling on two
//   all-false measurements in sibling rooms. Nothing here checks a §Heading or a renamed
//   identifier, and the pass line says so.
//
// ============================================================================
// ADOPTER CONTRACT — DATA, never LOGIC. Nothing below hardcodes any room's layout; the
// caller supplies its own surfaces, ourRoots, ignoredRoots, agentHomes, hasEntry, resolve
// and pending list, all read out of its own tree.

// A path this room deliberately points at BEFORE it exists. Ships EMPTY, and the empty list
// is a MEASUREMENT (52 of 52 in-scope citations resolve), not an omission.
//
// The mechanism ships anyway, with a reason rather than as padding: without an escape hatch
// the first legitimate forward pointer hard-FAILs, and the cheapest way to make a FAIL go
// away is to delete the gate. EVENT-based expiry, same as the key gate's lists — a
// declaration is pruned by what BECOMES TRUE, never by a date nobody re-reads.
export const PENDING_POINTERS = [
  // { path: 'scripts/lib/thing.mjs', reason: 'CWK-000 — landing next unit' },
];

// A VENDOR INSTALL HOME this room's shipped prose names in the USER's tree. DECLARED, not
// derived, and the asymmetry is stated rather than hidden: this room CAN derive its config
// homes (`.claude`/`.agents`/`.gemini` come out of projectConfigCandidates, so they cannot
// rot when that order changes) and CANNOT derive its HOOK homes — there is no map to derive
// them from, the wiring templates carry no install path as data, and the only place they
// appear is the prose being checked, which would make the exclusion circular.
//
// So this list is hand-written, and every entry carries the vendor it belongs to. It is
// short by construction: a first segment that is not a top-level entry of ours (`.devin`,
// `.gemini` as a bare root) falls out of scope on its own; only a path that COLLIDES with a
// real root of ours needs declaring.
export const VENDOR_HOMES = [
  { path: '.github/hooks', reason: 'GitHub Copilot CLI hook home in the USER tree; `.github/workflows/` is ours, same root' },
];

// SURFACE PLAN, DECLARED (CWK-090 fix 3, findings-back r30/r31). "scripts/ comments are
// NOT a walked surface here" was this room's own r30 finding, and it stood only until main
// ruled the other way: the surface list is a DECLARED INPUT of the gate, the DEFAULT is the
// exemplar's (docs + script comments — a stale pointer in a comment misleads the next reader
// exactly as one in a doc does), and a room that narrows it DELETES the row and states the
// reason in that row's OWN `why`, never by leaving the row out silently or editing the
// driver. This room ADOPTS THE DEFAULT: measured population of path-shaped comment citations
// across scripts/bin/lib before adopting = 7 "unresolved" against a crude probe, but every
// one is an agent home (`.claude/`, `.agents/`) or a vendor home (`.github/hooks`, from
// VENDOR_HOMES above) that the crude probe does not hold out — the REAL gate (agentHomes +
// vendorHomes) reads 0 residue (re-derive with verify.mjs's own pass line, never trust this
// sentence forward).
//
// THE NARROWING FORM, one sentence an adopter copies rather than guesses: a room that walks
// fewer surfaces DELETES the row and states its reason in the row's own `why`, never by
// editing `collectSurfaces` or leaving the row in place unused. TWO deliberate narrowings
// from the exemplar's own default, stated here rather than silently: (1) this room does not
// add a `.github/ISSUE_TEMPLATE` row or a `.ps1`-comment row (the exemplar's PowerShell-
// fallback class) — this room ships no `.ps1` files at all (`node/runtime.md` §3's own
// bin/lib CJS, scripts/ ESM split has no PowerShell lane), so that row's precondition does
// not exist here; (2) the three comment rows' `ext` excludes `.test.` files (see each row's
// own `why`) — a test file's comments quote fixture strings, not citations.
//
// `kind` is one of four: `md` (a directory of markdown files, walked recursively, whole
// text) · `raw` (a single file's whole text, OR a directory walk with an extension filter
// and no comment-line stripping) · `comments` (a directory walk, `//`/`*`-prefixed lines
// only) · `hash-comments` (a directory walk, `#`-prefixed lines only). `dir: true` means
// `root` is a directory to walk; its absence means `root` is one exact file. `historyOnly:
// true` marks a surface `checkPointers` binds to the gitignored-root case only, never the
// ordinary resolve check (CHANGELOG.md — published history is never fixed forward).
export const DEFAULT_SURFACE_PLAN = [
  { kind: 'raw', root: 'README.md',
    why: 'the front door — every install/config claim starts here' },
  { kind: 'raw', root: 'SECURITY.md',
    why: 'the disclosure surface, and it cites internal paths (e.g. a hook line ref)' },
  { kind: 'raw', root: 'PRIVACY.md',
    why: 'the privacy surface, and it cites internal paths' },
  { kind: 'raw', root: 'CONTRIBUTING.md',
    why: 'the dev-facing surface, and it cites internal paths' },
  { kind: 'raw', root: 'platform-configs/hooks/README.md',
    why: 'the per-platform wiring doc; it names install paths in the USER tree (agent/vendor homes) and ours' },
  { kind: 'md', root: 'commands', dir: true,
    why: 'command docs are ship-text a user reads' },
  { kind: 'raw', root: 'platform-configs/.coalhearth.json',
    why: 'the factory config template a user\'s own project config starts from' },
  { kind: 'raw', root: 'CHANGELOG.md', historyOnly: true,
    why: 'published history is never fixed forward — a path correct when the entry was written is not a defect now, but a gitignored citation was never correct on any day' },
  // `.test.` FILES ARE NARROWED OUT, WITH A REASON, NOT BY SILENT SHAPE. A test file's own
  // comments quote deliberately-fake example fixtures as part of describing what the code
  // under test does with them — content ABOUT citations, never a citation itself.
  // Deliberately not naming the fixtures themselves as literals here: this comment is
  // itself a WALKED surface (scripts/, this very row), and backticking one would
  // manufacture the exact FAIL it is describing — measured live while porting this row,
  // when this file's OWN test file (pointer-check.test.mjs) tripped three such FAILs on
  // its own fixture strings before the exclusion existed, the identical self-reference
  // hazard this header already names for its measured-numbers section, one class over.
  { kind: 'comments', root: 'scripts', dir: true, ext: /^(?!.*\.test\.mjs$).*\.mjs$/,
    why: 'a path inside CODE is exercised by the tests; a path inside a COMMENT is exercised by nothing at all — adopted per CWK-090 fix 3, main\'s ruling against this room\'s own r30 finding' },
  { kind: 'comments', root: 'bin', dir: true, ext: /^(?!.*\.test\.js$).*\.js$/,
    why: 'same class as the scripts/ row — bin/ side; CJS per this room\'s own named divergence (node/runtime.md §3)' },
  { kind: 'comments', root: 'lib', dir: true, ext: /^(?!.*\.test\.js$).*\.js$/,
    why: 'same class as the scripts/ row — lib/ side; CJS per this room\'s own named divergence (node/runtime.md §3)' },
  { kind: 'hash-comments', root: '.githooks', dir: true,
    why: '.githooks/ and hooks/ are physically separate directories (AGENTS.md) — a glob scoped to hooks/** never reaches these' },
];

// COLLECT — plan-driven, DI'd fs so this module stays pure (it imports nothing today and
// must not start). `io.join`/`io.walkMd`/`io.walkSrc`/`io.read`/`io.rel` are the SAME
// filesystem primitives the caller already owns; `io.commentLines`/`io.hashComments` are the
// two comment-line filters. `io.walkMd(dir)` returns absolute `.md` paths recursively;
// `io.walkSrc(dir, keep)` returns absolute paths whose basename passes `keep(name)`. Runs the
// plan in ORDER, so a room's own surface count/order is exactly its plan's — no hidden
// reordering.
export function collectSurfaces(repo, plan, io) {
  const surfaces = [];
  for (const row of plan) {
    if (row.dir) {
      const abs = io.join(repo, row.root);
      if (row.kind === 'md') {
        for (const f of io.walkMd(abs)) surfaces.push({ label: io.rel(f), text: io.read(f) });
      } else {
        const keep = row.ext ? (n) => row.ext.test(n) : () => true;
        for (const f of io.walkSrc(abs, keep)) {
          const src = io.read(f);
          let text;
          if (row.kind === 'comments') text = src === null ? null : io.commentLines(src);
          else if (row.kind === 'hash-comments') text = src === null ? null : io.hashComments(src);
          else text = src; // 'raw' dir-walk: whole file, no comment-line filter
          surfaces.push({ label: io.rel(f), text });
        }
      }
    } else {
      const s = { label: row.root, text: io.read(io.join(repo, row.root)) };
      if (row.historyOnly) s.historyOnly = true;
      surfaces.push(s);
    }
  }
  return surfaces;
}

const GLOB = /[*?[\]{}|]/;
const OUTSIDE = /^([~/]|[A-Za-z]:|[a-z][a-z0-9+.-]*:\/\/)/;
// A `.` or `..` SEGMENT — never a dot-DIR like `.github`, which is a real name.
const DOTSEG = /(^|\/)\.\.?(\/|$)/;
// A BACKSLASH is not a separator this gate reads. DOTSEG is segment-whole for `/`-delimited
// tokens, and it does not see a BACKSLASH-delimited segment — so `scripts/..\..\escape.md`
// would survive every shape test and resolve OUTSIDE the repo. Rejecting the character
// makes the invariant unconditional (a citation in our surfaces is `/`-delimited on every
// platform) instead of platform-conditional, which is the room's own recorded lesson:
// resolve-and-contain, never segment-scan, because a scan misses `\` on Windows.
const BACKSLASH = /\\/;

// CWK-079 — looksPathShaped(tok): a SHAPE test for candidate-root DISCOVERY, never for
// judgement. A token surviving pointerCandidates() carries a `/`, but a `/` alone does not
// make it a PATH -- a backticked ratio, `prefer/should`, `try/finally` all reach here too.
// Strip a trailing `:line(-line)?` first, then accept iff the token ends in `/` (a directory
// citation) or its LAST segment carries a `.ext`-shaped suffix.
//
// GATES DISCOVERY ONLY -- feeding deriveIgnoredRoots' candidate-root set below. It is NEVER
// applied inside checkPointers, and it NEVER narrows pointerCandidates itself: a shape-
// rejected token (an extensionless real path like `scripts/lib`) is still a real citation and
// checkPointers keeps resolving it in full. See the NON-LOCALITY property at
// deriveIgnoredRoots, and the pinned regression test in pointer-check.test.mjs.
export function looksPathShaped(tok) {
  const t = tok.replace(/:\d+(-\d+)?$/, '');
  if (t.endsWith('/')) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(t.split('/').pop());
}

// CWK-079 — ignored-root discovery, EXISTENCE-INDEPENDENT by design. `.gitignore` is TRACKED,
// so `git check-ignore` answers for an ABSENT path exactly as for a present one -- the PATTERN
// is what matters, never what the caller happens to have on local disk. The predecessor of
// this function read `fs.readdirSync(repo)`, which is DEAD CODE on a clean clone: a clone
// carries no gitignored files by definition, so that branch ran at zero for every user and
// every CI leg (measured 2026-09-10: this working copy 29 fed/6 gitignored vs a fresh
// `git clone --depth 1` of the same commit, 21 fed/0 gitignored).
//
// SPLIT FROM CHECK-IGNORE (CWK-090 findings-back class, ported ahead of hitting it here):
// this function does DISCOVERY ONLY — candidateRoots/toProbe/homesHeldOut — and calls no
// git. The check-ignore CALL and its fail-open-or-populate logic live in
// applyCheckIgnoreProbe below, DI'd with `runCheckIgnore`, so a WIRING mutation (not only a
// classifier mutation) has something to redden. CoalMine's own room hit this defect class
// THREE times before separating the two concerns this way; porting the separation rather
// than re-discovering it here.
//
// NAMED BOUND (a) — FOREIGN-NAME COLLISION: a citation describing the SCANNED USER's own tree
// (an install path like `.claude/coalhearth/…`) could in principle collide with OUR OWN
// `.gitignore` pattern, the same root spelled two ways with two different owners. Narrowing
// this on existence or on `ourRoots` would re-open the exact vacuity CWK-079 closes -- a
// candidate that merely "doesn't exist locally" is precisely the case this rewrite exists to
// keep probing. The one guard that IS applied here, agent-home hold-out, runs BEFORE the
// probe rather than narrowing the probe's own logic, and is enough to close the case actually
// measured in this room: MEASURED POPULATION = 0. This room's one prior foreign-home
// collision (VENDOR_HOMES' `.github/hooks`, from CWK-075 — GitHub Copilot CLI's hook home in
// the scanned user's tree, colliding with our own tracked `.github/workflows`) never reaches
// this function at all, because `.github` is TRACKED here, not gitignored — `git check-ignore`
// answers false for it regardless of who a citation describes, and that collision is resolved
// entirely inside checkPointers' own vendor-home scope logic, a different layer.
//
// NAMED BOUND (b) — NOT-A-PATH-AT-ALL, narrowed at discovery by looksPathShaped, with the
// residue named in both directions: a trailing-slash token is accepted here with no check on
// what precedes it (git answers "not ignored" for a pattern that matches nothing, so this
// costs nothing but a wasted probe); an extensionless real path (`scripts/lib`) no longer
// contributes its OWN first segment to candidateRoots.
//
// THE NON-LOCALITY PROPERTY, and why bound (b)'s residue is not a gap: a shape-rejected token
// is NOT exempt from the check — it is still probed and can still FAIL the moment ANY OTHER
// path-shaped citation shares its first segment, because ignoredRoots is a per-ROOT set, not
// a per-TOKEN one, and checkPointers judges every in-scope token against it regardless of
// what that token's own shape looked like. Pinned as a two-plant regression test in
// pointer-check.test.mjs.
export function deriveCandidateRoots({ surfaces = [], agentHomes = new Set() }) {
  const candidateRoots = new Set();
  for (const s of surfaces) {
    if (typeof s.text !== 'string') continue;
    for (const tok of pointerCandidates(s.text)) {
      if (!looksPathShaped(tok)) continue;
      candidateRoots.add(tok.split('/')[0]);
    }
  }
  let homesHeldOut = 0;
  const toProbe = [];
  for (const root of candidateRoots) {
    if (agentHomes.has(root)) { homesHeldOut++; continue; }
    toProbe.push(root);
  }
  return { candidateRoots, toProbe, homesHeldOut };
}

// CHECK-IGNORE CLASSIFIER (CWK-090 fix 1), pure -- takes the exact shape a
// `spawnSync('git', ['check-ignore', '--stdin'], {...})` result carries and answers ONE
// question: did this run actually tell us anything? Exit 0 and exit 1 both SUCCEED (1 =
// "none of the fed paths are ignored", not an error); a spawn error or any OTHER status
// (128 included -- a bad pattern, an unreadable `.gitignore`, a broken worktree) means the
// run answered NOTHING, and the caller must not treat an empty stdout as "zero ignored".
// THE PRE-FIX code here checked only `ci.error || typeof ci.stdout !== 'string'` -- any
// non-0 status short of a spawn error fell through to "read stdout" (empty, since git wrote
// nothing useful there on a real error), silently produced an empty `ignoredRoots`, and the
// gate printed a git-derived "0 gitignored" count over a run that derived no facts at all.
export function classifyCheckIgnoreResult(ci) {
  if (ci.error) {
    return { ok: false, message: `git check-ignore --stdin failed to spawn: ${ci.error.message}` };
  }
  if (ci.status !== 0 && ci.status !== 1) {
    const stderrLine = typeof ci.stderr === 'string' ? ci.stderr.split('\n')[0].trim() : '';
    return {
      ok: false,
      message: `git check-ignore --stdin exited ${ci.status}${stderrLine ? ` -- ${stderrLine}` : ''} -- cannot tell which cited roots are gitignored`,
    };
  }
  return { ok: true, stdout: typeof ci.stdout === 'string' ? ci.stdout : '' };
}

// APPLY the check-ignore probe's verdict onto `ignoredRoots`, or FAIL loudly. Moved OUT of
// verify.mjs so a unit test drives the EXACT code verify.mjs runs, with an injected
// `runCheckIgnore` in place of a real `spawnSync` -- an inline `if (!verdict.ok) { fail(...) }
// else {...}` sitting directly in verify.mjs is exactly the shape CoalMine's own room found
// itself mutating to `if (false)` and watching the suite stay green, three times, because
// nothing exercised the branch from outside. `runCheckIgnore(input)` takes the newline-joined
// probe input and returns the same `{status, stdout, stderr, error}` shape a real `spawnSync`
// result carries.
//
// PROBE SUFFIX (CWK-090 fix 2, main's ruling, one shape): feeds `root + PROBE_SUFFIX` (a path
// UNDER the root) rather than a bare `root + '/'`. A bare-root feed can FALSELY match under a
// CRLF `.gitignore` for a root that does not exist on disk (measured by CoalFace, reproduced
// at scale by CoalMine as a cascade of false FAILs across every absent root in such a
// fixture) -- `first + '/'`'s only correct justification (git cannot infer that an ABSENT
// path is a directory, so a `dir/`-anchored pattern would not otherwise match the bare name)
// still holds for a path UNDER the root, without the bare-root shape's false-match exposure.
// Each returned line has the fixed suffix stripped to recover the root.
export function applyCheckIgnoreProbe({ toProbe, PROBE_SUFFIX, ignoredRoots, fail, runCheckIgnore }) {
  if (!toProbe.length) return;
  const ci = runCheckIgnore(toProbe.map((n) => n + PROBE_SUFFIX).join('\n') + '\n');
  const verdict = classifyCheckIgnoreResult(ci);
  if (!verdict.ok) {
    fail(verdict.message);
    return;
  }
  for (const line of verdict.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    ignoredRoots.add(t.endsWith(PROBE_SUFFIX) ? t.slice(0, -PROBE_SUFFIX.length) : t.replace(/\/$/, ''));
  }
}

// Candidate extraction. Exported so an adopter measures its OWN funnel with this instrument
// rather than re-implementing it and getting different numbers.
export function pointerCandidates(text) {
  const out = [];
  // Fenced code blocks are EXAMPLES, not prose claims about this tree.
  const prose = String(text).replace(/^```[\s\S]*?^```/gm, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1];
    if (/\s/.test(tok)) continue;          // a command or a Markdown table row, not a pointer
    if (/[<>]/.test(tok)) continue;        // <placeholder> — the author already said "not literal"
    if (GLOB.test(tok)) continue;          // a glob names a SET, not a file
    if (!tok.includes('/')) continue;      // a bare filename is the USER's repo's
    if (OUTSIDE.test(tok)) continue;       // absolute, home-relative, or a URL
    if (DOTSEG.test(tok)) continue;        // `../` navigates, it does not NAME, and it escapes
    if (BACKSLASH.test(tok)) continue;     // not a separator this gate reads — see above
    // A DOT-DIR IS NOT DROPPED HERE. Whether `.github/workflows/ci.yml` is OURS or the
    // scanned project's is TREE knowledge, not text shape, so that decision lives in
    // checkPointers where ourRoots, agentHomes and vendorHomes exist.
    out.push(tok);
  }
  return out;
}

// `docs/x.md:12` and `scripts/` both name a real thing; the line suffix and the trailing
// slash are punctuation, not part of the path.
function normalise(tok) {
  return tok.replace(/:\d+(-\d+)?$/, '').replace(/\/+$/, '');
}

export function checkPointers({
  surfaces = [],            // [{ label, text, historyOnly? }]
  ourRoots = new Set(),     // top-level names that belong to THIS repo
  ignoredRoots = new Set(), // top-level entries this repo gitignores — FILES AND HIDDEN DIRS
  agentHomes = new Set(),   // dot-dir roots this tool reads INSIDE A USER's tree (derived)
  vendorHomes = VENDOR_HOMES, // repo-relative vendor install homes that COLLIDE with our roots
  hasEntry = () => false,   // (relDir, name) => boolean
  resolve,                  // (relPath) => 'tracked' | 'untracked' | 'missing'
  pending = PENDING_POINTERS,
} = {}) {
  const findings = [];
  if (typeof resolve !== 'function') {
    findings.push({ level: 'FAIL', msg: 'pointer check: no resolve() supplied — the gate cannot answer its own question' });
    return findings;
  }
  const vendor = vendorHomes.map((v) => v && v.path).filter(Boolean);

  const cited = new Set();
  let checked = 0;

  for (const s of surfaces) {
    if (typeof s.text !== 'string') {
      // NAME what could not be read. A caller that filters unreadable surfaces out first
      // hides its own scope gap — the silent narrowing this family of gates exists against.
      findings.push({ level: 'SKIP', msg: `pointer check could not read ${s.label}` });
      continue;
    }
    const seen = new Set();
    for (const tok of pointerCandidates(s.text)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const first = tok.split('/')[0];
      const norm = normalise(tok);

      // A GITIGNORED ROOT IS THE SHARP CASE, decided WITHOUT resolving and BEFORE `pending`
      // is consulted — deliberately. A declaration can excuse a path that does not exist
      // YET; it can never launder one that exists and is unreachable from a clone.
      if (ignoredRoots.has(first)) {
        cited.add(norm);
        checked++;
        findings.push({
          level: 'FAIL',
          msg: `${s.label} cites \`${tok}\`, which lives under the gitignored \`${first}\` — not reachable from a clone. Cite the durable artefact (a commit SHA, a shipped doc) or commit the file.`,
        });
        continue;
      }

      // AN INSTALL HOME NAMES THE USER's TREE, NEVER OURS. Config homes are DERIVED by the
      // caller; vendor hook homes are declared above with the reason they cannot be.
      if (agentHomes.has(norm) || [...agentHomes].some((h) => norm.startsWith(h + '/'))) continue;
      if (vendor.some((h) => norm === h || norm.startsWith(h + '/'))) continue;

      // SCOPE — two independent structural tests, either sufficient, neither circular. A
      // repo-root-only rule SILENTLY SKIPS a token whose first segment is not a top-level
      // dir, and a skipped citation is the quieter failure than a wrongly-flagged one.
      const citerDir = s.label.includes('/') ? s.label.slice(0, s.label.lastIndexOf('/')) : '';
      const parentDir = citerDir.includes('/') ? citerDir.slice(0, citerDir.lastIndexOf('/')) : '';
      let base = null;
      if (ourRoots.has(first)) base = '';
      else if (citerDir && hasEntry(citerDir, first)) base = citerDir;
      else if (parentDir && hasEntry(parentDir, first)) base = parentDir;
      if (base === null) continue; // a path into someone else's tree
      cited.add(norm);

      // Published history is never fixed forward: a path correct when written is not a
      // defect now. Such a surface is checked for the gitignored case above and nothing else.
      if (s.historyOnly) continue;

      checked++;
      const rel = base ? base + '/' + norm : norm;
      const state = resolve(rel);
      if (state === 'tracked') continue;
      if (pending.some((p) => p && p.path === rel)) continue;
      if (state === 'untracked') {
        findings.push({ level: 'FAIL', msg: `${s.label} cites \`${tok}\`, which exists here but is UNTRACKED — a clone does not have it. Commit it, or cite the durable artefact.` });
      } else {
        findings.push({ level: 'FAIL', msg: `${s.label} cites \`${tok}\`, which does not resolve in this repo` });
      }
    }
  }

  // EVENT-based expiry, both directions. A declaration list nobody prunes becomes a
  // permanent hole with an author's name on it.
  for (const p of pending) {
    if (!p || !p.path) { findings.push({ level: 'FAIL', msg: 'PENDING_POINTERS entry has no path' }); continue; }
    if (!p.reason) { findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path} with no reason — an allowlist of bare strings is a bypass with no author` }); }
    if (resolve(p.path) === 'tracked') {
      findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path} as not-yet-existing, but it now resolves — delete the entry` });
    } else if (!cited.has(p.path)) {
      findings.push({ level: 'FAIL', msg: `PENDING_POINTERS declares ${p.path}, but no in-scope surface cites it — delete the entry` });
    }
  }

  // A VENDOR HOME that stops colliding is dead weight: if its first segment is no longer a
  // root of ours, the token falls out of scope on its own and the entry launders nothing.
  for (const v of vendorHomes) {
    if (!v || !v.path) { findings.push({ level: 'FAIL', msg: 'VENDOR_HOMES entry has no path' }); continue; }
    if (!v.reason) findings.push({ level: 'FAIL', msg: `VENDOR_HOMES declares ${v.path} with no reason — a bypass with no author` });
    if (!ourRoots.has(v.path.split('/')[0])) {
      findings.push({ level: 'FAIL', msg: `VENDOR_HOMES declares ${v.path}, but \`${v.path.split('/')[0]}\` is not a root of this repo — nothing collides, so the entry excuses nothing. Delete it.` });
    }
  }

  findings.checked = checked;
  return findings;
}
