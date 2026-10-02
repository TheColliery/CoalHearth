// CW-017 -- unit tests (pure logic) + hermetic spawn tests (the real CLI, two fixtures: one
// planted-defect, one clean) for scripts/lib/link-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './git-env.mjs';
import { githubSlug, renderInline, extractHeadings, headingAnchors, extractCitations, checkFile, checkFiles, Anchorer, buildTrackedIndex, classifyTrackedIndexResult } from './link-check.mjs';

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

test('githubSlug: r34 FIXBACK2 LOW-1 -- an escaped emphasis delimiter survives the emphasis pass, GitHub keeps it literal', () => {
  // r34-INSPECT evidence, GitHub's own POST /markdown render: pre-fix, `\_` was resolved to
  // a bare `_` BEFORE the emphasis pass ran, so the escaping itself satisfied the very
  // regex it was meant to protect against, and both underscores were stripped.
  assert.equal(githubSlug('a \\_b\\_ c'), 'a-_b_-c');
  assert.equal(githubSlug('pre \\_mid_ post'), 'pre-_mid_-post');
  // the escaped-star row is unaffected by this fix either way -- `*` is outside oracleSlug's
  // own keep-set and is dropped regardless of whether emphasis-stripping ever touched it.
  // Kept here so a future change to the star sentinel is proven not to regress this row.
  assert.equal(githubSlug('a \\*b\\* c'), 'a-b-c');
});

test('renderInline: r34-CODEQL #18 (js/incomplete-multi-character-sanitization) -- a nested HTML tag shape leaves no <letter tag behind after repeated removal passes', () => {
  // CodeQL alert #18, scripts/lib/link-check.mjs:122, commit d4d5041: a SINGLE regex pass on
  // the tag-strip can leave a live tag behind when one tag's own bracket range nests inside
  // another's. Empirically verified BEFORE trusting the order's own suggested example --
  // `<scr<script>ipt>` does NOT reproduce it (the greedy [^>]* consumes straight through to
  // the first real `>` and leaves only stray text, "ipt>", no <letter shape survives at
  // all). The shape that DOES survive a single pass: the OUTER `<` and an early INNER tag
  // get consumed together by one match, exposing a fresh, real `<script>` tag behind them --
  // single-pass output for this exact string is literally `<script>alert(1)<//script>`.
  const evil = '<<script>script>alert(1)</<script>/script>';
  assert.doesNotMatch(renderInline(evil), /<[A-Za-z]/, 'no live <letter tag shape may survive renderInline, however many times it must loop');
});

test('headingAnchors: de-duplicates repeated headings the way GitHub does (-1, -2, ...)', () => {
  const anchors = headingAnchors('# Setup\n\n## Setup\n\n### Setup\n');
  assert.deepEqual([...anchors], ['setup', 'setup-1', 'setup-2']);
});

test('extractHeadings: a `#` inside a fenced code block is not a heading', () => {
  const md = '```\n# not a heading\n```\n\n# real heading\n';
  assert.deepEqual(extractHeadings(md), [{ text: 'real heading', line: 5 }]);
});

test('extractHeadings: r34 FIXBACK2 LOW-2 -- a TILDE fence hides headings too, not backtick-only', () => {
  const md = '# Before\n~~~\n## inside tilde fence\n~~~\n# After\n';
  assert.deepEqual(extractHeadings(md).map((h) => h.text), ['Before', 'After']);
});

test('extractHeadings: r34 FIXBACK2 LOW-2 -- a fence closes ONLY on the same character, at least as long -- not any 3+ backtick line inside it', () => {
  // r34-INSPECT evidence, GitHub-rendered: a stray 3-backtick line inside a 4-backtick fence
  // is content, not a close. Pre-fix, ANY 3+-backtick line toggled fence state blindly, so
  // the stray line closed early (inventing a heading that should stay hidden) and the REAL
  // closing fence then re-opened fence state (missing the heading that should follow it).
  const md = '# Before\n````\n```\n## inside four-backtick fence\n````\n# after-four-backtick-fence\n';
  assert.deepEqual(extractHeadings(md).map((h) => h.text), ['Before', 'after-four-backtick-fence']);
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

// One place every fixture git spawn goes through (CWK-133 -- the whole GIT_* family is handled here).
function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(path.dirname(cwd)) });
}

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
  git(tmp, ['init', '-q', '.']);
  fs.writeFileSync(path.join(tmp, 'tracked.md'), '# Tracked\n');
  fs.writeFileSync(path.join(tmp, 'untracked.md'), '# Untracked\n');
  git(tmp, ['add', 'tracked.md']); // NOT untracked.md
  fs.writeFileSync(path.join(tmp, 'source.md'), '[ok](./tracked.md)\n[bad](./untracked.md)\n');
  git(tmp, ['add', 'source.md']);

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

test('buildTrackedIndex: r34 FIXBACK2 LOW-3 -- a Thai-named tracked file resolves via -z, never a false UNTRACKED from core.quotepath C-quoting', (t) => {
  const tmp = mkTmp(t);
  git(tmp, ['init', '-q', '.']);
  fs.writeFileSync(path.join(tmp, 'ไทย.md'), '# Thai\n');
  fs.writeFileSync(path.join(tmp, 'plain.md'), '# Plain\n');
  git(tmp, ['add', 'ไทย.md', 'plain.md']);
  fs.writeFileSync(path.join(tmp, 'source.md'), '[a](./ไทย.md)\n[b](./plain.md)\n');
  git(tmp, ['add', 'source.md']);

  const trackedIndex = buildTrackedIndex(tmp);
  assert.ok(trackedIndex && !trackedIndex.fatal, 'buildTrackedIndex must succeed inside a real git repo');
  const findings = checkFile(path.join(tmp, 'source.md'), tmp, trackedIndex);
  assert.deepEqual(findings, [], `expected both tracked targets to resolve clean, got ${JSON.stringify(findings)}`);
});

// ---------------------------------------------------------- r34 FIXBACK2 MEDIUM-B: classifyTrackedIndexResult
// Same testing SHAPE as pointer-check.test.mjs's own classifyCheckIgnoreResult tests (CWK-090
// fix 1) -- synthetic {status, stdout, stderr, error} objects, no real spawn.

test('classifyTrackedIndexResult: exit 0 is ok', () => {
  assert.deepEqual(
    classifyTrackedIndexResult({ status: 0, stdout: 'a.md\0b.md\0' }),
    { ok: true, stdout: 'a.md\0b.md\0' },
  );
});

test('classifyTrackedIndexResult: a spawn error (git not on PATH) DEGRADES, never fails loud -- case 1', () => {
  const v = classifyTrackedIndexResult({ error: new Error('spawn git ENOENT') });
  assert.equal(v.ok, false);
  assert.equal(v.degrade, true);
  assert.match(v.message, /git is not available/);
});

test('classifyTrackedIndexResult: git ran and found no repository at all (the parenthetical wording) DEGRADES -- case 1', () => {
  const v = classifyTrackedIndexResult({ status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
  assert.equal(v.ok, false);
  assert.equal(v.degrade, true);
  assert.match(v.message, /not a git repository/);
});

test('classifyTrackedIndexResult: git ran and the command failed for any OTHER reason -- FAIL LOUD, does NOT degrade -- case 2', () => {
  // The split is NOT "does stderr contain the phrase not a git repository" -- empirically
  // confirmed (see the return): a broken GIT_DIR ALSO produces that phrase, just WITHOUT the
  // "(or any of the parent directories)" parenthetical (it names its own explicit bad path
  // instead). Text-matching the shorter phrase would have wrongly classified the r33
  // reproduction as case 1 and kept the exact silent degrade this fix removes.
  const v = classifyTrackedIndexResult({ status: 128, stdout: '', stderr: "fatal: not a git repository: '/nonexistent-r34'\nmore\n" });
  assert.equal(v.ok, false);
  assert.equal(v.degrade, false);
  assert.match(v.message, /exited 128/);
  assert.match(v.message, /fatal: not a git repository/);
});

// -- MEDIUM-B, end to end: the real CLI, spawned, wiring proven never neutered ----------

test('CLI: r34 FIXBACK2 E2 -- main() actually wires trackedIndex into checkFiles; a target on disk but UNTRACKED is reported, never silently passed', (t) => {
  const tmp = mkTmp(t);
  git(tmp, ['init', '-q', '.']);
  fs.writeFileSync(path.join(tmp, 'tracked.md'), '# Tracked\n');
  fs.writeFileSync(path.join(tmp, 'untracked.md'), '# Untracked\n');
  git(tmp, ['add', 'tracked.md']); // NOT untracked.md
  fs.writeFileSync(path.join(tmp, 'source.md'), '[bad](./untracked.md)\n');
  git(tmp, ['add', 'source.md']);

  const r = spawnSync(process.execPath, [engine, 'source.md'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /UNTRACKED/);
});

test('CLI: r34 FIXBACK2 MEDIUM-B case 1 -- no git repository at all degrades to exists-only, DISCLOSED on stdout every run', (t) => {
  const tmp = mkTmp(t); // deliberately no `git init` -- a plain, non-git directory
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Target\n');
  fs.writeFileSync(path.join(tmp, 'source.md'), '[ok](./target.md)\n');

  const r = spawnSync(process.execPath, [engine, 'source.md'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0 (exists-only still passes), got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /tracked-check degraded to exists-only/, 'the degrade must be disclosed on stdout, not silent');
});

test('CLI: r34 FIXBACK2 MEDIUM-B case 2 -- git present but the command fails (corrupt index) FAILS LOUD, never a clean pass', (t) => {
  const tmp = mkTmp(t);
  git(tmp, ['init', '-q', '.']);
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Target\n');
  fs.writeFileSync(path.join(tmp, 'source.md'), '[ok](./target.md)\n');
  git(tmp, ['add', 'target.md', 'source.md']);

  // r33's reproduction was a GIT_DIR aimed at a path that does not exist: git IS on PATH and
  // invocable, but the command itself fails. Pre-fix that was a silent `null` degrade, "0
  // finding(s)", exit 0. CWK-133 made the engine STRIP every ambient GIT_* key from its git child
  // (a hook-exported GIT_DIR must never redirect it), so a hostile GIT_DIR is no longer a lever
  // against the engine -- the SAME class (git ran and failed for a reason other than "no
  // repository") is reached instead by corrupting the index, which the engine cannot strip.
  // Measured: `git ls-files -z` exits 128, "fatal: .git/index: index file smaller than expected".
  fs.writeFileSync(path.join(tmp, '.git', 'index'), 'garbage-not-an-index');
  const r = spawnSync(process.execPath, [engine, 'source.md'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1 (FAIL LOUD), got ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /^0 finding\(s\)/m, 'must never read as a clean pass');
  assert.match(r.stderr, /git ls-files exited/);
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

// -- r34 MEDIUM 2 / r34 FIXBACK2 MEDIUM-A: the WORKFLOW FILE's own shape, read as TEXT ---
// The first test in this flock to read a SHIPPED WORKFLOW FILE and assert on its shape --
// main's own ruling (r34, CW-017 MEDIUM-2): the workflow is shipped bytes and this test
// asserts a shipped CONTRACT, the same class every other test in this file already is. No
// YAML library (Phoenix #2, zero-dep) -- plain string/regex matching on the file's own text.
//
// r34 FIXBACK2 MEDIUM-A: the r34 version of this test asserted TEXT PRESENCE only --
// `assert.match(yml, /node .../)`  passes whenever the call text exists ANYWHERE in the
// step, whatever follows it -- so INSPECT's own four green mutations (`$files || true`, an
// appended `exit 0`, a job-level `if: false`, triggers narrowed to `workflow_dispatch`) all
// left the suite green. This version asserts the SHAPE that makes the engine's own exit code
// decide the job, not a longer list of forbidden strings: the engine call is the step's LAST
// command with NOTHING appended (`runStepLines`, below, walks the block-scalar's own 10-space
// indentation and compares the final trimmed line exactly) -- a stricter structural check
// that catches the next neutralising shape by construction, not only the ones named here.
function runStepLines(yml) {
  const lines = yml.split('\n');
  const idx = lines.findIndex((l) => /\brun:\s*\|\s*$/.test(l));
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (!/^ {10}/.test(l)) break; // dedent -- the block scalar ended
    out.push(l);
  }
  return out;
}
test('workflow: link-check.yml -- the engine call is the step\'s LAST command, no continue-on-error, no job if:, both push and pull_request wired, the empty-list guard present, no paths: filter', () => {
  const yml = fs.readFileSync(workflowPath, 'utf8');
  const stepLines = runStepLines(yml).map((l) => l.trim()).filter(Boolean);
  assert.ok(stepLines.length > 0, 'the run: | block must be found and non-empty');
  assert.equal(
    stepLines[stepLines.length - 1],
    'node scripts/lib/link-check.mjs "${files[@]}"',
    'the engine call must be the step\'s LAST command, with nothing appended (|| true, a trailing exit, ...), and take the file list as a quoted ARRAY (CWK-120 #5)',
  );
  // r34-RED-PROOF found this while mutating: `- continue-on-error: true` (the key as the
  // FIRST field of the step, dash-prefixed -- a completely ordinary YAML step shape) evaded
  // a bare `^\s*continue-on-error` anchor, because the anchor allowed only whitespace before
  // the key and a real step here opens with `- `. Match an optional leading `- ` too.
  assert.doesNotMatch(yml, /^\s*-?\s*continue-on-error\s*:/m, 'this gate is never report-only (a live key, not a comment mentioning the phrase)');
  // r34 FIXBACK2 MEDIUM-A: no `if:` at job (or step) level anywhere in this file -- a silent
  // `if: false` skips the whole job while every other check still shows green. The shell's
  // OWN `if [ -z "$files" ]; then` is unaffected: `if\s*:` requires a colon right after `if`,
  // and the shell line has `if [`, never `if:`.
  assert.doesNotMatch(yml, /^\s*if\s*:/m, 'no if: condition anywhere -- a job/step condition could skip the check silently');
  // r34 FIXBACK2 MEDIUM-A: both triggers wired -- narrowing to workflow_dispatch alone (or
  // dropping either) stops the gate firing on the events it exists to gate.
  assert.match(yml, /^\s*push\s*:/m, 'the push: trigger must be present');
  assert.match(yml, /^\s*pull_request\s*:/m, 'the pull_request: trigger must be present');
  assert.match(yml, /if \[ \$\{#files\[@\]\} -eq 0 \]/, 'the empty-file-list guard must be present (array-length form, CWK-120 #5)');
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

// -- CWK-133: the read-only tracked-index spawn and every fixture spawn ignore an ambient GIT_DIR ----
// Inside a LINKED worktree a git hook exports an absolute GIT_DIR, which overrides cwd. The
// sandbox repo stands in for that enclosing repo: it tracks one UNRELATED file. The redirect is
// universal; the core.bare flip is platform-conditional (CoalTipple f0b95b9), so only the universal
// leg is asserted.
function mkSandboxRepo(t) {
  const sandbox = mkTmp(t);
  git(sandbox, ['init', '-q', '.']);
  fs.writeFileSync(path.join(sandbox, 'unrelated.txt'), 'not ours\n');
  git(sandbox, ['add', 'unrelated.txt']);
  return { gitDir: path.join(sandbox, '.git'), configOf: () => fs.readFileSync(path.join(sandbox, '.git', 'config')) };
}

function plantGitDir(t, gitDir) {
  const saved = process.env.GIT_DIR;
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  process.env.GIT_DIR = gitDir;
}

test('CWK-133: buildTrackedIndex lists THIS repo\'s tracked files when an absolute GIT_DIR is ambient, never the enclosing repo\'s', (t) => {
  const { gitDir } = mkSandboxRepo(t);
  const tmp = mkTmp(t);
  git(tmp, ['init', '-q', '.']);
  fs.writeFileSync(path.join(tmp, 'target.md'), '# Target\n');
  git(tmp, ['add', 'target.md']);
  plantGitDir(t, gitDir);

  const idx = buildTrackedIndex(tmp);
  assert.ok(idx && !idx.fatal, `buildTrackedIndex must succeed, got ${JSON.stringify(idx)}`);
  assert.ok(idx.tracked.has('target.md'), 'the index must be THIS fixture\'s, which tracks target.md');
  assert.ok(!idx.tracked.has('unrelated.txt'), 'the enclosing repo\'s tracked file must never leak into the index');
});

test('CWK-133: the link-check fixture git() helper never touches another repo when an absolute GIT_DIR is ambient', (t) => {
  const { gitDir, configOf } = mkSandboxRepo(t);
  const before = configOf();
  const tmp = mkTmp(t);
  plantGitDir(t, gitDir);

  git(tmp, ['init', '-q', '.']);
  git(tmp, ['config', 'user.email', 'ci@coalhearth.invalid']);

  assert.ok(before.equals(configOf()), 'the enclosing repo config must be byte-unchanged');
  assert.ok(fs.existsSync(path.join(tmp, '.git')), 'the fixture must get its own .git, not be redirected onto the enclosing repo');
});

// CWK-120 finding #5 (CodeRabbit, Minor), verified at the live tree: `files=$(git ls-files ...)` + an unquoted `$files`
// re-splits the list on whitespace and glob-expands it, so a TRACKED path such as `docs/User Guide.md` became two argv
// entries and a false link-check failure. The list is now a NUL-delimited bash ARRAY (`git ls-files -z` + `grep -z` +
// `mapfile -d ''`), passed as a quoted "${files[@]}": every path is exactly one argument whatever its bytes. Shape
// ported from CoalTipple PR24 #6 (its own note measured that a planted "with space.md" lands as ONE array element and
// that mapfile reads from a process substitution, so `set -e` cannot abort before the empty-list guard).
test('workflow: link-check.yml builds the file list as a NUL-delimited array, never a word-split string (CWK-120 #5)', () => {
  const yml = fs.readFileSync(workflowPath, 'utf8');
  const stepText = runStepLines(yml).join('\n');
  assert.match(stepText, /mapfile -d '' -t files < <\(git ls-files -z /, 'NUL-delimited read into an array');
  assert.match(stepText, /grep -zv/, 'the scope filters are NUL-aware too (grep -z)');
  assert.doesNotMatch(stepText, /files=\$\(/, 'no scalar files=$(...) assignment to word-split later');
  assert.doesNotMatch(stepText, /\$files\b/, 'no unquoted $files expansion anywhere in the step');
});

// CWK-120 finding #4 (CodeRabbit, Minor, "Analyzed with Security Review"), verified at the live tree: actions/checkout
// persists the job token in .git/config by default, and these jobs then EXECUTE repository code (verify/test/the link
// engine) from the pull-request checkout -- so pull-request code could read the live read-scoped credential. No step
// here pushes (contents: read), so the token has no use after the checkout: persist-credentials: false on every
// checkout of the two workflows the finding names. (CoalTipple PR24 #5 made the same call for its link-check.yml.)
function checkoutStepsOf(yml) {
  const lines = yml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- uses: actions\/checkout@/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || /^\s*#/.test(l)) { block.push(l); continue; }
      const ind = l.length - l.trimStart().length;
      if (ind <= indent) break; // the next step (or a dedent) -- this step's keys are indented deeper than its dash
      block.push(l);
    }
    out.push({ line: i + 1, text: block.join('\n') });
  }
  return out;
}
for (const wf of ['ci.yml', 'link-check.yml']) {
  test('workflow: every actions/checkout in ' + wf + ' sets persist-credentials: false (CWK-120 #4)', () => {
    const yml = fs.readFileSync(path.join(repo, '.github', 'workflows', wf), 'utf8');
    const steps = checkoutStepsOf(yml);
    assert.ok(steps.length >= 1, wf + ' must have at least one checkout to check (an empty match proves nothing)');
    for (const s of steps) {
      assert.match(s.text, /^\s+persist-credentials:\s*false\s*$/m, wf + ':' + s.line + ' checkout must not persist the token');
    }
  });
}
