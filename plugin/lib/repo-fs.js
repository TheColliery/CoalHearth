// CWK-137 (R14): the read and write primitives for every file a cloned repo can plant. The class, from
// CoalMine v3.20.2: an unbounded read (a FIFO hangs the hook, /dev/zero allocates until the process dies, a
// multi-gigabyte file does the same slowly) and a write that follows a link out of the project.
//
// READ -- readRepoBytes / readRepoText / readRepoFileBounded. The order is load-bearing:
//   1. lstat kind gate BEFORE any open. A regular file proceeds. A symlink proceeds only when its realpath.native
//      lies inside the root's realpath.native AND it resolves to a regular file. A FIFO, device, socket, directory,
//      or an escaping/dangling/looping link is decided without opening anything.
//   2. open(O_RDONLY | O_NONBLOCK) (0 where the flag does not exist: Windows), so a FIFO swapped in after the lstat
//      still cannot block.
//   3. fstat the OPENED fd: regular file again, then the size bound. Over the bound = SKIPPED, never truncated: a
//      truncated config would parse as malformed and a truncated journal would resume the wrong state.
//   4. read at most the fstat'd size.
// `root` null = no containment: the user's OWN home files (the global config, the update stamp) are legitimately
// symlinked by dotfile managers, but they still get the kind gate and the bound, because /dev/zero there is still
// a hang. RESIDUAL, named: a regular file swapped in between the lstat and the open may lie outside the root; the
// fd check still holds it to a bounded regular-file read. O_NONBLOCK guards only that swap (the lstat gate masks it
// everywhere else), which no deterministic test reaches -- the one mutation row that survives by design.
//
// The bounds, measured 2026-10-03 over every repo under source/repos (36,953 files): the largest real
// `.coalhearth.json` is 1,189 B (the shipped commented template), the largest journal 7,000 B, the largest
// AGENTS.md 183,871 B (the umbrella constitution), and no `task.md` exists. MAX_CONFIG_BYTES is ~880x the largest
// config; MAX_JOURNAL_BYTES ~600x the largest journal (modifiedFiles accumulates, so it needs the room: ~40,000
// distinct paths at ~100 B); MAX_DOC_BYTES ~23x the largest governance file. MAX_STAMP_BYTES holds a millisecond
// timestamp (13 digits) with ~75x room.
// Keep this file the ONE implementation: the ESM CLI side (scripts/lib/repo-fs.mjs) re-exports it, never copies it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_STAMP_BYTES = 1024;
const REPO_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

function isContained(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// What `p` is, decided WITHOUT opening it: { kind: 'file' | 'dir' | 'absent' | 'refused' | 'error', code? }.
function repoEntryInfo(p, root) {
  let lst;
  try { lst = fs.lstatSync(p); } catch (e) {
    const code = e && e.code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'error', code };
  }
  let realRoot = null;
  if (root != null) {
    try { realRoot = fs.realpathSync.native(root); } catch { return { kind: 'refused' }; } // an unresolvable root fails CLOSED
  }
  try {
    if (realRoot !== null && !isContained(fs.realpathSync.native(p), realRoot)) return { kind: 'refused' };
    const st = lst.isSymbolicLink() ? fs.statSync(p) : lst;
    if (st.isFile()) return { kind: 'file' };
    if (st.isDirectory()) return { kind: 'dir' };
    return { kind: 'refused' }; // not a regular file or directory: a FIFO, device or socket (or a link to one), decided with no open
  } catch (e) {
    return { kind: e && e.code === 'ENOENT' ? 'absent' : 'refused', code: e && e.code }; // a dangling link is absent; a loop is refused
  }
}

// The bytes of a regular file inside `root`, or { bytes: null, why }. why: 'absent' | 'dir' | 'refused' |
// 'too-large' | 'denied' (EACCES/EPERM) | 'error' (any other fs error: a race, an exotic code).
function readRepoBytes(file, root, maxBytes) {
  const info = repoEntryInfo(file, root);
  if (info.kind === 'absent') return { bytes: null, why: 'absent' };
  if (info.kind === 'dir') return { bytes: null, why: 'dir' };
  if (info.kind === 'error') return { bytes: null, why: info.code === 'EACCES' || info.code === 'EPERM' ? 'denied' : 'error' };
  if (info.kind !== 'file') return { bytes: null, why: 'refused' };
  let fd;
  try {
    fd = fs.openSync(file, REPO_READ_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { bytes: null, why: 'refused' };
    if (st.size > maxBytes) return { bytes: null, why: 'too-large' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return { bytes: got === st.size ? buf : buf.subarray(0, got), why: null };
  } catch (e) {
    const code = e && e.code;
    return { bytes: null, why: code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOENT' ? 'absent' : 'error' };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}
function readRepoText(file, root, maxBytes) {
  const r = readRepoBytes(file, root, maxBytes);
  return { text: r.bytes === null ? null : r.bytes.toString('utf8'), why: r.why };
}
// The common caller: the text, or null for anything that is not a readable, in-bound regular file.
function readRepoFileBounded(file, root, maxBytes) {
  return readRepoText(file, root, maxBytes).text;
}

module.exports = {
  MAX_CONFIG_BYTES, MAX_JOURNAL_BYTES, MAX_DOC_BYTES, MAX_STAMP_BYTES, REPO_READ_FLAGS,
  isContained, repoEntryInfo, readRepoBytes, readRepoText, readRepoFileBounded,
};
