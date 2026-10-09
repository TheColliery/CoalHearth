// git-env-pins.test.mjs -- 09a: this room's own tree against the CANON git-spawn census (scripts/lib/git-env-census.mjs, adopted by blob id), with the room's pins
// (scripts/lib/git-env-pins.mjs). The canon test proves the RULE over its witness corpus; this one proves that THIS repository obeys it, and that the room's pins are alive.
// The planted source is assembled from name parts so this file's own text holds no literal spawn the census would read as real (the census walks scripts/**, tests included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanGitSpawns, gitBlobId } from './lib/git-env-census.mjs';
import { GIT_ENV_PINS, collectCensusFiles, stalePins } from './lib/git-env-pins.mjs';
import { DEFAULT_SURFACE_PLAN } from './lib/pointer-check.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the same roots verify.mjs walks: the pointer gate's own code roots
const ROOTS = DEFAULT_SURFACE_PLAN.filter((row) => row.kind === 'comments').map((row) => row.root);
const files = collectCensusFiles(REPO, ROOTS);
const SP = 'spawn' + 'Sync';
const IMPORTS = `import { ${SP} } from 'node:child${'_'}process';\nimport { gitEnv } from './lib/git-env.mjs';\n`;
const withPlanted = (text) => [...files, { rel: 'scripts/zz-planted.test.mjs', text: IMPORTS + text }];
const findingsOf = (all, pins = GIT_ENV_PINS) => scanGitSpawns(all, pins).findings;

test('the room tree passes the canon census with the room pins: no finding, the walk is not empty, and every pin holds one file out', () => {
  assert.ok(ROOTS.length >= 3, 'the walk has its roots (scripts, bin, lib)');
  assert.ok(files.length >= 40, `the census must walk this room's code roots, not an empty set (${files.length} files)`);
  const r = scanGitSpawns(files, GIT_ENV_PINS);
  assert.deepEqual(r.findings, [], 'every git spawn of this room takes its environment from gitEnv() or an allowlist of named keys, or sits in a pinned carrier');
  assert.ok(r.calls >= 8, `the census must see this room's git spawns (${r.calls})`);
  assert.equal(r.safe, r.calls, 'every counted spawn is read safe');
  assert.equal(r.exempted, GIT_ENV_PINS.length, 'each pin holds exactly one file out');
});

test('no pin is stale: each names a file of the walk at the very blob it pins', () => {
  assert.deepEqual(stalePins(files), []);
  assert.ok(GIT_ENV_PINS.every((p) => /^[0-9a-f]{40}$/.test(p.blob) && p.why.length > 20), 'a pin carries a full blob id and its reason');
  assert.equal(new Set(GIT_ENV_PINS.map((p) => p.rel)).size, GIT_ENV_PINS.length, 'one row per file');
});

test('RED: a spread of process.env planted into a git spawn of this room fails the census, naming the file and line', () => {
  const planted = `${SP}('git', ['status'], { cwd: '.', env: { ...process.env } });\n`;
  const clean = findingsOf(files);
  assert.deepEqual(clean, []);
  const bad = findingsOf(withPlanted(planted));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^scripts\/zz-planted\.test\.mjs:3 /);
  assert.match(bad[0], /process\.env/);
  const okPlant = findingsOf(withPlanted(`${SP}('git', ['status'], { cwd: '.', env: gitEnv('.') });\n`));
  assert.deepEqual(okPlant, [], 'the control: the same spawn through gitEnv() reads clean');
});

test('RED: a spawn with no env at all, planted, fails; so does a planted file that names the process environment under another spelling', () => {
  assert.equal(findingsOf(withPlanted(`${SP}('git', ['status'], { cwd: '.' });\n`)).length, 1);
  assert.equal(findingsOf(withPlanted(`const env = process.env;\n${SP}('git', ['status'], { cwd: '.', env });\n`)).length, 1);
});

test('a pin matches only the bytes it names: one edited byte in a pinned carrier spends the pin, and the census reads the file again', () => {
  for (const pin of GIT_ENV_PINS) {
    const file = files.find((f) => f.rel === pin.rel);
    assert.ok(file, `${pin.rel} is in the walk`);
    assert.equal(gitBlobId(file.text), pin.blob);
    const edited = files.map((f) => (f.rel === pin.rel ? { ...f, text: f.text + '\n// edited\n' } : f));
    assert.ok(findingsOf(edited).length >= 1, `${pin.rel}: an edited carrier is read again and is a finding, because it is not routed through gitEnv()`);
    assert.equal(stalePins(edited).length, 1, `${pin.rel}: the spent pin is reported stale`);
  }
});

test('a pin for a file that is gone, or at another blob, is reported stale (it must not outlive its bytes)', () => {
  assert.equal(stalePins(files, [{ rel: 'scripts/not-here.mjs', blob: 'a'.repeat(40), why: 'a file that no longer exists in the walk, so nothing is held out' }]).length, 1);
  assert.equal(stalePins(files, [{ ...GIT_ENV_PINS[0], blob: 'b'.repeat(40) }]).length, 1);
  assert.deepEqual(stalePins(files, []), []);
});

test('collectCensusFiles walks .mjs, .cjs and .js under the given roots only, with forward-slash names and the text', () => {
  const some = collectCensusFiles(REPO, ['bin']);
  assert.ok(some.length >= 3 && some.every((f) => f.rel.startsWith('bin/') && /\.(mjs|cjs|js)$/.test(f.rel) && typeof f.text === 'string'));
  assert.deepEqual(collectCensusFiles(REPO, ['no-such-root']), []);
});
