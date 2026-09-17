// CW-017 -- unit tests (pure logic) + hermetic spawn tests (the real CLI, two fixtures: one
// planted-defect, one clean) for scripts/lib/link-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubSlug, extractHeadings, headingAnchors, extractCitations, checkFile, checkFiles, Anchorer, buildTrackedIndex } from './link-check.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = path.join(repo, 'scripts', 'lib', 'link-check.mjs');
const workflowPath = path.join(repo, '.github', 'workflows', 'link-check.yml');

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

test('extractCitations: a GFM link title containing an apostrophe is stripped whole, r34 LOW 2', () => {
  // pre-fix: the title regex excluded BOTH quote characters from its own content, so an
  // apostrophe inside a double-quoted title broke the match and glued the whole title to
  // the destination -- measured false-FAIL against a perfectly valid link.
  assert.deepEqual(extractCitations('[x](./a.md "it\'s a title")'), [{ target: './a.md', line: 1 }]);
});

test('extractCitations: an angle-bracket GFM destination (`<./a b.md>`) is unwrapped, r34 LOW 2', () => {
  assert.deepEqual(extractCitations('[x](<./a b.md>)'), [{ target: './a b.md', line: 1 }]);
  assert.deepEqual(extractCitations('[x](<./a b.md> "a title")'), [{ target: './a b.md', line: 1 }]);
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

// r34 MEDIUM 1 -- "resolves" means TRACKED, not merely present on disk. Safety rail
// (dispatch-transport.md, r33 amendment 6): `git init` runs FIRST, before anything else
// touches this directory, and no `git config` is ever called here at all -- `git ls-files`
// reads the INDEX, which `git add` alone already populates, so this test never needs an
// identity to commit with.
test('checkFile: a target that exists on disk but is UNTRACKED is a broken-link finding, never a clean pass', (t) => {
  const tmp = mkTmp(t);
  spawnSync('git', ['init', '-q', '.'], { cwd: tmp, encoding: 'utf8' });
  fs.writeFileSync(path.join(tmp, 'tracked.md'), '# Tracked\n');
  fs.writeFileSync(path.join(tmp, 'untracked.md'), '# Untracked\n');
  spawnSync('git', ['add', 'tracked.md'], { cwd: tmp, encoding: 'utf8' }); // NOT untracked.md
  fs.writeFileSync(path.join(tmp, 'source.md'), '[ok](./tracked.md)\n[bad](./untracked.md)\n');
  spawnSync('git', ['add', 'source.md'], { cwd: tmp, encoding: 'utf8' });

  const trackedIndex = buildTrackedIndex(tmp);
  assert.ok(trackedIndex, 'buildTrackedIndex must succeed inside a real git repo');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp, trackedIndex);
  assert.equal(findings.length, 1, `expected exactly the untracked target to fail, got ${JSON.stringify(findings)}`);
  assert.equal(findings[0].kind, 'broken-link');
  assert.equal(findings[0].target, './untracked.md');
  assert.match(findings[0].message, /UNTRACKED/);
});

test('checkFile: with no trackedIndex supplied, tracked-checking is skipped (exists-only, the pre-r34 shape) -- pure fixtures never need git', (t) => {
  const tmp = mkTmp(t);
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Target\n');
  fs.writeFileSync(path.join(tmp, 'source.md'), '[ok](./target.md)\n');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp); // no trackedIndex arg
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

// -- r34 MEDIUM 2: the WORKFLOW FILE's own shape, read as TEXT -----------------------------
// The first test in this flock to read a SHIPPED WORKFLOW FILE and assert on its shape --
// main's own ruling (r34, CW-017 MEDIUM-2): the workflow is shipped bytes and this test
// asserts a shipped CONTRACT, the same class every other test in this file already is. No
// YAML library (Phoenix #2, zero-dep) -- plain string/regex matching on the file's own text
// pins three claims the workflow's own comments already make in prose: (1) the step actually
// INVOKES the engine, (2) it carries NO `continue-on-error` (a report-only gate is the
// cry-wolf shape this room exists to ban), (3) the empty-file-list guard exits 1 BEFORE the
// engine ever runs. A fourth guards r34 MEDIUM 3's own widening from silently regressing: NO
// `paths:` filter anywhere in the trigger.
test('workflow: link-check.yml invokes the engine, is never continue-on-error, keeps its empty-list guard, and has no paths: filter', () => {
  const yml = fs.readFileSync(workflowPath, 'utf8');
  assert.match(yml, /node scripts\/lib\/link-check\.mjs/, 'the step must invoke the real engine');
  // r34-RED-PROOF found this while mutating: `- continue-on-error: true` (the key as the
  // FIRST field of the step, dash-prefixed -- a completely ordinary YAML step shape) evaded
  // a bare `^\s*continue-on-error` anchor, because the anchor allowed only whitespace before
  // the key and a real step here opens with `- `. Match an optional leading `- ` too.
  assert.doesNotMatch(yml, /^\s*-?\s*continue-on-error\s*:/m, 'this gate is never report-only (a live key, not a comment mentioning the phrase)');
  assert.match(yml, /if \[ -z "\$files" \]/, 'the empty-file-list guard must be present');
  assert.match(yml, /exit 1/, 'the guard must actually exit non-zero');
  // r34-RED-PROOF found a second gap the same way: `\n\s*paths:\s*\n` only catches BLOCK-style
  // `paths:` (a bare key, list on following lines) and misses FLOW-style `paths: ['**.md']`
  // (content on the same line) -- both are valid YAML and both reintroduce the exact
  // regression MEDIUM 3 removed. Match the key at line-start regardless of what follows it;
  // a `# ... paths: ...` comment line still does not match, since `#` intervenes before the
  // key.
  assert.doesNotMatch(yml, /^\s*paths\s*:/m, 'r34 MEDIUM 3: no paths: filter -- widened on purpose, must not silently regress');
});

test('checkFiles: filesChecked counts every file attempted, findings-count independent', () => {
  const { findings, filesChecked } = checkFiles(
    ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
      'commands/stats.md', 'commands/update.md', 'platform-configs/hooks/README.md'],
    repo,
  );
  assert.equal(filesChecked, 8);
  assert.deepEqual(findings, []);
});

// -- CWK-098 slug oracle (r34 HIGH) ------------------------------------------------------
// 39 vectors, pasted VERBATIM (every code point \u-escaped, none typed literally -- this
// room's own recorded lesson on invisible-character corruption, AGENTS.md "THE SOURCE'S
// VARIABLES ARE NOT OURS") from `scratchpad/r34/out/test-vectors.json`. Source: CWK-098 THE
// SLUG ORACLE, GitHub's own `POST /markdown` render -- `scratchpad/r34/slug-oracle.md` (a
// scratch record, not shipped; read there for the discriminating heading per clause and the
// deriving command). Per the order's own addendum: scratchpad/ is untracked, so this test
// never imports from it -- the vectors are copied, not referenced.
const SLUG_VECTORS = [
  {
    clause: 'case: ASCII lowercased',
    where: 'CoalMine-README:145',
    heading: 'Commands',
    anchor: 'commands',
  },
  {
    clause: 'emoji dropped, its SPACE kept: leading hyphen',
    where: 'CoalHearth-README:3',
    heading: '\u{1f525} CoalHearth',
    anchor: '-coalhearth',
  },
  {
    clause: 'VS16 (U+FE0F, Mn) KEPT after its emoji is dropped',
    where: 'CoalMine-README:171',
    heading: '\u2699\ufe0f Configure (.coalmine.json)',
    anchor: '\ufe0f-configure-coalminejson',
  },
  {
    clause: 'em dash dropped between two spaces: double hyphen',
    where: 'CoalHearth-README:83',
    heading: 'Claude Code \u2014 validated',
    anchor: 'claude-code--validated',
  },
  {
    clause: 'middot dropped between spaces',
    where: 'CoalHearth-README:118',
    heading: 'Gemini CLI \u00b7 Copilot CLI \u00b7 Devin CLI \u00b7 Kiro \u00b7 Augment \u2014 works with (config-only ports)',
    anchor: 'gemini-cli--copilot-cli--devin-cli--kiro--augment--works-with-config-only-ports',
  },
  {
    clause: 'ampersand dropped between spaces',
    where: 'CoalMine-README:139',
    heading: '3. Verify & Uninstall',
    anchor: '3-verify--uninstall',
  },
  {
    clause: 'brackets and dots dropped, digits kept',
    where: 'CoalMine-CHANGELOG:394',
    heading: '[3.8.4] \u2014 2026-07-02',
    anchor: '384--2026-07-02',
  },
  {
    clause: 'parentheses, colon, slash dropped',
    where: 'CoalMine-README:119',
    heading: 'Option A3 \u2014 claude.ai (web / desktop app)',
    anchor: 'option-a3--claudeai-web--desktop-app',
  },
  {
    clause: 'inline code span: content kept, backticks and apostrophe dropped',
    where: 'CoalBoard-CHANGELOG:98',
    heading: 'Fixed (carve round 4 \u2014 the confirmation-wave REGRESSION, `1e66b4e`\'s own 4 lines)',
    anchor: 'fixed-carve-round-4--the-confirmation-wave-regression-1e66b4es-own-4-lines',
  },
  {
    clause: 'duplicate heading in one document: -1 suffix',
    where: 'CoalMine-CHANGELOG:30',
    heading: 'Fixed',
    anchor: 'fixed-1',
    needsHistory: true,
  },
  {
    clause: 'TAB (Cc) dropped, not hyphenated',
    where: 'PROBE:1',
    heading: 'tab\u0009between',
    anchor: 'tabbetween',
  },
  {
    clause: 'two SPACES: two hyphens, no collapse',
    where: 'PROBE:2',
    heading: 'two  spaces',
    anchor: 'two--spaces',
  },
  {
    clause: 'NBSP (U+00A0) dropped',
    where: 'PROBE:4',
    heading: 'nbsp\u00a0inside',
    anchor: 'nbspinside',
  },
  {
    clause: 'ideographic space (U+3000) dropped',
    where: 'PROBE2:17',
    heading: 'ideo\u3000space zs',
    anchor: 'ideospace-zs',
  },
  {
    clause: 'trailing punctuation: trailing hyphen, no trim',
    where: 'PROBE:5',
    heading: 'trailing bang !',
    anchor: 'trailing-bang-',
  },
  {
    clause: 'intraword underscore KEPT (Pc)',
    where: 'PROBE2:21',
    heading: 'snake_case_word raw',
    anchor: 'snake_case_word-raw',
  },
  {
    clause: 'underscore emphasis delimiters removed',
    where: 'PROBE:25',
    heading: 'an _uemph_ word',
    anchor: 'an-uemph-word',
  },
  {
    clause: 'star emphasis delimiters removed',
    where: 'PROBE:24',
    heading: 'an *emph* and **strong** word',
    anchor: 'an-emph-and-strong-word',
  },
  {
    clause: 'hyphen runs kept verbatim',
    where: 'PROBE:13',
    heading: 'hyphen--run---kept',
    anchor: 'hyphen--run---kept',
  },
  {
    clause: 'en dash (Pd, not hyphen-minus) dropped',
    where: 'PROBE:11',
    heading: 'en \u2013 dash',
    anchor: 'en--dash',
  },
  {
    clause: 'Thai: letters AND combining marks kept',
    where: 'PROBE:14',
    heading: '\u0e2b\u0e31\u0e27\u0e02\u0e49\u0e2d \u0e01\u0e32\u0e23\u0e15\u0e34\u0e14\u0e15\u0e31\u0e49\u0e07',
    anchor: '\u0e2b\u0e31\u0e27\u0e02\u0e49\u0e2d-\u0e01\u0e32\u0e23\u0e15\u0e34\u0e14\u0e15\u0e31\u0e49\u0e07',
  },
  {
    clause: 'CJK letters kept',
    where: 'PROBE:15',
    heading: '\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8',
    anchor: '\u65e5\u672c\u8a9e-\u30c6\u30b9\u30c8',
  },
  {
    clause: 'non-ASCII uppercase lowercased',
    where: 'PROBE:16',
    heading: '\u00c9COLE \u03a3\u039f\u03a6',
    anchor: '\u00e9cole-\u03c3\u03bf\u03c6',
  },
  {
    clause: 'per-code-point lowercase: NO final sigma',
    where: 'PROBE3:4',
    heading: 'word\u03a3 end',
    anchor: 'word\u03c3-end',
  },
  {
    clause: 'U+0130 lowercases to i + U+0307 (kept)',
    where: 'PROBE2:19',
    heading: '\u0130stanbul case',
    anchor: 'i\u0307stanbul-case',
  },
  {
    clause: 'superscript digit (No) dropped',
    where: 'PROBE:17',
    heading: 'x\u00b2 squared',
    anchor: 'x-squared',
  },
  {
    clause: 'non-ASCII decimal digit (Nd) kept',
    where: 'PROBE2:12',
    heading: 'digit \u0663 nd',
    anchor: 'digit-\u0663-nd',
  },
  {
    clause: 'Alphabetic symbol (So, Alphabetic=Yes) kept',
    where: 'PROBE3:1',
    heading: 'circled \u24b6 so',
    anchor: 'circled-\u24d0-so',
  },
  {
    clause: 'ZWJ (Join_Control) KEPT between dropped emoji',
    where: 'PROBE:20',
    heading: '\u{1f468}\u200d\u{1f4bb} zwj coder',
    anchor: '\u200d-zwj-coder',
  },
  {
    clause: 'ZWNJ (Join_Control) kept',
    where: 'PROBE2:7',
    heading: 'zw\u200cnj cf',
    anchor: 'zw\u200cnj-cf',
  },
  {
    clause: 'ZWSP (Cf, not Join_Control) dropped',
    where: 'PROBE2:6',
    heading: 'zw\u200bsp cf',
    anchor: 'zwsp-cf',
  },
  {
    clause: 'keycap: digit + VS16 + U+20E3 (Me) all kept',
    where: 'PROBE:21',
    heading: '1\ufe0f\u20e3 keycap one',
    anchor: '1\ufe0f\u20e3-keycap-one',
  },
  {
    clause: 'link: text kept, URL gone',
    where: 'PROBE:26',
    heading: 'see [the docs](https://example.com) now',
    anchor: 'see-the-docs-now',
  },
  {
    clause: 'raw HTML tag removed, its text kept',
    where: 'PROBE:27',
    heading: 'html <code>tag</code> inside',
    anchor: 'html-tag-inside',
  },
  {
    clause: 'named entity decoded then dropped',
    where: 'PROBE:29',
    heading: 'amp &amp; entity',
    anchor: 'amp--entity',
  },
  {
    clause: 'numeric entity decoded then dropped',
    where: 'PROBE2:23',
    heading: 'num &#35; entity raw',
    anchor: 'num--entity-raw',
  },
  {
    clause: 'backslash escape resolved then dropped',
    where: 'PROBE:28',
    heading: 'escaped \\* star',
    anchor: 'escaped--star',
  },
  {
    clause: 'Sm/Sk/Po run between spaces: one hyphen per space',
    where: 'PROBE2:15',
    heading: 'math = < > | ~ sm',
    anchor: 'math------sm',
  },
  {
    clause: 'literal "-1" after two duplicates: -1-1',
    where: 'PROBE:33',
    heading: 'Duplicate Heading 1',
    anchor: 'duplicate-heading-1-1',
    needsHistory: true,
  },
];

test('CWK-098 slug oracle: every non-history vector resolves to GitHub\'s own rendered anchor', async (t) => {
  for (const v of SLUG_VECTORS) {
    if (v.needsHistory) continue; // replayed in document order below
    await t.test(`${v.where} -- ${v.clause}`, () => {
      assert.equal(githubSlug(v.heading), v.anchor);
    });
  }
});

test('CWK-098 slug oracle: duplicate-heading history rows, replayed in document order', async (t) => {
  await t.test('CoalMine-CHANGELOG:30 -- duplicate heading in one document: -1 suffix', () => {
    const a = new Anchorer();
    a.anchor(githubSlug('Fixed'));
    assert.equal(a.anchor(githubSlug('Fixed')), 'fixed-1');
  });
  await t.test('PROBE:33 -- literal "-1" after two duplicates: -1-1', () => {
    const a = new Anchorer();
    a.anchor(githubSlug('Duplicate Heading'));
    a.anchor(githubSlug('Duplicate Heading'));
    a.anchor(githubSlug('Duplicate Heading'));
    assert.equal(a.anchor(githubSlug('Duplicate Heading 1')), 'duplicate-heading-1-1');
  });
});
