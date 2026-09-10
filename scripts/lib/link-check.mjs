// CW-017 -- link-check engine. Canon MUST: .github/SKILL-REPO-PATTERN.md:91 ("markdownlint
// checks FORMAT; nothing checks that a link actually resolves"). A SMALL walker, deliberately
// -- the chief named CoalLedger's own scripts/lib/md-checks.mjs (a full CommonMark+GFM AST)
// out of scope for this room; this file is the canon DEFAULT the sibling exemplar's own
// comment names. GFM table shape is SKIPPED entirely, not deferred -- the canon calls it
// optional and nothing here reads it, so there is no half-built check to trip on later.
//
// Checks TWO things, on the repo's own TRACKED .md files: (1) an internal relative link or
// image target resolves to a FILE on disk, relative to the citing file's own directory (a
// leading `/` resolves against the repo ROOT instead -- the one GitHub-relative-link shape
// this room's docs do not use today but a future doc legitimately could); (2) a `#anchor` --
// bare (same file) or trailing a resolved file target -- resolves to a HEADING in the target,
// slugged by GitHub's own heading-to-anchor rule. External links (any URI scheme, `//`) are
// out of scope by construction -- this gate answers "does OUR tree resolve this", not "is the
// public internet up".
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
// KNOWN, NAMED LIMIT -- heading-text stripping for slugging is BEST-EFFORT, not a markdown
// parser. Backtick code spans are stripped (the one real shape this room's own docs use in
// headings, e.g. a config-key heading). Emphasis markers (`*`/`_`) are deliberately LEFT
// ALONE: a first attempt at stripping paired underscores corrupted a legitimate underscored
// word (`a_b_c` -> `abc`) in testing, and no heading in this room's own docs uses markdown
// emphasis today -- the risk of silently mangling a real word outweighs the rare real case.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i; // a URI scheme (http:, mailto:, tel:, ...) or protocol-relative `//`
const LINK_RE = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// GitHub's heading->anchor rule, best-effort: strip backtick code spans, lowercase, drop
// everything that is not a Unicode letter/number/combining-mark/underscore/space/hyphen (this
// is why Thai vowel/tone marks -- \p{M} -- must stay in the allow-set: they are COMBINING
// marks attached to the base letter, and dropping them corrupts the word rather than merely
// shortening it), collapse whitespace runs to a single hyphen.
export function githubSlug(text) {
  let s = String(text).replace(/`([^`\n]+)`/g, '$1');
  s = s.toLowerCase().trim();
  s = s.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '');
  s = s.replace(/\s+/g, '-');
  return s;
}

// Every `#{1..6} heading` line in `text`, fence-aware (a `#` inside a fenced code block is
// code, not a heading) -- returns [{ text, line }] in document order, line 1-indexed.
export function extractHeadings(text) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ text: m[2], line: i + 1 });
  }
  return headings;
}

// The de-duplicated anchor SET a file's own headings produce -- GitHub appends `-1`, `-2`, ...
// to the 2nd, 3rd, ... occurrence of an identical slug on one page, never to the first.
export function headingAnchors(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const h of extractHeadings(text)) {
    const base = githubSlug(h.text);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

// A GFM link MAY carry a trailing ` "title"` / ` 'title'` after the destination
// (`[text](./x.md "a title")`) -- strip it before the destination is ever treated as a
// path, or a perfectly valid link false-FAILs as broken (the title text becomes part of
// the "path", which then cannot exist). Rot-canary QUICK catch, r33: no real doc in this
// room uses a link title today, so nothing had exercised this -- confirmed live before
// the fix (`[t](./README.md "a title")` resolved as target `./README.md "a title"`).
function stripLinkTitle(raw) {
  const m = /^(\S+)\s+["'](?:[^"']*)["']\s*$/.exec(raw);
  return m ? m[1] : raw;
}

// [{ target, line }] for every markdown link/image `[label](target)` / `![alt](target)` in
// `text`, fence-aware. A citation written INSIDE a fenced code block is an EXAMPLE, not a
// claim about this tree (the identical reasoning pointer-check.mjs already applies to
// backticked tokens in prose -- fenced content documents a shape, it does not name a path).
export function extractCitations(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(lines[i]))) {
      out.push({ target: stripLinkTitle(m[1].trim()), line: i + 1 });
    }
  }
  return out;
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// One citation, checked against disk. Returns a finding object or null (resolves clean).
// `ownAnchors` is the CITING file's own heading-anchor set, passed in so a bare `#anchor`
// check never re-reads the file it is already holding open.
function checkTarget(rawTarget, citingRel, citingAbs, repoRoot, line, ownAnchors) {
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

  if (!fs.existsSync(targetAbs)) {
    const wanted = path.relative(repoRoot, targetAbs).split(path.sep).join('/');
    return { file: citingRel, line, kind: 'broken-link', target: rawTarget,
      message: `does not resolve to a file (looked for ${wanted})` };
  }
  if (!anchor) return null;
  if (!targetAbs.toLowerCase().endsWith('.md')) return null; // an anchor into a non-markdown target is out of scope

  let targetText;
  try { targetText = fs.readFileSync(targetAbs, 'utf8'); }
  catch { return null; } // exists but unreadable is a different class than a broken citation -- not this gate's job to explain a permissions problem
  const targetRel = path.relative(repoRoot, targetAbs).split(path.sep).join('/');
  if (!headingAnchors(targetText).has(githubSlug(decodeSafe(anchor)))) {
    return { file: citingRel, line, kind: 'broken-anchor', target: rawTarget,
      message: `#${anchor} does not resolve to a heading in ${targetRel}` };
  }
  return null;
}

// Every finding in ONE file. `absPath` is the file to check; `repoRoot` anchors relative
// reporting and root-relative (`/...`) targets.
export function checkFile(absPath, repoRoot) {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); }
  catch (e) { return [{ file: rel, line: 0, kind: 'read-error', target: '', message: `could not read: ${e.message}` }]; }

  const ownAnchors = headingAnchors(text);
  const findings = [];
  for (const c of extractCitations(text)) {
    const f = checkTarget(c.target, rel, absPath, repoRoot, c.line, ownAnchors);
    if (f) findings.push(f);
  }
  return findings;
}

// Every finding across a LIST of repo-relative (or absolute) .md paths. Returns
// `{ findings, filesChecked }` -- filesChecked is the count actually attempted, independent of
// how many produced a finding, so a caller can print an honest "N finding(s) across M file(s)"
// line even when every file is clean.
export function checkFiles(files, repoRoot) {
  const findings = [];
  let filesChecked = 0;
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(repoRoot, f);
    findings.push(...checkFile(abs, repoRoot));
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
  const { findings, filesChecked } = checkFiles(files, repoRoot);
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.kind} - ${f.target} - ${f.message}`);
  console.log(`${findings.length} finding(s) across ${filesChecked} file(s)`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
