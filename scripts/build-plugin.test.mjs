import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_ITEMS, buildDist, checkDist } from './build-plugin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-dist-test-'));
}

// EOL-agnostic on a TEXT_EXTS file: robust to whatever line-ending convention
// this checkout actually has (board #47's `.gitattributes` conform + local
// core.autocrlf means the real files on disk may be CRLF or LF) — flip
// relative to what the source bytes ACTUALLY are, never assume one direction.
function flipEol(buf) {
  const text = buf.toString('latin1');
  return Buffer.from(
    buf.includes(Buffer.from('\r\n')) ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n'),
    'latin1'
  );
}

test('buildDist + checkDist round-trip clean against the real source', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  assert.deepEqual(checkDist(distRoot), []);
  fs.rmSync(distRoot, { recursive: true, force: true });
});

test('checkDist flags a stale file', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  fs.writeFileSync(path.join(distRoot, '.claude-plugin', 'plugin.json'), '{}');
  const drift = checkDist(distRoot);
  assert.ok(drift.some((d) => d.includes('stale')));
  fs.rmSync(distRoot, { recursive: true, force: true });
});

test('checkDist flags an orphan top-level entry', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  fs.mkdirSync(path.join(distRoot, 'scripts'));
  const drift = checkDist(distRoot);
  assert.ok(drift.some((d) => d.includes('orphan top-level')));
  fs.rmSync(distRoot, { recursive: true, force: true });
});

// board #59: a dist copy that differs from source ONLY by CRLF-vs-LF line
// endings (board #47's `.gitattributes` conform lets two checkouts of ONE
// commit differ this way for byte-identical content) must NOT read as stale —
// that was the false-positive checkDist reported before filesMatch existed.
test('a dist copy differing from source only by CRLF-vs-LF on a TEXT_EXTS file reads as in sync', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  const rel = path.join('.claude-plugin', 'plugin.json');
  const srcBytes = fs.readFileSync(path.join(repoRoot, rel));
  const flipped = flipEol(srcBytes);
  assert.notDeepEqual(flipped, srcBytes, 'fixture setup: the flip must actually change the bytes');
  fs.writeFileSync(path.join(distRoot, rel), flipped);
  const drift = checkDist(distRoot);
  assert.ok(!drift.some((d) => d.includes(rel)), `expected no stale entry for ${rel}, got: ${JSON.stringify(drift)}`);
  fs.rmSync(distRoot, { recursive: true, force: true });
});

// board #59: a REAL content edit made under CRLF line endings must still fail
// loud. INSERTION-shaped deliberately (adding a token the original did not
// have) — a delete/replace-shaped edit can pass against a sabotaged predicate
// that only checks length or removal; an insertion is the shape that actually
// catches a broken equality check (CoalLedger's own INSPECT finding, ported).
test('a real content INSERTION under CRLF line endings still fails loud (stale, not silently accepted)', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  const rel = path.join('.claude-plugin', 'plugin.json');
  const srcBytes = fs.readFileSync(path.join(repoRoot, rel));
  const eol = srcBytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  // Insert a token the source does not have, on ITS OWN new line, so this is
  // unambiguously an addition (not a replace/delete of existing bytes).
  const withInsertion = Buffer.from(srcBytes.toString('latin1') + `// COALHEARTH-BOARD-59-CANARY-INSERTION${eol}`, 'latin1');
  fs.writeFileSync(path.join(distRoot, rel), withInsertion);
  const drift = checkDist(distRoot);
  assert.ok(drift.some((d) => d.includes('stale') && d.includes(rel)), `expected a stale entry for ${rel}, got: ${JSON.stringify(drift)}`);
  fs.rmSync(distRoot, { recursive: true, force: true });
});

// CWK-120 finding #9 (CodeRabbit, Trivial), verified at the live tree: DIST_ITEMS names ONE file inside .claude-plugin
// (plugin.json), so checkDist accounted for that file's own path and treated the whole .claude-plugin directory as
// allowed at the top level -- an EXTRA file committed beside it in plugin/.claude-plugin/ matched no DIST_ITEM, was
// listed by neither per-item loop, and passed every gate: an undeclared file shipping in the marketplace dist.
test('checkDist flags an orphan file inside a directory a file-shaped DIST_ITEM lives in (plugin/.claude-plugin/)', () => {
  const distRoot = mkTmp();
  try {
    buildDist(distRoot);
    assert.deepEqual(checkDist(distRoot), [], 'fixture setup: a fresh build is in sync');
    fs.writeFileSync(path.join(distRoot, '.claude-plugin', 'settings.json'), '{}');
    const drift = checkDist(distRoot);
    assert.ok(
      drift.some((d) => d.startsWith('orphan in plugin/ (no DIST_ITEM):') && d.includes('settings.json')),
      'expected the undeclared sibling to be reported by name, got: ' + JSON.stringify(drift),
    );
  } finally {
    fs.rmSync(distRoot, { recursive: true, force: true });
  }
});

test('checkDist flags an orphan DIRECTORY there too, and still passes the declared file alone', () => {
  const distRoot = mkTmp();
  try {
    buildDist(distRoot);
    fs.mkdirSync(path.join(distRoot, '.claude-plugin', 'extra'));
    assert.ok(checkDist(distRoot).some((d) => d.includes('extra')), 'an undeclared subdirectory is an orphan as well');
    fs.rmSync(path.join(distRoot, '.claude-plugin', 'extra'), { recursive: true });
    assert.deepEqual(checkDist(distRoot), [], 'plugin.json alone is exactly what is declared');
  } finally {
    fs.rmSync(distRoot, { recursive: true, force: true });
  }
});

// R19 (CodeRabbit PR #19 thread 12): a dist entry that EXISTS but is not a directory made fs.readdirSync throw ENOTDIR inside the
// orphan scan, so checkDist never returned its drift report (a raw stack trace from a gate, scripts-quality.md 1). The bad entry is
// now a finding line and the scan keeps going.
test('checkDist reports a plugin/.claude-plugin that is a regular FILE, never throws, and keeps scanning', () => {
  const distRoot = mkTmp();
  try {
    buildDist(distRoot);
    fs.rmSync(path.join(distRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(distRoot, '.claude-plugin'), 'not a directory');
    fs.mkdirSync(path.join(distRoot, 'scripts')); // a SECOND defect, found only if the scan continues past the first
    let drift;
    assert.doesNotThrow(() => { drift = checkDist(distRoot); });
    assert.ok(drift.some((d) => d.startsWith('invalid in plugin/ (not a directory):') && d.includes('.claude-plugin')),
      'the bad entry is named: ' + JSON.stringify(drift));
    assert.ok(drift.some((d) => d.includes('orphan top-level') && d.includes('scripts')), 'and the scan continued to the next defect: ' + JSON.stringify(drift));
  } finally {
    fs.rmSync(distRoot, { recursive: true, force: true });
  }
});

test('checkDist reports a dist ROOT that is a regular file instead of throwing', () => {
  const tmp = mkTmp();
  try {
    const distRoot = path.join(tmp, 'plugin');
    fs.writeFileSync(distRoot, 'not a directory');
    let drift;
    assert.doesNotThrow(() => { drift = checkDist(distRoot); });
    assert.ok(drift.some((d) => d.startsWith('invalid plugin/ (not a directory):')), 'the root is named: ' + JSON.stringify(drift));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// R19 FIXBACK 1, LOW-1 (the sibling site of thread 12, one call deeper): a dist entry that is a DIRECTORY where the source holds a FILE made filesMatch's readFileSync
// throw EISDIR, so the rest of the drift report was lost. It is a finding line now (`invalid in plugin/ (not a file): <rel>`) and the scan goes on.
test('checkDist reports a dist entry that is a DIRECTORY where the source is a file, never throws, and keeps scanning', () => {
  const distRoot = mkTmp();
  try {
    buildDist(distRoot);
    const victim = path.join(distRoot, 'bin', 'session-start.js');
    fs.rmSync(victim);
    fs.mkdirSync(victim); // the dist holds a directory where the source holds a file
    fs.mkdirSync(path.join(distRoot, 'scripts')); // a SECOND defect, found only if the scan continues past the first
    let drift;
    assert.doesNotThrow(() => { drift = checkDist(distRoot); });
    assert.ok(drift.some((d) => d.startsWith('invalid in plugin/ (not a file):') && d.includes('session-start.js')),
      'the bad entry is named: ' + JSON.stringify(drift));
    assert.ok(drift.some((d) => d.includes('orphan top-level') && d.includes('scripts')), 'and the scan continued to the next defect: ' + JSON.stringify(drift));
    assert.ok(!drift.some((d) => d.startsWith('stale in plugin/') && d.includes('session-start.js')), 'and it is not ALSO reported as stale: ' + JSON.stringify(drift));
  } finally {
    fs.rmSync(distRoot, { recursive: true, force: true });
  }
});

// 08b (CWK-202 pilot): the Antigravity plugin manifest and hooks.json ride the dist like every other item, so the folder AG registers
// (plugin/) holds plugin.json + hooks.json AND the bin/ + lib/ the hooks run.
test('08b: DIST_ITEMS carries the Antigravity plugin.json and hooks.json, and the built dist holds them byte-identical to source', () => {
  assert.ok(DIST_ITEMS.includes('plugin.json'), 'plugin.json is a DIST_ITEM');
  assert.ok(DIST_ITEMS.includes('hooks.json'), 'hooks.json is a DIST_ITEM');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-build-08b-'));
  try {
    buildDist(tmp);
    for (const f of ['plugin.json', 'hooks.json']) {
      assert.ok(fs.existsSync(path.join(tmp, f)), f + ' is in the built dist');
      assert.strictEqual(fs.readFileSync(path.join(tmp, f), 'utf8'), fs.readFileSync(path.join(repoRoot, f), 'utf8'), f + ' matches source');
    }
    assert.deepStrictEqual(checkDist(tmp), [], 'the dist is in sync');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The builder never copies, follows or writes through a link, and the check names a link instead of following it.
// Each witness runs on a scratch copy of the DIST_ITEM sources, so a planted link never touches the room.
// A leg whose link kind this volume cannot make skips visibly (probed, never decided by platform).
// ---------------------------------------------------------------------------
function scratchSources(prefix) {
  const src = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const rel of DIST_ITEMS) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.cpSync(path.join(repoRoot, rel), path.join(src, rel), { recursive: true });
  }
  return src;
}
// true when this volume can make the link kind; the probe runs inside the named scratch folder only.
function canLink(dir, kind) {
  try {
    const target = path.join(dir, `probe-target-${kind}`);
    if (kind === 'junction') fs.mkdirSync(target); else fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, `probe-link-${kind}`), kind);
    return true;
  } catch { return false; }
}
function scratchDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function allFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? allFiles(p) : [p];
  });
}
function anyFileHolds(dir, marker) {
  return allFiles(dir).some((f) => { try { return fs.readFileSync(f, 'utf8').includes(marker); } catch { return false; } });
}
const LINK_REFUSAL = /link or junction/;

test('buildDist refuses a folder link inside a source it copies, names it, and copies none of its bytes', (t) => {
  const src = scratchSources('ch-src-dirlink-');
  const dist = scratchDir('ch-dist-dirlink-');
  const outside = scratchDir('ch-out-dirlink-');
  t.after(() => { for (const d of [src, dist, outside]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-FOLDER-BYTES');
  fs.symlinkSync(outside, path.join(src, 'lib', 'linked-out'), 'junction');
  assert.throws(() => buildDist(dist, src), LINK_REFUSAL, 'a folder link in a source is refused, and the refusal names it');
  assert.equal(anyFileHolds(dist, 'OUTSIDE-FOLDER-BYTES'), false, 'the linked folder content reaches no dist file');
});

test('buildDist refuses a file link inside a source, and never writes through it', (t) => {
  const src = scratchSources('ch-src-filelink-');
  const dist = scratchDir('ch-dist-filelink-');
  const outside = scratchDir('ch-out-filelink-');
  t.after(() => { for (const d of [src, dist, outside]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'file')) { t.skip('this volume refuses file symlinks without privilege (probe: symlink EPERM)'); return; }
  const target = path.join(outside, 'outside.js');
  fs.writeFileSync(target, 'OUTSIDE-ORIGINAL');
  fs.symlinkSync(target, path.join(src, 'bin', 'linked-file.js'));
  assert.throws(() => buildDist(dist, src), LINK_REFUSAL, 'a file link in a source is refused, and the refusal names it');
  assert.equal(fs.readFileSync(target, 'utf8'), 'OUTSIDE-ORIGINAL', 'the file the link points at is untouched');
});

test('buildDist refuses a dotfile link inside a source it copies', (t) => {
  const src = scratchSources('ch-src-dotlink-');
  const dist = scratchDir('ch-dist-dotlink-');
  const outside = scratchDir('ch-out-dotlink-');
  t.after(() => { for (const d of [src, dist, outside]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  fs.writeFileSync(path.join(outside, 'dot-secret.txt'), 'OUTSIDE-DOTFILE-BYTES');
  fs.symlinkSync(outside, path.join(src, 'bin', '.hidden-link'), 'junction');
  assert.throws(() => buildDist(dist, src), LINK_REFUSAL, 'a dot-named link is refused like any other');
  assert.equal(anyFileHolds(dist, 'OUTSIDE-DOTFILE-BYTES'), false, 'the dot-named link reaches no dist file');
});

test('buildDist refuses a junction at .claude-plugin, the parent of a DIST_ITEM, and keeps the outside bytes out of plugin/', (t) => {
  const src = scratchSources('ch-src-parent-cp-');
  const dist = scratchDir('ch-dist-parent-cp-');
  const outside = scratchDir('ch-out-parent-cp-');
  t.after(() => { for (const d of [src, dist, outside]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  fs.writeFileSync(path.join(outside, 'plugin.json'), 'OUTSIDE-PARENT-CP-BYTES');
  fs.rmSync(path.join(src, '.claude-plugin'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(src, '.claude-plugin'), 'junction');
  assert.throws(() => buildDist(dist, src), LINK_REFUSAL, 'a link at a parent of a DIST_ITEM is refused, and the refusal names it');
  assert.equal(anyFileHolds(dist, 'OUTSIDE-PARENT-CP-BYTES'), false, 'the parent link reaches no dist file');
});

test('buildDist refuses a linked dist ROOT before it removes anything, and leaves the link target intact', (t) => {
  const src = scratchSources('ch-src-distroot-');
  const outside = scratchDir('ch-out-distroot-');
  const holder = scratchDir('ch-holder-distroot-');
  const distRoot = path.join(holder, 'plugin');
  t.after(() => { for (const d of [src, outside, holder]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'OUTSIDE-DIST-ROOT-TARGET');
  fs.symlinkSync(outside, distRoot, 'junction');
  assert.throws(() => buildDist(distRoot, src), /dist root|link or junction/, 'a linked dist root is refused, and the refusal names it');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'OUTSIDE-DIST-ROOT-TARGET', 'the link target is not removed or rewritten');
});

test('checkDist names a dangling link in a DIST_ITEM instead of passing it as absent', (t) => {
  const src = scratchSources('ch-src-dangle-');
  const dist = scratchDir('ch-dist-dangle-');
  t.after(() => { for (const d of [src, dist]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  buildDist(dist, src);
  const gone = path.join(src, 'gone-target');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(src, 'bin', 'dangling-link'), 'junction');
  fs.rmSync(gone, { recursive: true, force: true });
  const out = checkDist(dist, src);
  assert.ok(out.some((l) => /symlink/.test(l) && l.includes('dangling-link')),
    `checkDist must name the dangling link; got: ${JSON.stringify(out)}`);
});

test('checkDist names a folder link in the DIST that points at its own parent, and does not descend into it', (t) => {
  const src = scratchSources('ch-src-loop-');
  const dist = scratchDir('ch-dist-loop-');
  t.after(() => { for (const d of [src, dist]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  buildDist(dist, src);
  const parent = path.join(dist, 'bin');
  fs.symlinkSync(parent, path.join(parent, 'loop'), 'junction');
  const out = checkDist(dist, src);
  assert.ok(out.some((l) => /symlink/.test(l) && l.includes('loop')),
    `checkDist must name the looping link; got: ${JSON.stringify(out)}`);
});

test('checkDist names a FILE link in the dist, even where the bytes behind it match the source', (t) => {
  const src = scratchSources('ch-src-distfile-');
  const dist = scratchDir('ch-dist-distfile-');
  t.after(() => { for (const d of [src, dist]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'file')) { t.skip('this volume refuses file symlinks without privilege (probe: symlink EPERM)'); return; }
  buildDist(dist, src);
  const victim = path.join(dist, 'bin', 'session-start.js');
  const copy = path.join(src, 'session-start-copy.js');
  fs.copyFileSync(victim, copy);
  fs.rmSync(victim);
  fs.symlinkSync(copy, victim);
  const out = checkDist(dist, src);
  assert.ok(out.some((l) => /symlink/.test(l) && l.includes('session-start.js')),
    `checkDist must name the file link; got: ${JSON.stringify(out)}`);
});

test('checkDist names a junction at a parent component of a DIST_ITEM instead of comparing through it', (t) => {
  const src = scratchSources('ch-src-parent-chk-');
  const dist = scratchDir('ch-dist-parent-chk-');
  const outside = scratchDir('ch-out-parent-chk-');
  t.after(() => { for (const d of [src, dist, outside]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  buildDist(dist, src);
  fs.writeFileSync(path.join(outside, 'plugin.json'), 'OUTSIDE-PARENT-CHK-BYTES');
  fs.rmSync(path.join(src, '.claude-plugin'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(src, '.claude-plugin'), 'junction');
  const out = checkDist(dist, src);
  assert.ok(out.some((l) => /symlink/.test(l) && l.includes('.claude-plugin')),
    `checkDist must name the parent link; got: ${JSON.stringify(out)}`);
});

test('checkDist names a linked dist ROOT instead of following it', (t) => {
  const src = scratchSources('ch-src-distroot-chk-');
  const outside = scratchDir('ch-out-distroot-chk-');
  const holder = scratchDir('ch-holder-distroot-chk-');
  const distRoot = path.join(holder, 'plugin');
  t.after(() => { for (const d of [src, outside, holder]) fs.rmSync(d, { recursive: true, force: true }); });
  if (!canLink(src, 'junction')) { t.skip('this volume cannot make a junction (probe: junction failed)'); return; }
  fs.symlinkSync(outside, distRoot, 'junction');
  const out = checkDist(distRoot, src);
  assert.ok(out.some((l) => /symlink/.test(l) && /plugin/.test(l)),
    `checkDist must name the linked dist root; got: ${JSON.stringify(out)}`);
});
