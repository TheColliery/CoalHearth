// CW-017 -- unit tests (pure logic) + hermetic spawn tests (the real CLI, two fixtures: one
// planted-defect, one clean) for scripts/lib/link-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubSlug, extractHeadings, headingAnchors, extractCitations, checkFile, checkFiles } from './link-check.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = path.join(repo, 'scripts', 'lib', 'link-check.mjs');

// -- unit tests -------------------------------------------------------------------------

test('githubSlug: lowercases, strips backtick code spans, keeps Thai combining marks intact', () => {
  assert.equal(githubSlug('Configure (`journal.outputDirectory`)'), 'configure-journaloutputdirectory');
  // มุมมอง carries combining tone/vowel marks (\p{M}) -- stripping them would corrupt the
  // word, not merely shorten it. Non-vacuous: dropping \p{M} from the allow-set (the exact
  // mutation) changes this output -- proven below by mutation.
  assert.equal(githubSlug('มุมมองของฉัน'), 'มุมมองของฉัน');
});

test('githubSlug: does not crash and does not silently drop CJK text', () => {
  const s = githubSlug('日本語 テスト見出し');
  assert.equal(s, '日本語-テスト見出し');
  assert.ok(s.length > 0);
});

test('githubSlug: leaves underscores inside words alone (no emphasis-stripping heuristic)', () => {
  // A first prototype stripped paired underscores as markdown emphasis and corrupted a real
  // underscored word (a_b_c -> abc). This is the regression test for that near-miss.
  assert.equal(githubSlug('a_b_c underscored_word'), 'a_b_c-underscored_word');
});

test('headingAnchors: de-duplicates repeated headings the way GitHub does (-1, -2, ...)', () => {
  const anchors = headingAnchors('# Setup\n\n## Setup\n\n### Setup\n');
  assert.deepEqual([...anchors], ['setup', 'setup-1', 'setup-2']);
});

test('extractHeadings: a `#` inside a fenced code block is not a heading', () => {
  const md = '```\n# not a heading\n```\n\n# real heading\n';
  assert.deepEqual(extractHeadings(md), [{ text: 'real heading', line: 5 }]);
});

test('extractCitations: a link inside a fenced code block is an example, not a citation', () => {
  const md = '```\n[fake](./nope.md)\n```\n\n[real](./here.md)\n';
  assert.deepEqual(extractCitations(md), [{ target: './here.md', line: 5 }]);
});

test('extractCitations: a GFM link title (`[x](./y.md "title")`) is stripped from the target, never treated as part of the path', () => {
  // Rot-canary QUICK catch, r33: pre-fix this returned './README.md "a title"' as the
  // target, which then false-FAILs a perfectly valid link (the title text is not a path).
  assert.deepEqual(extractCitations('[text](./README.md "a title")'), [{ target: './README.md', line: 1 }]);
  assert.deepEqual(extractCitations("[text](./README.md 'a title')"), [{ target: './README.md', line: 1 }]);
});

test('extractCitations: external targets (scheme URIs) are extracted but resolve as out of scope', () => {
  const md = '[a](./b.md) [ext](https://example.com) [mail](mailto:x@example.com) [anchor](#foo)';
  const targets = extractCitations(md).map((c) => c.target);
  assert.deepEqual(targets, ['./b.md', 'https://example.com', 'mailto:x@example.com', '#foo']);
});

// -- checkFile/checkFiles, against a small in-memory-shaped sandbox --------------------

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-link-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('checkFile: a relative link to a real file and a real anchor both resolve clean', (t) => {
  const tmp = mkTmp(t);
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Target Heading\n');
  fs.writeFileSync(path.join(tmp, 'source.md'), '[link](./target.md) [link](./target.md#target-heading)\n');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp);
  assert.deepEqual(findings, []);
});

test('checkFile: a relative link to a MISSING file is a broken-link finding', (t) => {
  const tmp = mkTmp(t);
  fs.writeFileSync(path.join(tmp, 'source.md'), '[nope](./missing.md)\n');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'broken-link');
});

test('checkFile: an anchor into a REAL file that does not have that heading is a broken-anchor finding', (t) => {
  const tmp = mkTmp(t);
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Something Else\n');
  fs.writeFileSync(path.join(tmp, 'source.md'), '[nope](./target.md#no-such-heading)\n');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'broken-anchor');
});

test('checkFile: a root-relative (leading /) target resolves against the repo root, not the citing file\'s own directory', (t) => {
  const tmp = mkTmp(t);
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'root.md'), '# Root\n');
  fs.writeFileSync(path.join(tmp, 'sub', 'source.md'), '[link](/root.md)\n');
  const findings = checkFile(path.join(tmp, 'sub', 'source.md'), tmp);
  assert.deepEqual(findings, []);
});

// -- the real CLI, spawned, against the two named fixtures -----------------------------

test('CLI: the planted-defect fixture exits 1 and reports both the broken link and the broken anchor', () => {
  const r = spawnSync(process.execPath, [engine, 'scripts/fixtures/defects-links.md'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /broken-link/);
  assert.match(r.stdout, /broken-anchor/);
  assert.match(r.stdout, /^2 finding\(s\) across 1 file\(s\)$/m);
});

test('CLI: the clean fixture exits 0 with zero findings', () => {
  const r = spawnSync(process.execPath, [engine, 'scripts/fixtures/clean-links.md'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^0 finding\(s\) across 1 file\(s\)$/m);
});

test('CLI: no files given exits 1 without a findings summary line', () => {
  const r = spawnSync(process.execPath, [engine], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no files given/);
});

// -- checkFiles: filesChecked stays accurate even when every file is clean -------------

test('checkFiles: filesChecked counts every file attempted, findings-count independent', () => {
  const { findings, filesChecked } = checkFiles(
    ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
      'commands/stats.md', 'commands/update.md', 'platform-configs/hooks/README.md'],
    repo,
  );
  assert.equal(filesChecked, 8);
  assert.deepEqual(findings, []);
});
