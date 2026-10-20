// CWK-137 (R14): the read and write primitives for every file a cloned repo can plant. The class, from
// CoalMine v3.20.2: an unbounded read (a FIFO hangs the hook, /dev/zero allocates until the process dies, a
// multi-gigabyte file does the same slowly) and a write that follows a link out of the project.
//
// READ -- readRepoBytes / readRepoText / readRepoFileBounded. The order is load-bearing:
//   1. lstat kind gate BEFORE any open. A regular file proceeds. Under a root, a symlink proceeds only when its
//      realpath.native lies inside the root's realpath.native, in the entry's OWN folder (CWK2-026, see repoEntryInfo),
//      AND it resolves to a regular file. A FIFO, device, socket, directory, or an escaping/other-folder/dangling/
//      looping link is decided without opening anything.
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
// WRITE -- writeTempExclusive, the journal temp file (see the function): a link planted at the pid-named temp used to be
// written THROUGH.
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

// CWK2-037 (15b5, the E2-4 class; hooks-safety.md section 6 row 10; node/runtime.md section 4: an allowlist pins the LITERAL expected location). A junction (Windows) or directory symlink (POSIX)
// planted at a PARENT folder of a project file (`.claude`, `.claude/coal`) leaves the file itself lstat-ing as a plain file, so the symlink test on the entry never ran and the read (or the write)
// followed the link to another folder INSIDE the project. FOLDER PIN, by lstat per component, never by comparing a realpath with a hand-joined string (case and 8.3 short names are VOLUME
// properties, so a string compare would refuse a legitimate `.Claude` or pass a wrong one): every component between `root` and the entry's own folder must be a real directory. A link at any
// of them is refused, wherever it points, a target inside the project included. `root` itself is NOT walked: a project opened through a linked path still reads its own files. Node reports a
// Windows junction as a symbolic link (measured 2026-10-15, CoalLedger 9f48634), so one lstat test covers both kinds. Returns { ok: true } for a plain chain, { ok: false, link } naming the
// first link, or { ok: false, why } for a path that is not lexically under the root or a component that cannot be lstat-ed (fail CLOSED, never a throw). A component that does not exist ends
// the walk as plain: nothing below a missing folder can redirect anything (the write guard asks this BEFORE it creates the folders). Residual, named: the check and the later open are two
// steps, so a link swapped in between is not caught here (the fd re-check in readRepoBytes only re-checks kind and size). ENTRY-LEVEL RULE (CWK2-026, 18h; it was the looser 'anywhere inside the root' rule until then, the exemplar's stricter one not adopted): under a root, a file symlink at the entry is honoured only when its
// target's realpath lies in the entry's OWN folder, path.dirname(realpath(entry)) === realpath(path.dirname(entry)), both sides through realpathSync.native. Every other link is refused, wherever it points,
// a file in another folder of the project included: a config name that quietly hands another folder's file to the reader is the entry-level twin of the folder-chain link above. The common same-folder link
// (AGENTS.md -> CLAUDE.md at the root) is kept. The write is unchanged: it replaces the link (temp + rename), never writes through it. root null (the user's own home files) follows links as before.
function folderChain(p, root) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { ok: false, why: 'outside' };
  let cur = path.resolve(root);
  for (const part of rel.split(path.sep).slice(0, -1)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { ok: true } : { ok: false, why: 'error' }; }
    if (st.isSymbolicLink()) return { ok: false, link: cur };
  }
  return { ok: true };
}
// What `p` is, decided WITHOUT opening it: { kind: 'file' | 'dir' | 'absent' | 'refused' | 'error', code? }.
function repoEntryInfo(p, root) {
  let lst;
  try { lst = fs.lstatSync(p); } catch (e) {
    const code = e && e.code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'error', code };
  }
  if (root != null && !folderChain(p, root).ok) return { kind: 'refused' }; // CWK2-037: a link on the folder chain, wherever it points
  let realRoot = null;
  if (root != null) {
    try { realRoot = fs.realpathSync.native(root); } catch { return { kind: 'refused' }; } // an unresolvable root fails CLOSED
  }
  try {
    if (realRoot !== null) {
      const realP = fs.realpathSync.native(p);
      if (!isContained(realP, realRoot)) return { kind: 'refused' };
      // CWK2-026: a link is honoured only in the entry's own folder (a plain file always is: its realpath's folder is its folder's realpath)
      if (lst.isSymbolicLink() && path.dirname(realP) !== fs.realpathSync.native(path.dirname(p))) return { kind: 'refused' };
    }
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

// WRITE -- the journal's temp file is named from the pid alone, so a link planted at that name (a symlink a cloned repo
// commits, or a hard link any local process makes) used to be WRITTEN THROUGH, into whatever it pointed at. The temp is
// created exclusive (`wx`: it never opens an existing entry, a dangling link included). If the name is taken, the ENTRY
// is removed (rmSync unlinks a link, never follows it; a hard link's other name keeps its bytes) and created again
// exclusive, so the bytes always land in a fresh regular file and the rename that follows replaces the directory entry.
// A leftover temp from a crashed holder of the same pid takes the same path. Any other error propagates to the caller's
// existing fail-silent handling.
function writeTempExclusive(temp, content) {
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    return;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
}

module.exports = {
  MAX_CONFIG_BYTES, MAX_JOURNAL_BYTES, MAX_DOC_BYTES, MAX_STAMP_BYTES, REPO_READ_FLAGS,
  isContained, folderChain, repoEntryInfo, readRepoBytes, readRepoText, readRepoFileBounded, writeTempExclusive,
};
