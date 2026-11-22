// CWK-137 (R14): the ESM side of lib/repo-fs.js. The read helpers are the SHIPPED CJS file, re-exported, never copied
// (one implementation). The write guard below is CLI-only (configure.mjs), so it lives here and ships nowhere.
//
// WRITE GUARD, for a path inside a project a stranger's repo may have planted links in. Two cures:
//   1. realpath-and-contain (node/runtime.md 4): the deepest EXISTING ancestor of the target's directory is resolved with
//      realpathSync.native and must lie inside the project root's realpathSync.native. A junction or symlink at `.claude`,
//      or anywhere above the target, that leads outside is REFUSED before anything is created or written. An unresolvable
//      root fails closed.
//   1b. (CWK2-037) the folder pin: a link ANYWHERE between the project root and the target's folder is refused even when it leads to another folder inside the project.
//   2. temp-then-rename (node/runtime.md 5): the bytes go to a per-pid temp created exclusive, then renameSync replaces
//      the destination ENTRY. A link planted at the destination (or at the `.bak`) is replaced, never written through. A
//      failed rename keeps the old file, removes the temp, and never falls back to an in-place write. (CoalMine's
//      Windows in-place fallback is NOT ported: node/runtime.md 5 forbids it, and a link-following fallback is the hole.)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoFs = createRequire(import.meta.url)('../../lib/repo-fs.js');
export const { MAX_CONFIG_BYTES, readRepoBytes, readRepoText, writeTempExclusive, isContained, folderChain, repoEntryInfo, sameEntry, REPO_READ_FLAGS } = repoFs;

// T-29kw-1: the bytes AND the identity of a bounded regular file through ONE descriptor. The refusal gate is the shipped
// module's own repoEntryInfo (decided by path before any open, exactly as readRepoBytes decides it) and the open flags are
// its REPO_READ_FLAGS. The shipped readRepoBytes returns no fstat, and changing lib/repo-fs.js would change plugin/ and so
// the version, so the open / fstat / bounded read / close below restates readRepoBytes's descriptor half, once, here.
// The identity (dev, ino, size, mtimeMs) is the descriptor's, so a caller compares the NAME's lstat with it, never by name.
// Used for the seeding read and for the re-check before a migration deletes its legacy file (the same read, so one helper).
export function readRepoBytesWithIdentity(file, root, maxBytes) {
  const none = (why) => ({ bytes: null, why, identity: null });
  const info = repoEntryInfo(file, root);
  if (info.kind === 'absent') return none('absent');
  if (info.kind === 'dir') return none('dir');
  if (info.kind === 'error') return none(info.code === 'EACCES' || info.code === 'EPERM' ? 'denied' : 'error');
  if (info.kind !== 'file') return none('refused');
  let fd;
  try {
    // T-82 (r29nz), the limit stated at the open: a folder in the chain swapped out and back in with exact timing between the name's check and
    // this open can still hand the reader another file; the compare below catches a swapped FILE. No Node call closes it on Windows or macOS
    // (lib/repo-fs.js readRepoBytes states the same limit at its open).
    fd = fs.openSync(file, REPO_READ_FLAGS);
    const st = fs.fstatSync(fd, { bigint: true });
    if (!sameEntry(st, info.expected)) return none('refused'); // T-76: the opened file is the one checked by name, or it is refused
    if (!st.isFile()) return none('refused');
    const size = Number(st.size);
    if (size > maxBytes) return none('too-large');
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = fs.readSync(fd, buf, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    // the identity keeps the Number form the callers compare with their own lstat (configure.mjs), so only the compare above is bigint
    const identity = { dev: Number(st.dev), ino: Number(st.ino), size, mtimeMs: Number(st.mtimeMs) };
    return { bytes: got === size ? buf : buf.subarray(0, got), why: null, identity };
  } catch (e) {
    const code = e && e.code;
    return none(code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOENT' ? 'absent' : 'error');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

export class RepoWriteRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepoWriteRefused';
    this.code = 'EREFUSED';
  }
}

// The 0444 refusal (r29mq Z, T-29mi-D2): a target the user made read-only is refused BEFORE anything is written to it, by name, and is
// never replaced. Windows reads the read-only attribute as mode 0o444, so one check covers both platforms. An lstat that fails for any
// reason but a missing file refuses too, and says so: a target that cannot be inspected is not treated as absent. Stated residual: on
// POSIX a rename needs the FOLDER's write bit, not the file's, so a file made read-only after this check is still replaced.
export class ReadOnlyRefused extends Error {
  constructor(file, why, advice) {
    super(`${file}: ${why} -- ${advice}`);
    this.name = 'ReadOnlyRefused';
    this.code = 'EREADONLY';
    this.file = file;
    this.why = why;
    this.advice = advice;
  }
}

export function refuseIfReadOnly(target) {
  let st;
  try { st = fs.lstatSync(target); }
  catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw new ReadOnlyRefused(target, `it could not be inspected (${(e && e.code) || 'error'}); nothing was written`, 'check that file by hand, then run this again.');
  }
  if (st.isFile() && (st.mode & 0o222) === 0) throw new ReadOnlyRefused(target, 'read-only; nothing was written', 'make the file writable if you mean to change it, then run this again.');
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
  // CWK2-037: the FOLDER PIN comes first (see folderChain in lib/repo-fs.js): a link at any folder between the root and the target is refused wherever it points, a target inside the project
  // included, because the containment compare below only asks that the resolved folder stay inside the project. A folder that does not exist yet ends the walk (nothing to redirect).
  const chain = folderChain(path.resolve(target), root);
  if (!chain.ok && chain.link) throw new RepoWriteRefused(`${target} sits behind a link at ${chain.link}`);
  if (!chain.ok && chain.why === 'error') throw new RepoWriteRefused(`${target} cannot be checked against the project root ${root}`); // 'outside' (not lexically under the root) is judged by the realpath containment below
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch { throw new RepoWriteRefused(`the project root ${root} cannot be resolved`); }
  let realAnc;
  try { realAnc = fs.realpathSync.native(deepestExisting(path.dirname(path.resolve(target)))); } catch { throw new RepoWriteRefused(`${target} cannot be resolved`); }
  if (!isContained(realAnc, realRoot)) throw new RepoWriteRefused(`${target} leads outside the project (${realAnc} is not inside ${realRoot})`);
}

// Create the directory, then replace `target` with `content` through a temp. `root` null = no containment (the user's
// own global config, which dotfile managers legitimately link).
// DIVERGENCE from CoalMine 02dff20 (CWK2-069): a leftover `<target>.<pid>.tmp` is REPLACED here (writeTempExclusive, CWK-137 R14), not refused.
export function writeRepoFile(target, content, root) {
  if (root != null) checkRepoWriteTarget(target, root);
  refuseIfReadOnly(target); // before the folder is made and before the temp exists
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeTempExclusive(temp, content);
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort: the rename normally consumed it */ }
  }
}
