// CWK-137 (R14): the ESM side of lib/repo-fs.js. The read helpers are the SHIPPED CJS file, re-exported, never copied
// (one implementation). The write guard below is CLI-only (configure.mjs), so it lives here and ships nowhere.
//
// WRITE GUARD, for a path inside a project a stranger's repo may have planted links in. Two cures:
//   1. realpath-and-contain (node/runtime.md 4): the deepest EXISTING ancestor of the target's directory is resolved with
//      realpathSync.native and must lie inside the project root's realpathSync.native. A junction or symlink at `.claude`,
//      or anywhere above the target, that leads outside is REFUSED before anything is created or written. An unresolvable
//      root fails closed.
//   2. temp-then-rename (node/runtime.md 5): the bytes go to a per-pid temp created exclusive, then renameSync replaces
//      the destination ENTRY. A link planted at the destination (or at the `.bak`) is replaced, never written through. A
//      failed rename keeps the old file, removes the temp, and never falls back to an in-place write. (CoalMine's
//      Windows in-place fallback is NOT ported: node/runtime.md 5 forbids it, and a link-following fallback is the hole.)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoFs = createRequire(import.meta.url)('../../lib/repo-fs.js');
export const { MAX_CONFIG_BYTES, readRepoBytes, readRepoText, writeTempExclusive, isContained } = repoFs;

export class RepoWriteRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepoWriteRefused';
    this.code = 'EREFUSED';
  }
}

function deepestExisting(p) {
  let cur = p;
  for (;;) {
    try { fs.lstatSync(cur); return cur; } catch { /* keep climbing */ }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

// Throws RepoWriteRefused unless `target` would be created/replaced inside `root`'s real directory.
export function checkRepoWriteTarget(target, root) {
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch { throw new RepoWriteRefused(`the project root ${root} cannot be resolved`); }
  let realAnc;
  try { realAnc = fs.realpathSync.native(deepestExisting(path.dirname(path.resolve(target)))); } catch { throw new RepoWriteRefused(`${target} cannot be resolved`); }
  if (!isContained(realAnc, realRoot)) throw new RepoWriteRefused(`${target} leads outside the project (${realAnc} is not inside ${realRoot})`);
}

// Create the directory, then replace `target` with `content` through a temp. `root` null = no containment (the user's
// own global config, which dotfile managers legitimately link).
export function writeRepoFile(target, content, root) {
  if (root != null) checkRepoWriteTarget(target, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeTempExclusive(temp, content);
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort: the rename normally consumed it */ }
  }
}
