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
