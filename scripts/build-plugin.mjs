#!/usr/bin/env node
// CoalHearth dist build — assemble a CLEAN `plugin/` from source so the Claude Code
// marketplace serves ONLY the plugin (bin + lib + config + manifest), never the
// repo's scripts/, docs, or design files. Mirrors CoalBoard/CoalTipple's plugin/ dist;
// marketplace.json `source` points at ./plugin. Run after editing bin/lib/config/
// plugin.json — verify.mjs FAILs on drift. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repo, 'plugin');

// EXACTLY what a Claude Code plugin loads — nothing the marketplace clone carries
// that a CC user does not need.
export const DIST_ITEMS = [
  path.join('.claude-plugin', 'plugin.json'),
  'bin',
  'lib',
  'config',
  'hooks',
  'commands',
  // 08b (CWK-202 pilot): the Antigravity plugin. AG registers a FOLDER holding plugin.json + hooks.json at its root (docs/plugins.md), and runs a hook command from the
  // directory holding hooks.json (docs/hooks.md), so plugin/ is that folder: these two root files sit beside the bin/ + lib/ the hooks run. Claude Code reads
  // .claude-plugin/plugin.json and hooks/hooks.json, never these two paths.
  'plugin.json',
  'hooks.json',
  // r29b: the AG manifest's logo (plugin.json "logo": "assets/logo.svg") resolves inside the folder AG installs, so the dist carries assets/ too.
  'assets',
];

// TEXT_EXTS grounded in what actually ships: every extension found under
// DIST_ITEMS today (bin/lib/hooks .js — CJS throughout, per node/runtime.md §3;
// commands/*.md; config/schema.json, hooks/hooks.json, .claude-plugin/plugin.json).
// No .mjs/.cjs ships under DIST_ITEMS in this room. Non-text/unlisted extensions
// stay strict byte-compare — the mechanism must not silently normalize a future
// binary asset.
const TEXT_EXTS = new Set(['.js', '.json', '.md']);

// Byte-compare two files, EOL-agnostic on TEXT_EXTS only (board #47's
// `.gitattributes` eol=lf conform can still leave a stale core.autocrlf checkout
// with CRLF bytes for byte-identical content, false-flagging it "stale in
// plugin/"). Never a blanket \r strip — a LONE bare \r (not followed by \n) is
// real content, not a line-ending artifact, and must still cause a mismatch.
function filesMatch(a, b) {
  const bufA = fs.readFileSync(a);
  const bufB = fs.readFileSync(b);
  if (bufA.compare(bufB) === 0) return true;
  const ext = path.extname(a);
  if (ext !== path.extname(b) || !TEXT_EXTS.has(ext)) return false;
  // latin1, not utf8: utf8 maps every INVALID byte to U+FFFD, so two files
  // differing only in invalid-UTF-8 bytes would decode to the SAME string and
  // report a false match — exactly the corruption class this gate exists to
  // catch. latin1 is a lossless 1:1 byte<->char mapping (no byte class ever
  // collapses); CRLF bytes normalize identically to utf8 for the ASCII range.
  const crlfToLf = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
  return crlfToLf(bufA) === crlfToLf(bufB);
}

// A link or junction is never copied, followed or written through. Every folder on the path to a source is
// lstat-ed, component by component, so a link at a PARENT folder is found as well as the entry's own. A link at the dist root is refused
// before the old dist is removed, so the removal never reaches through one. The walks use lstat, so a link is named and never followed.
// A path that is absent or whose parent is a file (ENOTDIR) is not a link: the copy or the check reports that on its own.
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

// The first link on the path from `root` down to `rel`, component by component with lstat. `root` itself is not walked. Null when none.
function firstLinkAbove(root, rel) {
  let cur = '';
  for (const part of rel.split(path.sep)) {
    cur = cur ? path.join(cur, part) : part;
    const st = lstatOrNull(path.join(root, cur));
    if (st === null) return null;
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}

// Throws, naming the link, when a source the build copies holds a link at any folder on its path, or anywhere under it.
function assertNoLinks(root, rel) {
  const link = firstLinkAbove(root, rel);
  if (link !== null) throw new Error(`${link}: a link or junction in the source tree is refused (the build copies files, never links)`);
  const st = lstatOrNull(path.join(root, rel));
  if (st && st.isDirectory()) for (const n of fs.readdirSync(path.join(root, rel))) assertNoLinks(root, path.join(rel, n));
}

export function buildDist(distRoot = dist, srcRoot = repo) {
  const root = lstatOrNull(distRoot);
  if (root && root.isSymbolicLink()) throw new Error(`${path.basename(distRoot)}: a link or junction at the dist root is refused (the build removes and rewrites plugin/, and never through a link)`);
  for (const rel of DIST_ITEMS) assertNoLinks(srcRoot, rel); // before the old dist is removed: a refused build leaves plugin/ as it was
  fs.rmSync(distRoot, { recursive: true, force: true });
  for (const rel of DIST_ITEMS) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(distRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !/\.test\.[cm]?js$/.test(s) }); // recursive always; EXCLUDE *.test.* — dev-only tests never ship in the clean plugin/ dist (work-review LOW #3, clean-clone)
  }
}

// Every source file under DIST_ITEMS must exist in distRoot AND match byte-for-byte,
// distRoot must hold nothing under those items without a source (orphan), and no
// top-level entry may exist that no DIST_ITEM accounts for. Returns [] when in sync.
// A link anywhere on the way (the dist root, a parent folder, an entry) is named and skipped, never followed.
export function checkDist(distRoot = dist, srcRoot = repo) {
  const out = [];
  const linkedRoot = lstatOrNull(distRoot);
  if (linkedRoot && linkedRoot.isSymbolicLink()) {
    out.push(`symlink plugin/ root (refused, not followed): ${path.basename(distRoot)}`);
    return out;
  }
  const filesUnder = (root, rel) => {
    if (/\.test\.[cm]?js$/.test(rel)) return []; // tests are excluded from the dist (build filter) -> exclude here too, both directions, so sync holds
    const st = lstatOrNull(path.join(root, rel));
    if (!st) return [];
    if (st.isSymbolicLink()) { out.push(`symlink in DIST_ITEM (refused, not followed): ${rel}`); return []; }
    if (st.isDirectory()) return fs.readdirSync(path.join(root, rel)).flatMap((n) => filesUnder(root, path.join(rel, n)));
    return [rel];
  };
  // A link at a parent folder of the item: the item is named and skipped in this tree, instead of compared or walked through it.
  const linkAboveItem = (root, item) => {
    const link = firstLinkAbove(root, item);
    if (link === null) return false;
    out.push(`symlink in DIST_ITEM (refused, not followed): ${link}`);
    return true;
  };
  for (const item of DIST_ITEMS) {
    const srcLinked = linkAboveItem(srcRoot, item);
    for (const rel of srcLinked ? [] : filesUnder(srcRoot, item)) {
      const d = path.join(distRoot, rel);
      const dst = lstatOrNull(d);
      if (!dst) out.push(`missing in plugin/: ${rel}`);
      else if (dst.isSymbolicLink()) out.push(`symlink in plugin/ (refused, not followed): ${rel}`);
      // R19 FIXBACK 1 (the sibling of thread 12): a dist entry that is not a file where the source holds one (a directory) made filesMatch's
      // readFileSync throw EISDIR and the rest of the drift report was lost. It is a finding, and the scan goes on.
      else if (!dst.isFile()) out.push(`invalid in plugin/ (not a file): ${rel}`);
      else if (!filesMatch(path.join(srcRoot, rel), d)) out.push(`stale in plugin/: ${rel}`);
    }
    const distLinked = linkAboveItem(distRoot, item);
    for (const rel of distLinked ? [] : filesUnder(distRoot, item)) {
      if (!lstatOrNull(path.join(srcRoot, rel))) out.push(`orphan in plugin/ (no source): ${rel}`);
    }
  }
  // CWK-120 #9: a FILE-shaped DIST_ITEM (.claude-plugin/plugin.json) accounts for ITS OWN path only. Its parent directory
  // is allowed as a top-level entry below, so without this an extra file beside it in the dist matched no DIST_ITEM,
  // appeared in neither loop above, and passed. Its parent must hold exactly the declared names and nothing else.
  const allowedByDir = new Map();
  for (const rel of DIST_ITEMS) {
    const dir = path.dirname(rel);
    if (dir === '.') continue;
    if (!allowedByDir.has(dir)) allowedByDir.set(dir, new Set());
    allowedByDir.get(dir).add(path.basename(rel));
  }
  for (const [dir, allowed] of allowedByDir) {
    const abs = path.join(distRoot, dir);
    const st = lstatOrNull(abs);
    if (!st) continue;
    if (st.isSymbolicLink()) { out.push(`symlink in plugin/ (refused, not followed): ${dir}`); continue; }
    // R19 (CodeRabbit PR #19 thread 12): an entry that exists but is not a directory made readdirSync throw ENOTDIR and the drift
    // report never returned. It is a finding now, and the scan goes on.
    if (!st.isDirectory()) { out.push(`invalid in plugin/ (not a directory): ${dir}`); continue; }
    for (const name of fs.readdirSync(abs)) {
      if (!allowed.has(name)) out.push(`orphan in plugin/ (no DIST_ITEM): ${path.join(dir, name)}`);
    }
  }
  const allowedTops = new Set(DIST_ITEMS.map((rel) => rel.split(path.sep)[0]));
  const rootSt = lstatOrNull(distRoot);
  if (rootSt && !rootSt.isDirectory()) {
    out.push(`invalid plugin/ (not a directory): ${path.basename(distRoot)}`); // same rule at the top level
  } else if (rootSt) {
    for (const name of fs.readdirSync(distRoot)) {
      if (!allowedTops.has(name)) out.push(`orphan top-level in plugin/ (no DIST_ITEM): ${name}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const f = checkDist();
    // node/runtime.md 7: process.exitCode, never process.exit() (can drop a pending stdout
    // write). The `else` is load-bearing here -- setting exitCode alone would fall through
    // to the "in sync" line below on an OUT-OF-SYNC dist. No truncation was reproduced at
    // this site; the ban is unconditional regardless.
    if (f.length) { console.error('plugin/ dist OUT OF SYNC:\n' + f.map((x) => '  ' + x).join('\n') + '\n-> run: node scripts/build-plugin.mjs'); process.exitCode = 1; }
    else console.log('plugin/ dist in sync with source.');
  } else {
    try {
      buildDist();
      console.log('plugin/ dist built (bin + lib + config + hooks + commands + plugin.json) from source.');
    } catch (e) {
      console.error('plugin/ dist NOT built: ' + e.message); // a named refusal, never a stack trace (scripts-quality.md 1)
      process.exitCode = 1;
    }
  }
}
