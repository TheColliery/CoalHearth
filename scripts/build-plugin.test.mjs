import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist } from './build-plugin.mjs';

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
