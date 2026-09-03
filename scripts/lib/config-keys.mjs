// CWK-060 — documentation-vs-schema drift gate, CoalHearth's port. Every config key
// NAMED on a user-facing surface must RESOLVE in config-schema.mjs, or be declared.
//
// WHY: a flock class measured across four rooms in one night — ship-text promising a key
// the schema does not carry (CoalMine's `scanEverything`, CoalBoard's `applyConsent` help,
// CoalWash's stale `atomicWrite` comment). Invisible to every gate this room had.
//
// PORTED FROM CoalMine `0019e09` scripts/lib/config-keys.mjs — the SHAPE ports; the
// DETECTION RULE DOES NOT, and that is this port's central finding. Measured on THIS
// room's own surfaces before anything was written:
//
//   ALL THREE FIGURES BELOW ARE RE-DERIVED AT THE EXACT SCOPE THIS FILE DECLARES — the 7 IN
//   surfaces listed further down (5 hand-named docs + the two readdir'd `commands/*.md`),
//   CHANGELOG and the gitignored blueprint EXCLUDED. The first cut of this block carried
//   figures measured over a WIDER file list than the gate actually scans, and stated "19
//   candidates / 0 real" beside an enumeration of 8 names. INSPECT caught both: a count not
//   reconciled against its own list, and a measurement whose scope did not match the thing it
//   described — this gate's own defect class, committed inside the gate's own evidence block.
//   Corrected here rather than quietly restated, because a false "0 real" is exactly the
//   number that stops the next maintainer looking.
//
//     exemplar camelCase (a backticked internal-capital token) — 9 candidates / 1 real / 8 noise
//     naive dotted `X.Y`                                       — 11 candidates / 5 real / 6 noise
//     L1, X constrained to a SCHEMA CONTAINER                  — 5 candidates / 5 real / 0 noise
//
//   THE EXEMPLAR'S RULE IS STILL REJECTED, and the honest reason is the 8, not a zero. Its
//   noise is every hook-PROTOCOL name a hook-only room's docs are made of — `hookSpecificOutput`
//   `injectSteps` `ephemeralMessage` `sessionStart` `postToolUse` `agentSpawn` `transcriptPath`
//   `conversationId` — and its single real hit is `stashUnsavedChanges` (README's "Two
//   exceptions to project-wins" sentence, the ONE place this room names a key bare). REJECTING
//   IT COSTS NO COVERAGE: that same key is already reached twice, by L1 through its dotted form
//   and by L2 through the key table. So the trade is 8 permanent false positives for a token
//   two other locators already hold.
//
//   THE REASON THE PORT NEEDED A NEW RULE AT ALL IS STRUCTURAL: CoalHearth names keys in
//   DOTTED form (`recovery.autoInjectPrompt`, `update.updateMode`) because its schema is a
//   two-level object, and the exemplar's anchored KEY_SHAPE rejects any token containing a
//   `.`. Of this room's key mentions, all five distinct dotted forms are invisible to it and
//   exactly one bare mention is not.
//
//   SO DETECTION IS BY STRUCTURE, containers DERIVED FROM THE SCHEMA (no hand-kept roster).
//   The naive dotted rule's 6 unresolved are all filenames — `task.md` `hooks.json`
//   `coalhearth.json` `package.json` `verify.mjs` `test.mjs` — excluded BY CONSTRUCTION once
//   the container half must come from the schema, rather than by a roster someone maintains.
//
//   THE SAME-LINE CONFIG-MARKER FILTER, measured here as the addenda require rather than
//   inherited: it removes ZERO of the container-derived rule's candidates, because the
//   container prefix already IS the config marker — the filter is subsumed, not merely
//   unhelpful. REJECTED, and for a reason that is this room's own: adopting it would add a
//   second narrowing over a rule that has one unresolved hit in total, buying nothing and
//   risking a miss. (Four prior verdicts exist in the flock — 0 removed / 48 / 1 / 2-but-
//   drops-2-real-keys — and none of them is evidence about this room.)
//
// UNDER-FIRES BY DESIGN. A key named in BARE form in free prose is invisible to L1 — a miss
// is a bug, a flood is a dead gate, and this flock has a live cry-wolf exhibit. L3 below
// closes that for the one surface where bare mentions actually occur.
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const TICK = new RegExp('`([^`' + BS + 'n]+)`', 'g');
// A bare camelCase identifier: used ONLY by L3, on a surface where prose about anything
// else barely exists. Never applied to the doc surfaces, where it measured 0% signal.
const BARE = new RegExp(BS + 'b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)' + BS + 'b', 'g');
// A markdown table row whose FIRST cell is a single backticked token. The pipe is a
// character class, not an escape: a hand-built backslash-pipe is one keystroke from meaning
// ALTERNATION, and that bug shipped once in the exemplar.
const ROW_KEY = new RegExp('^' + BS + 's*[|]' + BS + 's*`([^`|]+)`' + BS + 's*[|]');

// A key that is NAMED but not yet IMPLEMENTED — honest disclosure is CORRECT behaviour, so
// the honest case is one line here and the dishonest case is a loud FAIL. An entry MUST
// carry its ticket or reason: an allowlist of bare strings is a bypass with no author.
// EXPIRY IS BY EVENT, never a date: rule 1 below FAILs an entry that now resolves, rule 2
// FAILs an entry no scanned surface mentions.
export const PENDING_KEYS = {
  // empty: this room names no unimplemented key on any in-scope surface (measured, L1+L2+L3).
};

// NOT a config key and never will be. DELIBERATELY A SEPARATE LIST from PENDING_KEYS —
// "planned" and "not-a-key" are different KINDS of claim and merging them lets either hide
// in one bucket. Rule 1 applies in reverse: if one of these ever becomes a real key, the
// entry is a lie and FAILs.
export const NOT_CONFIG = {
  // empty: the container-derived rule produces no never-a-key candidate on the in-scope
  // surfaces. The filename/method-call tokens a naive dotted rule would have flagged
  // (`task.md`, `fs.statSync`, `resp.status`, …) are excluded BY CONSTRUCTION — the
  // container prefix comes from the schema — rather than by a roster someone must keep.
};

// A schema key this gate's detection rules CANNOT SEE, declared with the reason it is
// accepted. MANDATORY, not optional: any schema key no locator can reach is a hard FAIL
// until it is written down here. That is what makes acquiring a blind spot impossible to do
// silently; "warns loudly" was never the requirement.
//
// EMPTY HERE, AND THE DISPATCH PREDICTED OTHERWISE — worth stating, because the prediction's
// premise is a real gap in this room. It expected at least one entry on the grounds that
// AGENTS.md's 5 Standard Systems #2 mandates a `language` key flock-wide and a lowercase word
// is undetectable. CoalHearth's schema HAS NO `language` KEY AT ALL (6 leaves, none of them
// it), so there is nothing to declare — the blind spot is absent because the mandated key is
// absent. That is a finding about the schema, not a clean bill of health, and it is recorded
// in MEMORY.md rather than silently closed here. If `language` is ever added it will fail
// this gate's precondition on the day it lands, which is the mechanism working.
export const BLIND_KEYS = {};

// A key that was REAL and has been RETIRED. Named rather than silently uncovered, per the
// sibling rail. EMPTY here BY MEASUREMENT, and the reason is worth recording so a later
// reader does not "fix" it: this room's one retired key, `journal.historyLimit` (dropped at
// v0.1.0-beta.4), is mentioned ONLY in CHANGELOG.md and COALHEARTH_BLUEPRINT.md — both OUT
// of the surface set below, the first by design and the second because it is gitignored and
// therefore not ship-text at all. Declaring it would trip rule 2 (a declaration no scanned
// surface mentions is dead weight) and correctly FAIL.
export const RETIRED_KEYS = {};

// SURFACES — each IN or OUT with the measurement behind it.
//   IN  README.md                        the Configure key table + the prose around it.
//   IN  commands/*.md                    WALKED, not enumerated: agent-facing ship-text.
//   IN  platform-configs/hooks/README.md a SHIPPED doc that lands in a user's tree.
//   IN  SECURITY.md · PRIVACY.md · CONTRIBUTING.md   measured: 1 real candidate, 0 noise.
//   IN  platform-configs/.coalhearth.json COMMENT half only (L3) — see below.
//   OUT CHANGELOG.md   it names RETIRED and PLANNED keys BY DESIGN. Measured live: 6
//       candidates, 2 unresolved (`journal.historyLimit`, `journal.jsonl`), both accurate
//       history. A gate that reddens on true history is WRONG here, not merely noisy.
//   OUT COALHEARTH_BLUEPRINT.md  GITIGNORED — a machine-local design doc, never shipped, so
//       it is not ship-text. (It carries the room's `journal.historyLimit` mention, which is
//       why the RETIRED_KEYS note above exists.)
//   OUT bin/*.js and lib/*.js NOTICE TEXT — and this exclusion is MEASURED, not assumed,
//       because the exemplar's whole hook-notice locator lives here. This room emits NO
//       user-facing string that names a config key: every key name in bin/ and lib/ is in a
//       CODE COMMENT or a property access, never inside emitted text. There is also no
//       `const TRANSLATIONS` block and no `\n};` end sentinel, so the exemplar's locator
//       would have found nothing and reported clean — the port trap all three prior adopters
//       hit, live here too. Scanning code comments would flag this room's own honest internal
//       documentation, which is not ship-text.
//   OUT the JSON half of platform-configs/.coalhearth.json — it IS config, and verify.mjs
//       already validates it key-by-key against the schema, so scanning it would double-report
//       what that check owns. THE COMMENT HALF IS NOT COVERED BY THAT ARGUMENT and is scanned
//       (L3): measured, its 9 comment lines name `updateMode` and `updateCheckDays` in BARE
//       form and ship verbatim into a user's config home. A prior room shipped this exclusion
//       with the reason "it IS config, already schema-validated" and that reason is FALSE of
//       the comment half; this port splits the file rather than repeating it.
//   OUT plugin/ twins — byte-identical copies enforced by verify.mjs's own parity check;
//       scanning both sides would double every finding and add no coverage.
//
// THE EXEMPLAR'S SECOND EXPORT, `checkConfigReadPath`, IS NOT PORTED — stated with its reason
// rather than dropped silently (INSPECT LOW). The sibling convention it enforces is ONE
// CONFIG-READ PATH PER ROOM: no key is read from a bare project file without the global tier
// being named. Measured by hand on this room's in-scope surfaces before deciding: exactly ONE
// line qualifies — `commands/update.md`'s "set `update.updateMode` … in `.coalhearth.json`",
// which names the file with no global tier beside it. README's Configure section carries a
// universal rail that governs README's own surface (it names `~/.claude/.coalhearth.json` and
// the full own-dir → `.claude` → `.agents` → `.gemini` → legacy order), and a rail governs the
// surface it CLAIMS to govern, never a different file. So the finding is real and is returned
// as its own item: `commands/` is inside the shipped `plugin/` dist, so fixing that line changes
// the shipped artifact and owes a version bump, a tag, a Release and both propagation scripts
// (scripts-quality.md §3) — a release cycle this scripts-only gate unit has no business
// carrying. Port the checker with that fix, not before it.

// RESIDUE, stated exactly: a key named in BARE form, in free prose, on a doc surface, while
// absent from the schema. L1 cannot see it (no container prefix), L2 cannot (not in the key
// table), L3 does not reach doc surfaces. Widening L3's bare rule to the docs was measured at
// 19 candidates / 0 real — it would convert a named gap into a permanent 19-entry NOT_CONFIG
// roster, which is the allowlist rot this design refuses.

function keysInProse(text, containerRe) {
  const out = new Set();
  for (const m of text.matchAll(TICK)) if (containerRe.test(m[1])) out.add(m[1]);
  return out;
}

// Region-bound a key table to its own heading, so rows from an unrelated table cannot enter.
function tableRegion(text, heading) {
  const lines = text.split(NL);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(heading));
  if (start === -1) return null; // NOT [] — a missing heading is a broken locator, not an empty one
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

// The comment half of a JSONC config template: the lines that ship into a user's config home
// as prose. Deliberately line-based — a `//` inside a JSON string value would be miscounted
// by a naive strip, so this only accepts a line whose FIRST non-space characters are `//`.
function commentLines(text) {
  return text.split(NL).filter((l) => l.trim().startsWith('//'));
}

// findings: [{ level, msg }] — the shape every other verify.mjs check returns.
// `read` is injected so the caller owns file IO and a test can drive this in memory.
export function checkConfigKeys({
  schema, mdFiles = [], read,
  // Surfaces chosen BY NAME (not readdir-derived): an unreadable one is always a wiring bug,
  // never a legitimate absence, so it FAILs. See the PARTIAL-LOSS note below.
  namedSurfaces = [],
  keyTables = [],        // [{ file, heading }]
  templateFiles = [],    // JSONC config templates: their COMMENT half only
  pending = PENDING_KEYS,
  notConfig = NOT_CONFIG,
  blind = BLIND_KEYS,
  retired = RETIRED_KEYS,
}) {
  const findings = [];
  const containers = Object.keys(schema);
  const leaves = new Set(containers.flatMap((g) => Object.keys(schema[g])));
  const dotted = new Set(containers.flatMap((g) => Object.keys(schema[g]).map((k) => g + '.' + k)));
  // CONTAINERS ARE KNOWN NAMES TOO, and leaving them out was a real defect this port's own
  // history proof caught: an earlier era of this room's README listed GROUP rows (`journal`,
  // `recovery`, `update`) as the key table's first cells, and L2 — which is shape-free by
  // design — convicted every one of them as unresolved. A group name is a real schema name;
  // a table row naming one is a correct claim, not drift.
  const known = new Set([...dotted, ...leaves, ...containers]);
  // Containers are derived from the live schema on every run, so a renamed or added group is
  // covered the day it lands — there is no roster to keep complete.
  // Container names are ESCAPED before interpolation. They come from the schema, not from a
  // user, so this is not an injection defence — it is FAIL-CLOSED arithmetic: a container
  // carrying a regex metacharacter would silently change what the pattern MEANS (a `.` would
  // match any character, a `+` would corrupt the group), and a scanner that is confused must
  // never look identical to a scanner that succeeded.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => BS + c);
  const CONTAINER_RE = new RegExp('^(' + containers.map(esc).join('|') + ')' + BS + '.([A-Za-z][A-Za-z0-9]*)$');

  const cover = [];  // per-locator coverage, printed every run
  const seen = new Map();
  const unreadable = [];
  const note = (tok, file) => {
    if (!seen.has(tok)) seen.set(tok, new Set());
    seen.get(tok).add(file);
  };

  // PRECONDITION — a HARD GATE. Any schema key no locator can reach must be DECLARED in
  // BLIND_KEYS with its reason, or the gate FAILs rather than silently checking less than it
  // claims. L1 reaches a key through its dotted path, so the test is against CONTAINER_RE.
  const invisible = [...dotted].filter((k) => !CONTAINER_RE.test(k)).sort();
  const accepted = invisible.filter((k) => Object.hasOwn(blind, k));
  if (accepted.length) {
    findings.push({
      level: 'SKIP',
      msg: 'blind to ' + accepted.length + ' DECLARED schema key(s) no locator can reach: '
        + accepted.join(', ') + ' — named on any surface they are read and discarded, so the '
        + 'pass line does not cover them (accepted in BLIND_KEYS)',
    });
  }
  for (const k of invisible) {
    if (Object.hasOwn(blind, k)) continue;
    findings.push({
      level: 'FAIL',
      msg: 'schema key ' + k + ' cannot be detected by any locator in this gate, so a mention '
        + 'of it in ship-text is read and discarded. Declare it in BLIND_KEYS with the reason '
        + 'it is accepted, or rename the key',
    });
  }

  // L1 — PROSE, dotted container.leaf. Measured 11 candidates / 10 real / 1 unresolved (9%).
  let l1Files = 0, l1Hits = 0;
  for (const f of mdFiles) {
    let text;
    try { text = read(f); } catch { unreadable.push(f); continue; }
    l1Files++;
    for (const tok of keysInProse(text, CONTAINER_RE)) { note(tok, f); l1Hits++; }
  }
  cover.push('L1 ' + l1Files + ' docs->' + l1Hits);
  // ZERO SITES MUST FAIL. A locator that read no file is broken, not clean — the failure mode
  // every prior adopter hit was a locator finding nothing and the gate reporting green.
  if (mdFiles.length && l1Files === 0) {
    findings.push({ level: 'FAIL', msg: 'L1 read none of its ' + mdFiles.length + ' named doc surfaces — the locator is broken, not clean' });
  }
  // L2 — THE KEY TABLE, shape-free. Inside a declared key table the first cell IS a key by the
  // table's own contract, so position supplies a signal no shape rule can. This is the one
  // locator that would catch a bare-form key in a documented table.
  const tableReported = new Set();
  let l2Rows = 0, l2Hits = 0;
  for (const { file, heading } of keyTables) {
    let text;
    try { text = read(file); } catch { unreadable.push(file); continue; }
    const region = tableRegion(text, heading);
    if (region === null) {
      // The gate's own zero-matches rule applied to the locator added LAST, per the sibling
      // room whose key-table pass violated exactly this.
      findings.push({ level: 'FAIL', msg: 'key table locator found no heading "' + heading + '" in ' + file + ' — the locator is broken (renamed heading?), not clean' });
      continue;
    }
    for (const ln of region) {
      const m = ROW_KEY.exec(ln);
      if (!m) continue;
      l2Rows++;
      const tok = m[1];
      note(tok, file); l2Hits++;
      if (known.has(tok) || Object.hasOwn(notConfig, tok) || Object.hasOwn(pending, tok)) continue;
      tableReported.add(tok);
      findings.push({
        level: 'FAIL',
        msg: 'key table ' + file + ' (under "' + heading + '") documents ' + tok
          + ', which does not resolve in the schema — a table row IS a key claim whatever its '
          + 'shape. Implement it, or declare it in PENDING_KEYS / NOT_CONFIG',
      });
    }
  }
  if (keyTables.length) cover.push('L2 ' + l2Rows + ' rows->' + l2Hits);

  // L3 — THE SHIPPED TEMPLATE'S COMMENT HALF, bare identifiers. Scoped to a surface whose
  // prose is ABOUT config and nothing else, which is why the bare rule is safe here and
  // measured 0% noise (2 candidates, both real) while scoring 0% signal on the doc surfaces.
  let l3Lines = 0, l3Hits = 0;
  for (const f of templateFiles) {
    let text;
    try { text = read(f); } catch { unreadable.push(f); continue; }
    const lines = commentLines(text);
    l3Lines += lines.length;
    if (lines.length === 0) {
      findings.push({ level: 'FAIL', msg: 'L3 found no comment lines in ' + f + ' — the locator is broken (or the template lost its comments), not clean' });
      continue;
    }
    for (const ln of lines) {
      for (const m of ln.matchAll(BARE)) { note(m[1], f); l3Hits++; }
    }
  }
  if (templateFiles.length) cover.push('L3 ' + l3Lines + ' comment lines->' + l3Hits);

  // PARTIAL LOSS FAILS TOO (INSPECT MEDIUM-2), and the all-or-nothing version above is why:
  // it only fired when EVERY doc was unreadable, so renaming ONE hand-named surface dropped it
  // from coverage forever behind a green line — `L1 7 docs->` quietly becoming `L1 6 docs->`,
  // with the SKIP below the only trace and nobody reading it. That is the same silent narrowing
  // this gate exists to catch, one degree weaker. A surface chosen BY NAME cannot be legitimately
  // absent; a readdir-derived one (commands/*.md) cannot go stale, so nothing correct reddens.
  const lostNamed = namedSurfaces.filter((f) => unreadable.includes(f)).sort();
  if (lostNamed.length) {
    findings.push({
      level: 'FAIL',
      msg: lostNamed.length + ' hand-named surface(s) unreadable (' + lostNamed.join(', ') + ') — a '
        + 'named surface cannot be legitimately absent, so this is a wiring bug (renamed or moved '
        + 'file?), not an empty scan. Fix the path or drop it from the surface list deliberately',
    });
  }

  // THE CHECK. A named token must resolve, or be declared.
  for (const [tok, files] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (known.has(tok)) continue;
    if (tableReported.has(tok)) continue;
    if (Object.hasOwn(notConfig, tok)) continue;
    if (Object.hasOwn(pending, tok)) continue;
    if (Object.hasOwn(retired, tok)) {
      findings.push({ level: 'SKIP', msg: 'retired key ' + tok + ' is named in ' + [...files].sort().join(', ') + ' (' + retired[tok] + ') — reported by name, not silently uncovered' });
      continue;
    }
    findings.push({
      level: 'FAIL',
      msg: 'config key ' + tok + ' is named in ' + [...files].sort().join(', ') + ' but does not '
        + 'resolve in the schema — implement it, or declare it in PENDING_KEYS (planned, with '
        + 'its ticket), NOT_CONFIG (never a key, with its reason) or RETIRED_KEYS',
    });
  }

  // SELF-CLEANING RULE 1 — a declaration that is no longer true.
  for (const tok of Object.keys(pending)) {
    if (known.has(tok)) findings.push({ level: 'FAIL', msg: 'PENDING_KEYS lists ' + tok + ', but it now resolves in the schema — implemented, so delete the entry' });
  }
  for (const tok of Object.keys(notConfig)) {
    if (known.has(tok)) findings.push({ level: 'FAIL', msg: 'NOT_CONFIG lists ' + tok + ' as never-a-config-key, but it now resolves in the schema — the entry is a lie, delete it' });
  }
  for (const tok of Object.keys(retired)) {
    if (known.has(tok)) findings.push({ level: 'FAIL', msg: 'RETIRED_KEYS lists ' + tok + ', but it is back in the schema — un-retired, so delete the entry' });
  }
  // BLIND_KEYS expires on the same EVENT principle: an entry is true only while the key is
  // BOTH in the schema AND unreachable. Either half changing makes the declaration a lie.
  for (const tok of Object.keys(blind)) {
    if (!dotted.has(tok)) {
      findings.push({ level: 'FAIL', msg: 'BLIND_KEYS declares ' + tok + ', but it is not in the schema at all — the key is gone, delete the entry' });
    } else if (CONTAINER_RE.test(tok)) {
      findings.push({ level: 'FAIL', msg: 'BLIND_KEYS declares ' + tok + ' as unreachable, but a locator can now see it — delete the entry' });
    }
  }

  // SELF-CLEANING RULE 2 — a declaration protecting nothing is dead weight, and dead weight is
  // how an allowlist rots into a bypass nobody reads. GATED ON A COMPLETE SCAN: a partial scan
  // may not convict a declaration (a 0-hit proves nothing when the scope was incomplete), so it
  // degrades to a visible SKIP rather than a false accusation.
  if (unreadable.length) {
    findings.push({ level: 'SKIP', msg: 'declaration-pruning not checked: ' + unreadable.length + ' named surface(s) unreadable (' + unreadable.slice(0, 3).sort().join(', ') + (unreadable.length > 3 ? ', ...' : '') + ') — a partial scan cannot prove a declaration is dead' });
  } else {
    for (const [tok, why] of [...Object.entries(pending), ...Object.entries(notConfig), ...Object.entries(retired)]) {
      if (!seen.has(tok)) findings.push({ level: 'FAIL', msg: 'no scanned surface names ' + tok + ' (' + why + ') — the declaration protects nothing, delete it' });
    }
  }

  return { findings, coverage: cover.join(' · ') };
}
