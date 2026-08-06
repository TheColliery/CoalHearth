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
