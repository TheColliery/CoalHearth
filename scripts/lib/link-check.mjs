// CW-017 -- link-check engine. Canon MUST: .github/SKILL-REPO-PATTERN.md:91 ("markdownlint
// checks FORMAT; nothing checks that a link actually resolves"). A SMALL walker, deliberately
// -- the chief named CoalLedger's own scripts/lib/md-checks.mjs (a full CommonMark+GFM AST)
// out of scope for this room; this file is the canon DEFAULT the sibling exemplar's own
// comment names. GFM table shape is SKIPPED entirely, not deferred -- the canon calls it
// optional and nothing here reads it, so there is no half-built check to trip on later.
//
// Checks TWO things, on the repo's own TRACKED .md files: (1) an internal relative link or
// image target resolves to a TRACKED file, relative to the citing file's own directory (a
// leading `/` resolves against the repo ROOT instead -- the one GitHub-relative-link shape
// this room's docs do not use today but a future doc legitimately could); (2) a `#anchor` --
// bare (same file) or trailing a resolved file target -- resolves to a HEADING in the target,
// slugged by GitHub's own heading-to-anchor rule. External links (any URI scheme, `//`) are
// out of scope by construction -- this gate answers "does OUR tree resolve this", not "is the
// public internet up".
//
// "RESOLVES" MEANS TRACKED, r34 MEDIUM 1 -- reusing the SHAPE `scripts/verify.mjs`'s own
// pointer-drift block already builds for `scripts/lib/pointer-check.mjs`'s `resolve()`
// callback (`git ls-files` -> a tracked-file Set + a derived tracked-DIRECTORY Set from every
// path prefix): a target that EXISTS on disk but is gitignored or merely untracked is a 404
// for every reader of a clone, exactly the class pointer-check.mjs's own module comment
// states for ITS citations ("existing-but-UNTRACKED FAILs -- indistinguishable from
// nonexistent, from any other machine"). `buildTrackedIndex`, below, is that reused shape;
// `checkTarget` fails a target that is on-disk-but-not-tracked with its own named message,
// distinct from "does not exist at all".
//
// GATE, not a plain CLI (node/runtime.md 1): the CLI entry below enumerates per-file findings,
// prints a FAIL-shaped line per finding and a summary, and sets process.exitCode -- never
// process.exit() (hooks-safety.md 1.0, scripts-quality.md 1; this room swept process.exit()
// out of scripts/ at CWK-071, r30+r31 -- a reintroduction here is a finding, not a style note).
// It needs zero scripts/lib imports of its own (node:fs/path/url only), so node/runtime.md 1's
// dynamic-import requirement has nothing to bind -- there is no lib import to make dynamic.
//
// NAMED DIVERGENCE from the CoalLedger exemplar's own workflow shape: md-checks.mjs serves a
// SECOND consumer (doc-structure's own SKILL.md, which reads its --json output directly) and
// therefore never sets an exit code itself -- CoalLedger's workflow step had to WRAP the bare
// CLI call in a shell tail-grep to get a real gate, and that wrapping is the exact thing its
// own head self-caught as a silent no-op before fixing it (read at
// `git -C ../CoalLedger show 52b2bc4:.github/workflows/link-check.yml`, the comment above the
// step). This engine has exactly ONE consumer -- this room's own workflow -- so it sets
// process.exitCode on findings directly, at the source, and the workflow step below never
// needs the wrap-and-grep shape at all. A design choice, not a smaller version of theirs.
//
// SLUG RULE, r34 HIGH: this is CWK-098's oracle algorithm, not a re-derivation and not a
// library. The oracle record (CWK-098 THE SLUG ORACLE, held in the reviewer's own r34
// scratchpad -- a scratch artifact by design, never a shipped or tracked citation; see
// scripts-quality.md's own pointer-gate scope note on why a backticked path here would name
// something unreachable from a clone) renders every heading in the flock's 7 README +
// CHANGELOG files plus 63 constructed probes through GitHub's own POST /markdown, reads the
// anchor GitHub actually emits, and states the rule the render implies -- verified to
// reproduce 998 of 998 real anchors, never assumed from github-slugger's own source. The
// r33 predecessor here collapsed a whitespace RUN to one hyphen; GitHub maps EACH space
// individually and never collapses or trims, which was wrong on 122 of 935 census headings
// (every "A — B" / "A · B" / "A & B" shape) -- the algorithm below is that corrected rule,
// reproduced in full rather than pointed at, so nothing shipped depends on an untracked file.
//
// KNOWN, NAMED LIMIT -- `renderInline` resolves a heading's raw markdown into GitHub's
// RENDERED plain text and is BEST-EFFORT, not a CommonMark parser: it handles code spans,
// links/images (text kept, target dropped), raw HTML tags, backslash escapes, entities, and
// `*`/`_` emphasis delimiters (an INTRAWORD `_` stays literal, per GFM) -- the shapes the
// oracle's own census and probes carry. NOT resolved, named rather than silently missed:
// autolinks (`<https://…>`), reference-style links, nested brackets in link text, and a
// multi-backtick code span whose CONTENT itself holds backticks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i; // a URI scheme (http:, mailto:, tel:, ...) or protocol-relative `//`
const LINK_RE = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// Fence detection, per CommonMark: a fenced code block opens with 3+ BACKTICK or 3+ TILDE
// characters and is closed ONLY by a fence of the SAME character, at least as long as the
// opener. r34 FIXBACK2 LOW-2: the old `FENCE_RE = /^\s*```/` was backtick-only (a `~~~`
// fence was never recognised as a fence at all) and length-blind (a blind boolean toggle, so
// ANY 3+-backtick line closed a fence regardless of length or character) -- a four-backtick
// fence whose BODY held a bare three-backtick line toggled closed early, inverting fence
// state for the rest of the document; a tilde fence was invisible, so headings inside one
// were wrongly extracted as real headings.
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
function fenceOpen(line) {
  const m = FENCE_OPEN_RE.exec(line);
  return m ? { ch: m[1][0], len: m[1].length } : null;
}
function fenceCloses(line, fence) {
  const m = FENCE_OPEN_RE.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

const CODE_SPAN_RE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    const key = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

// Step 0 of the rule: resolve a heading's raw markdown source into GitHub's RENDERED plain
// text. Code spans split out first, so escapes/entities/emphasis never apply INSIDE one.
export function renderInline(raw) {
  const parts = [];
  let last = 0, m;
  CODE_SPAN_RE.lastIndex = 0;
  while ((m = CODE_SPAN_RE.exec(raw))) {
    parts.push({ code: false, t: raw.slice(last, m.index) });
    let body = m[2];
    if (/^ .* $/.test(body) && body.trim() !== '') body = body.slice(1, -1); // one leading+trailing space, both stripped, per CommonMark
    parts.push({ code: true, t: body });
    last = m.index + m[0].length;
  }
  parts.push({ code: false, t: raw.slice(last) });
  return parts.map((p) => {
    if (p.code) return p.t;
    let t = p.t;
    t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');                    // link / image -> its text
    // CodeQL #18 js/incomplete-multi-character-sanitization: a SINGLE pass leaves a tag
    // behind on a nested/overlapping shape (an OUTER `<` and an early INNER tag consumed
    // together by one match exposes a fresh, real tag behind them -- e.g.
    // `<<script>script>x</<script>/script>` -> `<script>x<//script>` after one replace,
    // literally containing "<script", the exact alert text). Repeat until the string stops
    // changing -- CodeQL's own query-help fix for this rule -- so no `<[A-Za-z]...>` shape
    // can survive removal by construction, however many times it must nest. Bounded: each
    // pass either removes at least one tag or the loop ends (never removes 0 chars and
    // re-loops), so this cannot run away on real input.
    let prev;
    do { prev = t; t = t.replace(/<\/?[A-Za-z][^>]*>/g, ''); } while (t !== prev);
    // r34 FIXBACK2 LOW-1: an ESCAPED `_`/`*` must never re-enter the emphasis pass as a live
    // delimiter -- GitHub keeps `\_b\_` as `_b_` (the escaped underscores survive as literal
    // characters), but the old order resolved `\_` -> `_` BEFORE the emphasis pass, with
    // nothing marking that underscore as escaped, so it satisfied the emphasis regex and got
    // stripped along with its own escaping. Swap an escaped `_`/`*` for a SENTINEL first --
    // written as a JS escape SEQUENCE in source (four characters, backslash-x-0-0), never a
    // raw byte in the FILE (this room's own `2c53643` lesson: a raw NUL in the file is
    // invisible to a normal Read) -- run the emphasis pass, then restore the literal
    // character. The sentinel is neither `_` nor `*`, so the emphasis regex cannot see it.
    t = t.replace(/\\_/g, '\x00');
    t = t.replace(/\\\*/g, '\x01');
    t = t.replace(/\\([!-\/:-@[-`{-~])/g, (x, ch) => ch);               // remaining backslash escapes -> the literal char
    // emphasis delimiters: a run that OPENS (not preceded by a letter/number/underscore) and a
    // matching run that CLOSES (not followed by one) is stripped; an INTRAWORD `_` (GFM rule)
    // stays literal because it never satisfies both boundary conditions at once.
    t = t.replace(/(^|[^\p{L}\p{N}_])(_+)(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}_])/gu, '$1$3');
    t = t.replace(/(^|[^*])(\*+)(?=\S)([\s\S]*?\S)\2/g, '$1$3');
    t = t.replace(/\x00/g, '_').replace(/\x01/g, '*');
    return decodeEntities(t);
  }).join('');
}

// Steps 1-3 of the rule, on RENDERED text: lowercase EACH code point on its own (no
// whole-string final-sigma context: `wordΣ` -> `wordσ`, never `wordς`), delete every code
// point that is not \p{Alphabetic} | \p{M} | \p{Nd} | \p{Pc} | \p{Join_Control} | space |
// hyphen (Thai combining tone/vowel marks -- \p{M} -- stay for this reason: they attach to a
// base letter and dropping them corrupts the word, not merely shortens it; a VS16/ZWJ/ZWNJ
// also lands in this keep-set and survives even when the emoji or letter beside it does not),
// then map EACH remaining space to its OWN hyphen -- no run collapse, no trim.
const DROP = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control} -]/gu;
export function oracleSlug(rendered) {
  let s = '';
  for (const ch of String(rendered)) s += ch.toLowerCase();
  return s.replace(DROP, '').replace(/ /g, '-');
}

export function githubSlug(rawHeadingText) {
  return oracleSlug(renderInline(rawHeadingText));
}

// github-slugger's own occurrence counter (step 4): the base slug's counter ADVANCES until a
// free slot is found, and the EMITTED anchor is registered too -- so a literal "x-1" heading
// arriving after two "x" headings becomes "x-1-1", not a collision with the second "x"'s own
// "x-1". Scoped per document -- a fresh Anchorer per file, never shared across files.
export class Anchorer {
  constructor() { this.occ = new Map(); }
  anchor(base) {
    let result = base;
    while (this.occ.has(result)) {
      this.occ.set(base, this.occ.get(base) + 1);
      result = `${base}-${this.occ.get(base)}`;
    }
    this.occ.set(result, 0);
    return result;
  }
}

// Every `#{1..6} heading` line in `text`, fence-aware (a `#` inside a fenced code block is
// code, not a heading) -- returns [{ text, line }] in document order, line 1-indexed.
export function extractHeadings(text) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      if (fenceCloses(lines[i], fence)) fence = null;
      continue;
    }
    const open = fenceOpen(lines[i]);
    if (open) { fence = open; continue; }
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ text: m[2], line: i + 1 });
  }
  return headings;
}

// The de-duplicated anchor SET a file's own headings produce, via github-slugger's own
// occurrence-counter shape (Anchorer, above) -- a fresh counter per call, so a heading list
// spanning two calls (two files) never collides across them.
export function headingAnchors(text) {
  const a = new Anchorer();
  const anchors = new Set();
  for (const h of extractHeadings(text)) anchors.add(a.anchor(githubSlug(h.text)));
  return anchors;
}

// A GFM link MAY carry a trailing ` "title"` / ` 'title'` after the destination
// (`[text](./x.md "a title")`) -- strip it before the destination is ever treated as a
// path, or a perfectly valid link false-FAILs as broken (the title text becomes part of
// the "path", which then cannot exist). Rot-canary QUICK catch, r33: no real doc in this
// room uses a link title today, so nothing had exercised this -- confirmed live before
// the fix (`[t](./README.md "a title")` resolved as target `./README.md "a title"`).
// FIXED, r34 LOW 2: the delimiter is now CAPTURED and matched against ITSELF, not against a
// class excluding both quote characters -- the old `["'](?:[^"']*)["']` rejected an
// apostrophe INSIDE a double-quoted title (`"it's a title"`), leaving the whole title glued
// to the destination. A title's own delimiter never appears unescaped inside itself in any
// heading this room's docs carry, so no escape handling is needed here.
function stripLinkTitle(raw) {
  const m = /^(\S+)\s+(["'])([\s\S]*?)\2\s*$/.exec(raw);
  return m ? m[1] : raw;
}

// A GFM destination MAY be wrapped in `< >` to permit a space inside it
// (`[x](<./a b.md>)`) -- unwrap it BEFORE title-stripping, since `stripLinkTitle`'s own
// `\S+` cannot match a destination that itself contains whitespace. r34 LOW 2: measured
// false-FAIL before this fix (the raw `<./a b.md>` carried its own brackets into the "path").
function parseLinkTarget(raw) {
  const s = raw.trim();
  if (s[0] === '<') {
    const end = s.indexOf('>', 1);
    if (end !== -1) return s.slice(1, end);
  }
  return stripLinkTitle(s);
}

// [{ target, line }] for every markdown link/image `[label](target)` / `![alt](target)` in
// `text`, fence-aware. A citation written INSIDE a fenced code block is an EXAMPLE, not a
// claim about this tree (the identical reasoning pointer-check.mjs already applies to
// backticked tokens in prose -- fenced content documents a shape, it does not name a path).
export function extractCitations(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      if (fenceCloses(lines[i], fence)) fence = null;
      continue;
    }
    const open = fenceOpen(lines[i]);
    if (open) { fence = open; continue; }
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(lines[i]))) {
      out.push({ target: parseLinkTarget(m[1]), line: i + 1 });
    }
  }
  return out;
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// r34 MEDIUM 1 -- the SAME shape `scripts/verify.mjs`'s own pointer-drift block builds for
// `pointer-check.mjs`'s `resolve()` callback: `git ls-files` -> a tracked-file Set, plus a
// derived tracked-DIRECTORY Set (every prefix of every tracked path), so a citation pointing
// at a directory (e.g. `platform-configs/hooks/`) resolves too. The CLI entry is the only
// caller that needs this, so callers testing pure link/anchor logic never have to supply one.
//
// r34 FIXBACK2 LOW-3 -- `-z` (NUL-separated, no C-quoting): plain `git ls-files` quotes any
// non-ASCII path under the (default-on) `core.quotepath`, so a tracked Thai-named file came
// back as the literal 8-character string `"\340\271..."`, never matching its own real path --
// a false "UNTRACKED" FAIL on a file that IS tracked. `-z` disables quoting and NUL-separates
// entries instead, so a Thai/space/any-byte filename round-trips exactly.
//
// r34 FIXBACK2 MEDIUM-B -- a git failure must never read as a clean pass. TWO shapes, two
// behaviours, the SHAPE reused from `pointer-check.mjs`'s own `classifyCheckIgnoreResult`
// (CWK-090 fix 1) -- never its exact POLICY, because that gate always assumes a git repo and
// this one does not (no-external-assumption: git is an OPTIONAL enhancement here, the
// exists-only check underneath it works without git at all). (1) a SPAWN failure (`git` the
// BINARY is not on PATH, `e.code === 'ENOENT'`) OR git ran and answered "not a git repository
// (or any of the parent directories)" (its own stable wording for "I searched upward and
// found none") -- genuinely no git tracking info exists to consult -- degrades to exists-only,
// but the degrade is DISCLOSED on stdout EVERY run it fires, never silent. (2) git RAN and
// the command failed for any OTHER reason (a broken `GIT_DIR` naming its own bad path,
// `safe.directory` dubious ownership, anything else) -- this tool's only realistic deployment
// is inside a real checkout (the CI workflow, a contributor's own clone), so a failure here
// signals something BROKEN, not merely "no git": FAIL LOUD, naming the exit status and git's
// own first stderr line. The split is NOT "contains the phrase not a git repository" -- a
// broken `GIT_DIR` says that too, just without the parenthetical, and text-matching the
// shorter phrase would have wrongly read the GIT_DIR case as case 1 (empirically confirmed,
// see the return). Before this fix, ANY git failure (`GIT_DIR=/nonexistent`, reproduced live)
// silently returned `null` and the tracked-check simply never ran, with nothing on stdout or
// in the exit code to show half the gate was skipped.
export function classifyTrackedIndexResult(r) {
  if (r.error) {
    return { ok: false, degrade: true, message: `git is not available here: ${r.error.message}` };
  }
  if (r.status === 0) return { ok: true, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  const stderrLine = typeof r.stderr === 'string' ? r.stderr.split('\n')[0].trim() : '';
  // "not a git repository (or any of the parent directories): .git" is git's own, STABLE
  // wording for "I searched upward from cwd and found no .git at all" -- the ordinary,
  // GIT_DIR-unset no-repo case, which stays case 1 (degrade). ANY other non-zero exit reads
  // as case 2: a BROKEN GIT_DIR names its OWN bad path instead ("not a git repository:
  // '<path>'", with no "(or any of the parent directories)" clause -- empirically confirmed,
  // see the return), and safe.directory's dubious-ownership refusal is a different message
  // again. Both mean git IS answering FOR a specific repo context and something about that
  // context is broken, not merely absent -- text-matching the bare phrase "not a git
  // repository" would have wrongly classified the broken-GIT_DIR case as case 1 too, since
  // that phrase appears in BOTH messages; only the parenthetical distinguishes them.
  const noRepoFound = /not a git repository \(or any of the parent directories\)/.test(stderrLine);
  return {
    ok: false,
    degrade: noRepoFound,
    message: noRepoFound
      ? 'this directory is not a git repository'
      : `git ls-files exited ${r.status}${stderrLine ? ` -- ${stderrLine}` : ''}`,
  };
}

export function buildTrackedIndex(repoRoot) {
  let r;
  try {
    const stdout = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    r = { status: 0, stdout };
  } catch (e) {
    r = e.code === 'ENOENT' ? { error: e } : { status: e.status, stderr: e.stderr };
  }
  const verdict = classifyTrackedIndexResult(r);
  if (!verdict.ok) {
    if (verdict.degrade) {
      console.log(`link-check: ${verdict.message} -- tracked-check degraded to exists-only`);
      return null;
    }
    return { fatal: verdict.message };
  }
  const tracked = new Set(verdict.stdout.split('\0').filter(Boolean));
  const trackedDirs = new Set();
  for (const f of tracked) { const p = f.split('/'); for (let i = 1; i < p.length; i++) trackedDirs.add(p.slice(0, i).join('/')); }
  return { tracked, trackedDirs };
}

// One citation, checked against disk (and, when `trackedIndex` is supplied, against git).
// Returns a finding object or null (resolves clean). `ownAnchors` is the CITING file's own
// heading-anchor set, passed in so a bare `#anchor` check never re-reads the file it is
// already holding open.
function checkTarget(rawTarget, citingRel, citingAbs, repoRoot, line, ownAnchors, trackedIndex) {
  if (EXTERNAL_RE.test(rawTarget)) return null;
  const hashIdx = rawTarget.indexOf('#');
  const pathPart = decodeSafe(hashIdx === -1 ? rawTarget : rawTarget.slice(0, hashIdx));
  const anchor = hashIdx === -1 ? null : rawTarget.slice(hashIdx + 1);

  if (!pathPart) {
    if (!anchor) return null; // bare `#` or empty target -- nothing to check
    if (!ownAnchors.has(githubSlug(decodeSafe(anchor)))) {
      return { file: citingRel, line, kind: 'broken-anchor', target: rawTarget,
        message: `#${anchor} does not resolve to a heading in ${citingRel}` };
    }
    return null;
  }

  const isRootRelative = pathPart.startsWith('/');
  const baseDir = isRootRelative ? repoRoot : path.dirname(citingAbs);
  const targetAbs = path.resolve(baseDir, isRootRelative ? pathPart.slice(1) : pathPart);
  const targetRel = path.relative(repoRoot, targetAbs).split(path.sep).join('/');

  if (!fs.existsSync(targetAbs)) {
    return { file: citingRel, line, kind: 'broken-link', target: rawTarget,
      message: `does not resolve to a file (looked for ${targetRel})` };
  }
  // r34 MEDIUM 1: exists-on-disk is not enough -- a gitignored or merely untracked target is
  // a 404 for every reader of a clone. THREE states, not two, the same shape
  // pointer-check.mjs's own module comment already states for its citations.
  if (trackedIndex && !trackedIndex.tracked.has(targetRel) && !trackedIndex.trackedDirs.has(targetRel)) {
    return { file: citingRel, line, kind: 'broken-link', target: rawTarget,
      message: `exists on disk but is UNTRACKED -- not reachable from a clone (looked for ${targetRel})` };
  }
  if (!anchor) return null;
  if (!targetAbs.toLowerCase().endsWith('.md')) return null; // an anchor into a non-markdown target is out of scope

  let targetText;
  try { targetText = fs.readFileSync(targetAbs, 'utf8'); }
  catch { return null; } // exists but unreadable is a different class than a broken citation -- not this gate's job to explain a permissions problem
  if (!headingAnchors(targetText).has(githubSlug(decodeSafe(anchor)))) {
    return { file: citingRel, line, kind: 'broken-anchor', target: rawTarget,
      message: `#${anchor} does not resolve to a heading in ${targetRel}` };
  }
  return null;
}

// Every finding in ONE file. `absPath` is the file to check; `repoRoot` anchors relative
// reporting and root-relative (`/...`) targets. `trackedIndex` (optional, from
// `buildTrackedIndex`) additionally requires a resolved target to be TRACKED, not merely
// present on disk (r34 MEDIUM 1) -- omit it for pure filesystem-only fixtures that do not
// care about git.
export function checkFile(absPath, repoRoot, trackedIndex) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); }
  catch (e) { return [{ file: rel, line: 0, kind: 'read-error', target: '', message: `could not read: ${e.message}` }]; }

  const ownAnchors = headingAnchors(text);
  const findings = [];
  for (const c of extractCitations(text)) {
    const f = checkTarget(c.target, rel, absPath, repoRoot, c.line, ownAnchors, trackedIndex);
    if (f) findings.push(f);
  }
  return findings;
}

// Every finding across a LIST of repo-relative (or absolute) .md paths. Returns
// `{ findings, filesChecked }` -- filesChecked is the count actually attempted, independent of
// how many produced a finding, so a caller can print an honest "N finding(s) across M file(s)"
// line even when every file is clean. `trackedIndex` -- see checkFile.
export function checkFiles(files, repoRoot, trackedIndex) {
  const findings = [];
  let filesChecked = 0;
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(repoRoot, f);
    findings.push(...checkFile(abs, repoRoot, trackedIndex));
    filesChecked++;
  }
  return { findings, filesChecked };
}

// CLI ENTRY -- `node scripts/lib/link-check.mjs <repo-relative .md paths...>`. Fail loud: a
// non-empty file list with zero findings exits 0; anything else (findings, or NO files given)
// exits 1. The empty-argv case is deliberately a FAIL here too, matching the workflow step's
// OWN empty-list guard one layer up (order 1, CWK-079's fail-open class) -- belt and braces,
// never relied on alone: a caller that bypasses the shell guard and invokes this file directly
// with no paths must not read as a clean pass either.
function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('link-check: no files given');
    process.exitCode = 1;
    return;
  }
  const repoRoot = process.cwd();
  const trackedIndex = buildTrackedIndex(repoRoot); // r34 MEDIUM 1; null degrades to exists-only
  if (trackedIndex && trackedIndex.fatal) { // r34 FIXBACK2 MEDIUM-B: a broken git call is never a clean pass
    console.error(`link-check: ${trackedIndex.fatal}`);
    process.exitCode = 1;
    return;
  }
  const { findings, filesChecked } = checkFiles(files, repoRoot, trackedIndex);
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.kind} - ${f.target} - ${f.message}`);
  console.log(`${findings.length} finding(s) across ${filesChecked} file(s)`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
