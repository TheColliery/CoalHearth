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

export function buildDist(distRoot = dist) {
  fs.rmSync(distRoot, { recursive: true, force: true });
  for (const rel of DIST_ITEMS) {
    const src = path.join(repo, rel);
    const dst = path.join(distRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !/\.test\.[cm]?js$/.test(s) }); // recursive always; EXCLUDE *.test.* — dev-only tests never ship in the clean plugin/ dist (work-review LOW #3, clean-clone)
  }
}

// Every source file under DIST_ITEMS must exist in distRoot AND match byte-for-byte,
// distRoot must hold nothing under those items without a source (orphan), and no
// top-level entry may exist that no DIST_ITEM accounts for. Returns [] when in sync.
export function checkDist(distRoot = dist) {
  const out = [];
  const filesUnder = (root, rel) => {
    if (/\.test\.[cm]?js$/.test(rel)) return []; // tests are excluded from the dist (build filter) -> exclude here too, both directions, so sync holds
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).flatMap((n) => filesUnder(root, path.join(rel, n)));
    return [rel];
  };
  for (const item of DIST_ITEMS) {
    for (const rel of filesUnder(repo, item)) {
      const d = path.join(distRoot, rel);
      if (!fs.existsSync(d)) out.push(`missing in plugin/: ${rel}`);
      else if (!filesMatch(path.join(repo, rel), d)) out.push(`stale in plugin/: ${rel}`);
    }
    for (const rel of filesUnder(distRoot, item)) {
      if (!fs.existsSync(path.join(repo, rel))) out.push(`orphan in plugin/ (no source): ${rel}`);
    }
  }
  const allowedTops = new Set(DIST_ITEMS.map((rel) => rel.split(path.sep)[0]));
  if (fs.existsSync(distRoot)) {
    for (const name of fs.readdirSync(distRoot)) {
      if (!allowedTops.has(name)) out.push(`orphan top-level in plugin/ (no DIST_ITEM): ${name}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const f = checkDist();
    if (f.length) { console.error('plugin/ dist OUT OF SYNC:\n' + f.map((x) => '  ' + x).join('\n') + '\n-> run: node scripts/build-plugin.mjs'); process.exit(1); }
    console.log('plugin/ dist in sync with source.');
  } else {
    buildDist();
    console.log('plugin/ dist built (bin + lib + config + hooks + commands + plugin.json) from source.');
  }
}
