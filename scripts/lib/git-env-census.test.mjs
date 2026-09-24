// CWK-136 -- unit tests for the git-spawn census. The census proves SAFETY, not presence: a git
// spawn must carry an env: built by gitEnv(), and an env: that mentions process.env is refused
// (CoalTipple's census, which this ports, passed env: process.env because it only proved an env:
// key existed).
//
// The sample sources below are assembled from name parts (SP, EFS, ...) on purpose. This file is
// itself walked by the census -- it lives under scripts/ -- so a literal call written here would be
// read as a real git spawn with no env. Composing the call name keeps the fixture text out of this
// file's own source, the same self-reference hazard the pointer gate's plan comment records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusGitSpawns } from './git-env-census.mjs';

const SP = 'spawn' + 'Sync';
const EFS = 'execFile' + 'Sync';
const ES = 'exec' + 'Sync';
const CP = 'c' + 'p';
const MOD = 'node:child' + '_process';
const SPN = 'spa' + 'wn';
const EF = 'exec' + 'File';
const EX = 'ex' + 'ec';

// The census only reads calls to names a file BINDS from child_process, so every sample carries the
// binding. It is appended AFTER the sample so the sample's own line numbers stay what the tests say.
const BINDINGS = `import { ${[SP, EFS, ES, SPN, EF, EX].join(', ')} } from '${MOD}';\nimport ${CP} from '${MOD}';\n`;
const census = (text, label = 'scripts/x.test.mjs') => censusGitSpawns([{ label, text: text + BINDINGS }]);

test('census: a git spawn whose env is built by gitEnv() is clean and is counted', () => {
  const r = census(`${SP}('git', ['status'], { cwd: d, env: gitEnv(path.dirname(d)) });\n`);
  assert.deepEqual(r.findings, []);
  assert.equal(r.gitSpawns.length, 1);
});

test('census: a git spawn with NO env: key is a finding naming file:line', () => {
  const r = census(`const a = 1;\n${SP}('git', ['status'], { cwd: d, encoding: 'utf8' });\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/x\.test\.mjs:2 /);
  assert.match(r.findings[0], /no 'env:'/);
});

test('census: env: process.env is REFUSED -- presence of an env: key is not safety', () => {
  const r = census(`${SP}('git', ['status'], { cwd: d, env: process.env });\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/x\.test\.mjs:1 /);
  assert.match(r.findings[0], /process\.env/);
});

test('census: a spread of process.env is refused, including when gitEnv() is ALSO present (ordering re-adds GIT_*)', () => {
  const a = census(`${SP}('git', [], { env: { ...process.env, X: '1' } });\n`);
  assert.equal(a.findings.length, 1);
  const b = census(`${SP}('git', [], { env: { ...gitEnv(d), ...process.env } });\n`);
  assert.equal(b.findings.length, 1, 'a helper call beside process.env does not launder it');
  assert.match(b.findings[0], /process\.env/);
});

test('census: an env that is not produced by gitEnv() is refused; an alias assigned from gitEnv() in the same file is accepted', () => {
  const bad = census(`${SP}('git', [], { env: someEnv });\n`);
  assert.equal(bad.findings.length, 1);
  assert.match(bad.findings[0], /not produced by gitEnv/);
  const bareLiteral = census(`${SP}('git', [], { env: { PATH: '/x' } });\n`);
  assert.equal(bareLiteral.findings.length, 1);
  const alias = census(`const GIT_ENV = gitEnv(root);\n${SP}('git', [], { env: GIT_ENV });\n`);
  assert.deepEqual(alias.findings, []);
  const otherFileAlias = census(`${SP}('git', [], { env: GIT_ENV });\n`);
  assert.equal(otherFileAlias.findings.length, 1, 'an alias must be assigned from gitEnv() in THIS file');
});

test('census: a multi-line call is read whole; the finding names the line the call STARTS on', () => {
  const text = `x();\n${SP}(\n  'git',\n  ['status'],\n  {\n    cwd: d,\n    env: process.env,\n  },\n);\n`;
  const r = census(text);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/x\.test\.mjs:2 /);
  const ok = census(`${SP}(\n  'git',\n  [],\n  {\n    env: gitEnv(d),\n  },\n);\n`);
  assert.deepEqual(ok.findings, []);
});

test('census: a call inside a // or * comment line is ignored; a URL string earlier on the SAME line does not hide a real call', () => {
  const commented = census(`// ${SP}('git', ['status'], { cwd: d });\n * ${SP}('git', [], {});\n`);
  assert.deepEqual(commented.findings, []);
  assert.equal(commented.gitSpawns.length, 0);
  const url = census(`const u = 'https://example.invalid'; ${SP}('git', ['status'], { cwd: d });\n`);
  assert.equal(url.findings.length, 1, 'a // inside a string is not a comment');
});

test('census: every spawn form is covered -- execFile, spawn, execSync/exec with a git command string, the qualified child_process form', () => {
  assert.equal(census(`${EFS}('git', ['ls-files'], { cwd: d });\n`).findings.length, 1);
  assert.equal(census(`${SPN}('git', ['ls-files'], { cwd: d });\n`).findings.length, 1);
  assert.equal(census(`${EF}('git', ['ls-files'], { cwd: d });\n`).findings.length, 1);
  assert.equal(census(`${ES}('git status', { cwd: d });\n`).findings.length, 1);
  assert.equal(census(`${EX}("git status", { cwd: d });\n`).findings.length, 1);
  assert.equal(census(`${CP}.${SP}('git', [], { cwd: d });\n`).findings.length, 1);
  assert.deepEqual(census(`${CP}.${SP}('git', [], { env: gitEnv(d) });\n`).findings, []);
  assert.deepEqual(census(`${ES}('git status', { env: gitEnv(d) });\n`).findings, []);
});

test('census: a node child (process.execPath) is counted and left alone; RegExp .exec( and an unrelated .spawn( method are not spawns', () => {
  const r = census(`${SP}(process.execPath, [script], { cwd: d });\nconst m = RE.exec(line);\nmock.spawn('git', []);\n`);
  assert.deepEqual(r.findings, []);
  assert.equal(r.nodeChildren, 1);
  assert.equal(r.gitSpawns.length, 0);
});

test('census: a spawn whose command is neither a literal nor process.execPath cannot be proven not-git and is refused', () => {
  const r = census(`${SP}(cmd, ['status'], { cwd: d });\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /cannot prove/);
  const lit = census(`${SP}('node', ['x'], { cwd: d });\n`);
  assert.deepEqual(lit.findings, [], 'a literal non-git command is not this census\'s business');
});

test('census: an unreadable file (text null) is a finding, never a silent zero', () => {
  const r = censusGitSpawns([{ label: 'scripts/gone.mjs', text: null }]);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/gone\.mjs /);
});

test('census: findings are reported per file across a map, in walk order', () => {
  const r = censusGitSpawns([
    { label: 'scripts/a.mjs', text: `${SP}('git', [], { cwd: d });\n${BINDINGS}` },
    { label: 'lib/b.js', text: `${SP}('git', [], { env: gitEnv(d) });\n${BINDINGS}` },
    { label: 'bin/c.js', text: `\n\n${SP}('git', [], { env: process.env });\n${BINDINGS}` },
  ]);
  assert.equal(r.gitSpawns.length, 3);
  assert.equal(r.findings.length, 2);
  assert.match(r.findings[0], /^scripts\/a\.mjs:1 /);
  assert.match(r.findings[1], /^bin\/c\.js:3 /);
});

// -- which names does a file bind from child_process? --------------------------------------

test('census: a file that never binds child_process is skipped whole -- prose that looks like a call is not one', () => {
  const r = censusGitSpawns([{ label: 'scripts/prose.mjs', text: `console.log('${SPN}(s) across files');\nconst x = ${SPN}(a);\n` }]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.gitSpawns.length, 0);
});

test('census: an aliased import (as) is followed to the real function, so an alias cannot hide a spawn', () => {
  const alias = 'ru' + 'n';
  const aliased = `import { ${SP} as ${alias} } from '${MOD}';\n${alias}('git', ['status'], { cwd: d });\n`;
  const r = censusGitSpawns([{ label: 'scripts/a.mjs', text: aliased }]);
  assert.equal(r.gitSpawns.length, 1);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /^scripts\/a\.mjs:2 /);
  const safe = `import { ${SP} as ${alias} } from '${MOD}';\n${alias}('git', ['status'], { env: gitEnv(d) });\n`;
  assert.deepEqual(censusGitSpawns([{ label: 'scripts/a.mjs', text: safe }]).findings, []);
});

test('census: a dynamic-import destructure and a require destructure are read like a static import', () => {
  const dyn = `const { ${SP} } = await import('${MOD}');\n${SP}('git', [], { cwd: d });\n`;
  assert.equal(censusGitSpawns([{ label: 'scripts/d.mjs', text: dyn }]).findings.length, 1);
  const req = `const { ${EFS} } = require('${MOD}');\n${EFS}('git', [], { cwd: d });\n`;
  assert.equal(censusGitSpawns([{ label: 'bin/r.js', text: req }]).findings.length, 1);
  const ns = `const ${CP} = require('${MOD}');\n${CP}.${SP}('git', [], { cwd: d });\n`;
  assert.equal(censusGitSpawns([{ label: 'bin/n.js', text: ns }]).findings.length, 1);
});
