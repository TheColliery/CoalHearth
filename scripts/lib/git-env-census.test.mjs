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
import fs from 'node:fs';
import { censusGitSpawns, blobId } from './git-env-census.mjs';

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
// 08d: the NAME gitEnv is trusted only when the file imports it from the room's git-env.mjs, so every fixture carries that import (witness F42).
const BINDINGS = `import { ${[SP, EFS, ES, SPN, EF, EX].join(', ')} } from '${MOD}';\nimport ${CP} from '${MOD}';\nimport { gitEnv } from './lib/git-env.mjs';\n`;
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
  assert.match(bad.findings[0], /someEnv is not declared/);
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
  const commented = census(`// ${SP}('git', ['status'], { cwd: d });\n/*\n * ${SP}('git', [], {});\n */\n`);
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
  const safe = `import { ${SP} as ${alias} } from '${MOD}';\nimport { gitEnv } from './git-env.mjs';\n${alias}('git', ['status'], { env: gitEnv(d) });\n`;
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

// -- R8 FIXBACK M1: the census accepted any env: that merely CONTAINED gitEnv(), and printed a verdict
// ("every one takes env from gitEnv() alone") that its own instrument did not produce. INSPECT's evasion
// shapes, each one a real hand-off of an un-stripped environment to a git child. A finding here = CLOSED.
const raw = (text, label = 'scripts/x.test.mjs') => censusGitSpawns([{ label, text }], { exemptions: [] });
const PE = 'process' + '.env';

test('M1: the WHOLE env expression must be gitEnv(...) -- a spread of an alias of process.env beside it is refused (E6)', () => {
  const r = raw(`${BINDINGS}const e = ${PE};\n${SP}('git', [], { env: { ...gitEnv(x), ...e } });\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /not produced by gitEnv\(\) alone/);
});

test('M1: Object.assign(gitEnv(x), process[env]) is refused (E6c)', () => {
  const r = raw(`${BINDINGS}${SP}('git', [], { env: Object.assign(gitEnv(x), process['env']) });\n`);
  assert.equal(r.findings.length, 1);
});

test('M1: env: env || gitEnv(root) -- a caller-supplied env with a fallback -- is refused unless named (E6b)', () => {
  const r = raw(`${BINDINGS}const git = (cwd, args, env) => ${SP}('git', args, { cwd, env: env || gitEnv(root) });\n`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /env \|\| gitEnv\(root\)/);
});

test('M1: a whole call gitEnv(...) is accepted, nested parens and whitespace included', () => {
  assert.deepEqual(raw(`${BINDINGS}${SP}('git', [], { env: gitEnv(path.dirname(path.join(a, b))) });\n`).findings, []);
  assert.deepEqual(raw(`${BINDINGS}${SP}('git', [], { env:   gitEnv()   });\n`).findings, []);
});

test('M1: an identifier assigned from exactly gitEnv(...) is accepted -- and refused once it is MUTATED afterwards (E5)', () => {
  const ok = raw(`${BINDINGS}const G = gitEnv(r);\n${SP}('git', [], { env: G });\n`);
  assert.deepEqual(ok.findings, []);
  for (const mutation of ['G.GIT_DIR = hookDir;', "G['GIT_DIR'] = hookDir;", 'Object.assign(G, ambient);', 'delete G.GIT_CEILING_DIRECTORIES;', 'G.X ||= 1;']) {
    const r = raw(`${BINDINGS}const G = gitEnv(r);\n${mutation}\n${SP}('git', [], { env: G });\n`);
    assert.equal(r.findings.length, 1, mutation);
    assert.match(r.findings[0], /mutated/, mutation);
  }
  // an alias assigned from anything OTHER than exactly the call is refused
  const wrapped = raw(`${BINDINGS}const G = gitEnv(r) || fallback;\n${SP}('git', [], { env: G });\n`);
  assert.equal(wrapped.findings.length, 1);
  const notConst = raw(`${BINDINGS}let G = gitEnv(r);\n${SP}('git', [], { env: G });\n`);
  assert.equal(notConst.findings.length, 1, 'let/var can be reassigned: only const counts');
});

test('M1: a git binary not spelled git -- an absolute path, git.cmd, git.exe under a directory -- is still git (E7, E7b)', () => {
  assert.equal(raw(`${BINDINGS}${SP}('/usr/bin/git', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('git.cmd', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.deepEqual(raw(`${BINDINGS}${SP}('/usr/bin/git', ['init'], { env: gitEnv(x) });\n`).findings, []);
  assert.deepEqual(raw(`${BINDINGS}${SP}('/usr/bin/gitk', ['x'], { cwd: d });\n`).findings, [], 'gitk is not git');
});

test('M1: git through a SHELL -- sh -c, a command string, shell: true -- is a git spawn and needs the same env (E8, E8b, E13)', () => {
  assert.equal(raw(`${BINDINGS}${SP}('sh', ['-c', 'git init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('bash', ['-lc', 'cd x && git init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${ES}('cd x && git init', { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${EFS}('git init', { shell: true, cwd: d });\n`).findings.length, 1);
  assert.deepEqual(raw(`${BINDINGS}${ES}('cd x && git init', { env: gitEnv(d) });\n`).findings, []);
  // controls: a shell running something that is not git is not this census's business
  assert.deepEqual(raw(`${BINDINGS}${SP}('sh', ['-c', 'echo hi'], { cwd: d });\n`).findings, []);
  assert.deepEqual(raw(`${BINDINGS}${ES}('echo digit', { cwd: d });\n`).findings, [], 'a word merely containing git is not git');
});

test('M1: a callee reached by alias assignment, an inline require, or cp.default is still seen (E1, E9, E10)', () => {
  const alias = 'ru' + 'n';
  assert.equal(raw(`import { ${SP} } from '${MOD}';\nconst ${alias} = ${SP};\n${alias}('git', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`require('${MOD}').${SP}('git', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`(await import('${MOD}')).${SP}('git', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`import ${CP} from '${MOD}';\n${CP}.default.${SP}('git', ['init'], { cwd: d });\n`).findings.length, 1);
  assert.deepEqual(raw(`import { gitEnv } from './git-env.mjs';\nrequire('${MOD}').${SP}('git', ['init'], { env: gitEnv(x) });\n`).findings, []);
});

// -- the deliberate hazard fixture: an EXPLICIT, COUNTED, PRINTED exemption, never a silent pass ------------
const EXEMPT = [{ label: 'scripts/x.test.mjs', expr: 'env || gitEnv(root)', reason: 'the hazard proof feeds a poisoned GIT_DIR on purpose' }];
const HAZARD = `${BINDINGS}const git = (cwd, args, env) => ${SP}('git', args, { cwd, env: env || gitEnv(root) });\n`;

test('M1: a NAMED exemption (file + exact expression) is counted, carries its reason, and is no finding', () => {
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: HAZARD }], { exemptions: EXEMPT });
  assert.deepEqual(r.findings, []);
  assert.equal(r.gitSpawns.length, 1);
  assert.equal(r.exempt.length, 1);
  assert.equal(r.exempt[0].label, 'scripts/x.test.mjs');
  assert.match(r.exempt[0].reason, /poisoned GIT_DIR/);
  assert.deepEqual(r.unusedExemptions, []);
});

test('M1: an exemption is exact -- another spawn in the same file, or the same expression in another file, is still checked', () => {
  const more = HAZARD + `${SP}('git', ['status'], { cwd: d, env: process.env });\n`;
  const a = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: more }], { exemptions: EXEMPT });
  assert.equal(a.findings.length, 1, 'the second spawn is not covered by the first one\'s exemption');
  const b = censusGitSpawns([{ label: 'scripts/other.test.mjs', text: HAZARD }], { exemptions: EXEMPT });
  assert.equal(b.findings.length, 1, 'the exemption is keyed to its file');
});

test('M1: an exemption that no longer matches anything is reported as UNUSED, so it cannot rot into a blanket pass', () => {
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: BINDINGS + SP + "('git', [], { env: gitEnv(x) });\n" }], { exemptions: EXEMPT });
  assert.deepEqual(r.findings, []);
  assert.equal(r.unusedExemptions.length, 1);
  assert.equal(r.unusedExemptions[0].label, 'scripts/x.test.mjs');
});

// -- R8 FIXBACK 2 MEDIUM-1: a path-qualified git inside a shell string, and git named only in the ARGUMENTS of a shell:true call ---
// The reviewer's shapes (census-evasions2/3). Each is a git child; the CHANGELOG says so.
test('M-1: a path-qualified git inside a shell string is a git spawn (an absolute path, a Windows path, a quoted path)', () => {
  assert.equal(raw(`${BINDINGS}${ES}('/usr/bin/git init', { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('/usr/bin/git', ['init'], { shell: true });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('C:/Program Files/Git/cmd/git.exe', ['init'], { shell: true });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${SP}('sh', ['-c', '/usr/bin/git init'], { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${ES}('"C:/Program Files/Git/cmd/git.exe" init', { cwd: d });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${ES}('C:\\Git\\cmd\\git.exe init', { cwd: d });\n`).findings.length, 1, 'a backslash-separated path');
  assert.deepEqual(raw(`${BINDINGS}${ES}('/usr/bin/git init', { env: gitEnv(d) });\n`).findings, [], 'clean once env is gitEnv() alone');
});

test('M-1: with shell: true Node joins the ARGUMENTS into the command line, so git named only there is a git spawn', () => {
  assert.equal(raw(`${BINDINGS}${SP}('echo', ['x', '&&', 'git', 'init'], { shell: true });\n`).findings.length, 1);
  assert.equal(raw(`${BINDINGS}${EFS}('true', ['&&', '/usr/bin/git', 'init'], { shell: true });\n`).findings.length, 1);
  assert.deepEqual(raw(`${BINDINGS}${SP}('echo', ['x', '&&', 'git', 'init'], { shell: true, env: gitEnv(d) });\n`).findings, []);
  // controls: shell false / absent leaves the arguments as argv, so the word git there is just data
  assert.deepEqual(raw(`${BINDINGS}${SP}('echo', ['git', 'init'], { cwd: d });\n`).findings, []);
  assert.deepEqual(raw(`${BINDINGS}${SP}('echo', ['git', 'init'], { shell: false });\n`).findings, []);
  // and a shell:true call that runs no git stays clean
  assert.deepEqual(raw(`${BINDINGS}${SP}('npm', ['test'], { shell: true, cwd: d });\n`).findings, []);
});

test('M-1: no new false positive -- a path or word that merely CONTAINS git is not git', () => {
  for (const cmd of ['cat .gitignore', 'cat ./repo/.git/config', 'ls /var/gitea/data', 'echo digit', 'cd my-git-repo && ls', 'dir C:\\src\\github\\x']) {
    assert.deepEqual(raw(`${BINDINGS}${ES}('${cmd}', { cwd: d });\n`).findings, [], cmd);
  }
});

// -- R8 FIXBACK 2 LOW-1: an exemption carries an EXPECTED COUNT, so a second matching spawn in the same file fails ------------
const TWICE = HAZARD + `const git2 = (cwd, args, env) => ${SP}('git', ['init'], { cwd, env: env || gitEnv(root) });\n`;

test('L-1: a SECOND spawn with the exempted expression in the same file is a finding, not a silent widening', () => {
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: TWICE }], { exemptions: EXEMPT });
  assert.equal(r.gitSpawns.length, 2);
  assert.equal(r.exempt.length, 1, 'the exemption covers exactly the one spawn it counts');
  assert.equal(r.findings.length, 1, 'the extra spawn FAILs');
  assert.match(r.findings[0], /^scripts\/x\.test\.mjs:\d+ /);
  assert.match(r.findings[0], /allows 1 spawn/);
});

test('L-1: an exemption that states count 2 covers two spawns, and a third fails', () => {
  const two = [{ ...EXEMPT[0], count: 2 }];
  const ok2 = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: TWICE }], { exemptions: two });
  assert.deepEqual(ok2.findings, []);
  assert.equal(ok2.exempt.length, 2);
  assert.deepEqual(ok2.unusedExemptions, []);
  const three = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: TWICE + `const git3 = () => ${SP}('git', [], { env: env || gitEnv(root) });\n` }], { exemptions: two });
  assert.equal(three.findings.length, 1);
});

test('L-1: fewer spawns than the exemption counts is stale, exactly as none is', () => {
  const two = [{ ...EXEMPT[0], count: 2 }];
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: HAZARD }], { exemptions: two });
  assert.deepEqual(r.findings, []);
  assert.equal(r.unusedExemptions.length, 1);
  assert.equal(r.unusedExemptions[0].matched, 1);
  assert.equal(r.unusedExemptions[0].want, 2);
});

// -- R8 FIXBACK 3: every rule that reads PAST the first argument must survive the ordinary formatting of a call --------
// The first argument was located by `1 + first.length`, but `first` is trimmed, so a space after the paren or a newline
// (the normal multi-line format) shifted every later read: the shell:true argument scan and the `sh -c '...'` string
// scan read 0 findings. Each shape below is run tight, with a spaced paren, multi-line, and CRLF multi-line.
const FORMATS = { tight: ['', ''], 'spaced paren': [' ', ' '], multiline: ['\n  ', '\n  '], 'CRLF multiline': ['\r\n  ', '\r\n  '] };
const READS_PAST_FIRST = [
  ['git only in shell:true arguments', (p, s) => `${SP}(${p}'echo',${s}['x', '&&', 'git', 'init'],${s}{ shell: true });`, 1],
  ['sh -c with git in its command string', (p, s) => `${SP}(${p}'sh',${s}['-c', 'git init'],${s}{ cwd: d });`, 1],
  ['bash -lc chained git', (p, s) => `${SP}(${p}'bash',${s}['-lc', 'cd x && git init'],${s}{ cwd: d });`, 1],
  ['shell:true on a git binary', (p, s) => `${SP}(${p}'git.exe',${s}['init'],${s}{ shell: true });`, 1],
  ['a plain git with no env', (p, s) => `${SP}(${p}'git',${s}['init'],${s}{ cwd: d });`, 1],
  ['a plain git taking env from gitEnv() alone', (p, s) => `${SP}(${p}'git',${s}['init'],${s}{ env: gitEnv(d) });`, 0],
  ['sh -c that runs no git (control)', (p, s) => `${SP}(${p}'sh',${s}['-c', 'echo hi'],${s}{ cwd: d });`, 0],
  ['git as data with no shell (control)', (p, s) => `${SP}(${p}'echo',${s}['git', 'init'],${s}{ cwd: d });`, 0],
  ['git as data with shell: false (control)', (p, s) => `${SP}(${p}'echo',${s}['git'],${s}{ shell: false });`, 0],
];
for (const [name, build, want] of READS_PAST_FIRST) {
  test('F3: ' + name + ' reads the same however the call is formatted', () => {
    for (const [fmt, [p, s]] of Object.entries(FORMATS)) {
      assert.equal(raw(`${BINDINGS}${build(p, s)}\n`).findings.length, want, `${name} / ${fmt}`);
    }
  });
}

// -- R8 ALERT #19: a bound local name reaches new RegExp(...), so it must be escaped in FULL, not for `$` alone -------------
// `\{([^}]*)\}` captures whatever a destructuring list holds, comments included, so a local name can carry a regex
// metacharacter. Before the fix an unbalanced `(` in one made the alternation an unterminated group and the census THREW
// (verify.mjs then reports "census crashed"); a `[` or `.*` was silently a pattern, not the literal name.
test('A19: a destructured local whose text carries a regex metacharacter does not crash the census, and the real spawn is still seen', () => {
  for (const junk of ['/* x( */', '/* x) */', '/* [ */', '/* a.b* */', '/* $^+?|\\ */']) {
    const text = `import { ${SP}, ${ES}: run ${junk} } from '${MOD}';\n${SP}('git', ['status'], { cwd: d });\n`;
    let r;
    assert.doesNotThrow(() => { r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text }], { exemptions: [] }); }, junk);
    assert.equal(r.findings.length, 1, 'the plain git spawn beside it is still a finding: ' + junk);
  }
});

test('A19: a whole-module name and a plain local with $ still match literally after the full escape', () => {
  const ns = census(`${CP}.${SP}('git', ['init'], { cwd: d });\n`);
  assert.equal(ns.findings.length, 1);
  const dollar = 'ru' + '$n';
  const d$ = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: `import { ${SP} as ${dollar} } from '${MOD}';\n${dollar}('git', ['init'], { cwd: d });\n` }], { exemptions: [] });
  assert.equal(d$.findings.length, 1);
});

test('A19: an env alias whose name carries $ is declared and matched literally (the identifier class allows $, nothing else needs escaping)', () => {
  const E = '$' + 'env';
  const ok = census(`const ${E} = gitEnv(d);\n${SP}('git', ['init'], { env: ${E} });\n`);
  assert.deepEqual(ok.findings, []);
});

// -- CWK-174 (R14): a BLOB-PINNED exemption for a byte-equal org carrier, and a row for spawns that carry no env: at all ------------
// A byte-equal carrier (the house secret scan's tests) cannot be edited here without breaking the umbrella's parity check, so the
// census exempts it ONLY while its content is exactly the pinned git blob id; any edit or template re-sync makes it a finding again.
const NOENV = BINDINGS + SP + "('git', ['fetch'], { cwd: d });\n";
const NOENV_ROW = (blob) => [{ label: 'scripts/carrier.test.mjs', expr: null, count: 1, blob, reason: 'a byte-equal org carrier whose spawns inherit the environment' }];

test('CWK-174: blobId equals git hash-object for the same bytes', () => {
  assert.equal(blobId(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'git\'s empty-blob id');
  assert.equal(blobId('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a', 'git hash-object of "hello" and an LF');
});

test('CWK-174: a row with expr null covers a spawn that carries no env:, counted and printed, and only while its blob matches', () => {
  const file = [{ label: 'scripts/carrier.test.mjs', text: NOENV }];
  const bare = censusGitSpawns(file);
  assert.equal(bare.findings.length, 1, 'control: with no row the env-less spawn is a finding');
  const r = censusGitSpawns(file, { exemptions: NOENV_ROW(blobId(NOENV)) });
  assert.deepEqual(r.findings, []);
  assert.equal(r.exempt.length, 1);
  assert.deepEqual(r.unusedExemptions, []);
});

test('CWK-174: an edited carrier is a finding again, and says its blob id is not the pinned one', () => {
  const pin = blobId(NOENV);
  const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: NOENV + '// edited\n' }], { exemptions: NOENV_ROW(pin) });
  assert.equal(r.exempt.length, 0, 'the exemption is not spent on changed content');
  assert.ok(r.findings.some((f) => /blob id is [0-9a-f]{40}, not the pinned /.test(f) && f.includes(pin)), 'names the mismatch: ' + r.findings.join(' | '));
  assert.equal(r.unusedExemptions.length, 1, 'and the row reads as unused, so the gate fails on it too');
});

test('CWK-174: a pin is per row, a row without one is unchanged behaviour', () => {
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: HAZARD }], { exemptions: EXEMPT });
  assert.deepEqual(r.findings, [], 'the existing unpinned row still exempts');
  const other = censusGitSpawns([{ label: 'scripts/other.test.mjs', text: NOENV }], { exemptions: NOENV_ROW(blobId(NOENV)) });
  assert.equal(other.findings.length, 1, 'a pin never widens to another file');
});

// R19 (CodeRabbit PR #19 thread 15): the literal check accepted a BACKTICK string, and `[^\\]` matches `$`, `{` and `}`, so an
// interpolated template (a computed command) read as a provable literal, matched neither git nor a shell and went unchecked, though the
// header promises a spawn whose command is neither a string literal nor process.execPath is REFUSED. A template with an interpolation
// is not a provable literal; one with none (or an escaped dollar-brace) still is. The shell branch (execSync/exec, shell: true) reads the
// command through the same check.
const BT = '`'; // the samples are built from parts so this file's own source never holds a literal spawn call
const interp = (body) => BT + body + BT;

test('census: an INTERPOLATED template-literal command is refused as not a provable literal (spawn form)', () => {
  const r = census(SP + '(' + interp('${gitBin}') + ", ['init'], { cwd: d });\n");
  assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  assert.match(r.findings[0], /command is not a string literal or process\.execPath/);
  assert.match(r.findings[0], /^scripts\/x\.test\.mjs:\d+ /);
});

test('census: an INTERPOLATED template-literal command is refused in the shell branch too (execSync, exec, shell: true)', () => {
  for (const text of [
    ES + '(' + interp('${cmd} status') + ', { cwd: d });\n',
    EX + '(' + interp('${cmd} status') + ', { cwd: d });\n',
    SP + '(' + interp('${cmd}') + ", ['status'], { cwd: d, shell: true });\n",
  ]) {
    const r = census(text);
    assert.equal(r.findings.length, 1, text + ' -> ' + JSON.stringify(r.findings));
    assert.match(r.findings[0], /not a string literal/);
  }
});

test('census: a template literal with NO interpolation is still a provable literal, and an escaped dollar-brace is not an interpolation', () => {
  const plain = census(SP + '(' + interp('git') + ", ['status'], { cwd: d });\n");
  assert.equal(plain.gitSpawns.length, 1, 'git as a plain template is seen as a git spawn');
  assert.match(plain.findings[0], /carries no 'env:'/, 'and judged on its env, not refused as a non-literal');
  const escaped = census(SP + '(' + interp('git\\${x}') + ", ['status'], { cwd: d });\n");
  assert.ok(!/not a string literal/.test(escaped.findings.join(' ')), 'an escaped dollar-brace is text, not an interpolation: ' + JSON.stringify(escaped.findings));
  const dollar = census(SP + '(' + interp('node $x') + ", ['status'], { cwd: d });\n");
  assert.deepEqual(dollar.findings, [], 'a lone dollar sign is text too (and node is not this census\'s business)');
});

// 05a FIXBACK 1, LOW-1 (the 05a INSPECT witness shorthand.mjs): a shorthand property `{ env }` means `env: env`, and the census read it as no env key at all, so a SAFE file (env is a
// const assigned from exactly gitEnv(...)) was refused with a message that said something false about it. The shorthand is read as env: env and judged like the longhand; the no-env control
// still fails, and a shorthand of anything but a sound gitEnv() alias still fails.
const SAFE_HEAD = `const env = gitEnv(process.cwd());\n`;

test('census: the shorthand { env } of a const assigned from gitEnv() is clean, like env: env', () => {
  const longhand = census(SAFE_HEAD + `${SP}('git', ['status'], { encoding: 'utf8', env: env });\n`);
  const shorthand = census(SAFE_HEAD + `${SP}('git', ['status'], { encoding: 'utf8', env });\n`);
  assert.deepEqual(longhand.findings, []);
  assert.deepEqual(shorthand.findings, [], 'the shorthand is the same property');
  assert.equal(shorthand.gitSpawns.length, 1);
});

test('census: the shorthand with env last in a multi-line options object, and env first, are read too', () => {
  const last = census(SAFE_HEAD + `${SP}('git', ['status'], {\n  encoding: 'utf8',\n  env,\n});\n`);
  const first = census(SAFE_HEAD + `${SP}('git', ['status'], { env, encoding: 'utf8' });\n`);
  assert.deepEqual(last.findings, []);
  assert.deepEqual(first.findings, []);
});

test('census: a shorthand env that is NOT a sound gitEnv() alias still fails, and names the alias', () => {
  const notGitEnv = census(`const env = { PATH: process.env.PATH };\n${SP}('git', ['status'], { encoding: 'utf8', env });\n`);
  assert.equal(notGitEnv.findings.length, 1);
  assert.match(notGitEnv.findings[0], /env: env is not declared \`const env = gitEnv\(\.\.\.\)\`/);
  const mutated = census(SAFE_HEAD + `env.GIT_DIR = 'x';\n${SP}('git', ['status'], { env });\n`);
  assert.equal(mutated.findings.length, 1);
  assert.match(mutated.findings[0], /is mutated after it is assigned/);
});

test('census: the no-env control still fails, and an env that is only a positional argument or a variable elsewhere is not a shorthand property', () => {
  const control = census(SAFE_HEAD + `${SP}('git', ['status'], { encoding: 'utf8' });\n`);
  assert.equal(control.findings.length, 1);
  assert.match(control.findings[0], /no 'env:'/);
  const positional = census(SAFE_HEAD + `${SP}('git', ['status'], opts, env, extra);\n`);
  assert.equal(positional.findings.length, 1, 'a positional env is not the options object');
  assert.match(positional.findings[0], /no 'env:'/);
  const inArray = census(SAFE_HEAD + `${SP}('git', [env, 'status'], { encoding: 'utf8' });\n`);
  assert.equal(inArray.findings.length, 1, 'env inside the args array is not a property');
});

// 08c UNIT 1 (main's ruling UMB-456 (2), rule (a)): the ALLOWLIST env. The canon's release-notes.mjs hands its one git spawn an env built
// from a NAMED key list (a literal array, read through the one idiom) plus GIT_CONFIG_NOSYSTEM=1, and never spreads process.env whole. The
// census used to know one safe shape, gitEnv() alone, so this file needed a blob-pinned row. The census now ACCEPTS the allowlist shape and
// REFUSES every neighbour of it. Each acceptance witness below was RED before the rule (the result has no `allowlist` and the shape was a finding);
// each refusal witness was green before it by construction (the old census refused everything but gitEnv), so what proves a refusal is not vacuous is
// the mutation table in the return: every branch of the acceptance has a mutant these rows kill.
const AL_KEEP = `const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'GIT_CEILING_DIRECTORIES'];\n`;
const AL_BODY = `...Object.fromEntries(keep.filter((k) => ${PE}[k] !== undefined).map((k) => [k, ${PE}[k]]))`;
const AL_ENV = `const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };\n`;
const AL_SPAWN = `${SP}('git', ['config', '--local', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 30000, env });\n`;
const alCensus = (head, spawn = AL_SPAWN) => raw(BINDINGS + head + spawn);

test('08c allowlist: the canon release-notes.mjs shape (a literal key list, one fromEntries, GIT_CONFIG_NOSYSTEM=1) is clean with NO exemption, and is counted as an allowlist spawn', () => {
  const r = alCensus(AL_KEEP + AL_ENV);
  assert.deepEqual(r.findings, []);
  assert.equal(r.gitSpawns.length, 1);
  assert.equal(r.allowlist.length, 1, 'the report names the spawn as an allowlist one, so the gate can print what it produced');
  assert.deepEqual(r.exempt, []);
  assert.deepEqual(r.unusedExemptions, []);
});

test('08c allowlist: the longhand env: env, an inline object literal, and a key list read without the filter are the same shape and are clean', () => {
  assert.deepEqual(alCensus(AL_KEEP + AL_ENV, AL_SPAWN.replace('{ encoding', '{ env: env, encoding').replace(', env });', ' });')).findings, []);
  const inline = alCensus(`${AL_KEEP}`, `${SP}('git', ['status'], { env: { PATH: ${PE}.PATH, HOME: ${PE}.HOME, GIT_CONFIG_NOSYSTEM: '1' } });\n`);
  assert.deepEqual(inline.findings, []);
  assert.equal(inline.allowlist.length, 1);
  const noFilter = alCensus(AL_KEEP + `const env = { ...Object.fromEntries(keep.map((k) => [k, ${PE}[k]])), GIT_CONFIG_NOSYSTEM: '1' };\n`);
  assert.deepEqual(noFilter.findings, []);
});

test('08c allowlist: a planted spread of process.env is still a finding, in every spelling', () => {
  for (const [name, head] of [
    ['the spread itself', `const env = { ...${PE}, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['the spread beside the canon list (ordering re-adds GIT_DIR)', `${AL_KEEP}const env = { ${AL_BODY}, ...${PE}, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['a spread of an alias of process.env', `const e = ${PE};\nconst env = { ...e, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['Object.assign({}, process.env)', `const env = Object.assign({}, ${PE}, { GIT_CONFIG_NOSYSTEM: '1' });\n`],
    ['process.env passed whole as a value', `const env = { PATH: ${PE}, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['Object.entries(process.env) as the pairs', `${AL_KEEP}const env = { ...Object.fromEntries(Object.entries(${PE})), GIT_CONFIG_NOSYSTEM: '1' };\n`],
  ]) {
    const r = alCensus(head);
    assert.equal(r.findings.length, 1, name);
    assert.equal(r.allowlist.length, 0, name);
  }
  const inlineSpread = alCensus('', `${SP}('git', [], { env: { ...${PE}, GIT_CONFIG_NOSYSTEM: '1' } });\n`);
  assert.equal(inlineSpread.findings.length, 1);
  assert.match(inlineSpread.findings[0], /process\.env/);
  const inlineAssign = alCensus('', `${SP}('git', [], { env: Object.assign({}, ${PE}) });\n`);
  assert.equal(inlineAssign.findings.length, 1);
});

test('08c allowlist: GIT_CONFIG_NOSYSTEM must be set, and set to 1', () => {
  const missing = alCensus(AL_KEEP + `const env = { ${AL_BODY}, GIT_TERMINAL_PROMPT: '0' };\n`);
  assert.equal(missing.findings.length, 1);
  assert.match(missing.findings[0], /GIT_CONFIG_NOSYSTEM/);
  for (const v of ["'0'", "'true'", 'false', 'flag', "''"]) {
    const r = alCensus(AL_KEEP + `const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: ${v} };\n`);
    assert.equal(r.findings.length, 1, v);
    assert.match(r.findings[0], /GIT_CONFIG_NOSYSTEM/, v);
  }
  assert.deepEqual(alCensus(AL_KEEP + `const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: "1" };\n`).findings, [], 'double quotes are the same literal');
  assert.deepEqual(alCensus(AL_KEEP + `const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: 1 };\n`).findings, [], 'the number 1 too');
});

test('08c allowlist: a GIT_ name outside the three harmless ones is refused wherever it appears -- a key, a quoted key, a lower-case key, a list entry, a named read', () => {
  for (const [name, head] of [
    ['a GIT_DIR key', `${AL_KEEP}const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: dir };\n`],
    ['a quoted GIT_INDEX_FILE key', `${AL_KEEP}const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', 'GIT_INDEX_FILE': idx };\n`],
    ['a lower-case git_work_tree key', `${AL_KEEP}const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', git_work_tree: wt };\n`],
    ['a GIT_ name made up tomorrow', `${AL_KEEP}const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', GIT_FUTURE_REDIRECT: x };\n`],
    ['GIT_DIR in the key list', AL_KEEP.replace("'USERPROFILE'", "'USERPROFILE', 'GIT_DIR'") + AL_ENV],
    ['a lower-case git_dir in the key list', AL_KEEP.replace("'USERPROFILE'", "'USERPROFILE', 'git_dir'") + AL_ENV],
    ['a named read of GIT_COMMON_DIR', `${AL_KEEP}const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', X: ${PE}.GIT_COMMON_DIR };\n`],
  ]) {
    const r = alCensus(head);
    assert.equal(r.findings.length, 1, name);
    assert.match(r.findings[0], /GIT_|git_/i, name);
  }
  // the three harmless names are the only GIT_ names that pass, in the list or as keys
  const harmless = alCensus(AL_KEEP + `const env = { ${AL_BODY}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: ceil };\n`);
  assert.deepEqual(harmless.findings, []);
  const lower = alCensus(AL_KEEP + `const env = { ${AL_BODY}, git_config_nosystem: '1', git_terminal_prompt: '0' };\n`);
  assert.deepEqual(lower.findings, [], 'an env is case-insensitive on Windows: the harmless names pass in any case');
});

test('08c allowlist: a trailing comma, a literal index, a string holding brackets and an escaped quote, and a multi-line object are read like the plain form', () => {
  assert.deepEqual(alCensus(`const env = { PATH: p, GIT_CONFIG_NOSYSTEM: '1', };\n`).findings, []);
  assert.deepEqual(alCensus(`const env = { PATH: ${PE}['PATH'], GIT_CONFIG_NOSYSTEM: '1' };\n`).findings, [], 'a string-literal index is a named key');
  assert.deepEqual(alCensus(`const env = { NOTE: 'a ) } ] \\' b', GIT_CONFIG_NOSYSTEM: '1' };\n`).findings, [], 'brackets and an escaped quote inside a string do not move the end of the object');
  assert.deepEqual(alCensus(`const env = { 'PATH': p, "HOME": dir, 'GIT_CONFIG_NOSYSTEM': '1' };\n`).findings, [], 'quoted keys are named keys');
  assert.deepEqual(alCensus(`const env = {\n  PATH: p,\n  HOME: dir,\n  GIT_CONFIG_NOSYSTEM: '1',\n};\n`).findings, []);
  assert.equal(alCensus(`const env = { PATH: process['env'].PATH, GIT_CONFIG_NOSYSTEM: '1' };\n`).findings.length, 1, 'process reached by a computed key is refused');
});

test('08c allowlist: an inline object with something hanging off it is not the object (an undefined env would hand the child the whole environment)', () => {
  // GIT_CONFIG_NOSYSTEM comes FIRST: the reader's last property is then the one the trailing text sticks to, and only the end-of-object check stops it
  for (const tail of ['.nothing', '[0]', '.x.y']) {
    const r = alCensus('', `${SP}('git', [], { env: { GIT_CONFIG_NOSYSTEM: '1', PATH: p }${tail} });\n`);
    assert.equal(r.findings.length, 1, tail);
    assert.equal(r.allowlist.length, 0, tail);
  }
});

test('08c allowlist: the key list must be ONE literal array of strings, declared once and never changed; the idiom must be the canon one', () => {
  for (const [name, head] of [
    ['the list is the process env keys', `const keep = Object.keys(${PE});\n${AL_ENV}`],
    ['an identifier in the list', AL_KEEP.replace("'HOME'", 'homeKey') + AL_ENV],
    ['a spread in the list', AL_KEEP.replace("'HOME'", '...more') + AL_ENV],
    ['the list is declared twice', AL_KEEP + AL_KEEP + AL_ENV],
    ['the list is not declared in this file', AL_ENV],
    ['the list gains an entry afterwards', AL_KEEP + "keep.push('GIT_DIR');\n" + AL_ENV],
    ['the list is edited by index afterwards', AL_KEEP + "keep[0] = 'GIT_DIR';\n" + AL_ENV],
    ['the list is a let', AL_KEEP.replace('const keep', 'let keep') + AL_ENV],
    ['the pairs do not come from the list', AL_KEEP + AL_ENV.replace('keep.filter', 'other.filter')],
    ['the filter reads a different name than the map', AL_KEEP + AL_ENV.replace('.map((k) => [k, ' + PE + '[k]])', '.map((j) => [j, ' + PE + '[k]])')],
    ['the map renames the key', AL_KEEP + AL_ENV.replace('[k, ' + PE + '[k]]', "[k + '_X', " + PE + '[k]]')],
    ['an extra call in the chain', AL_KEEP + AL_ENV.replace('.map(', '.concat(extra).map(')],
  ]) {
    const r = alCensus(head);
    assert.equal(r.findings.length, 1, name);
    assert.equal(r.allowlist.length, 0, name);
  }
});

test('08c allowlist: the env object is judged on its own text -- a computed key, an indexed read, an interpolation, a trailing expression and a second declaration are refused', () => {
  for (const [name, head] of [
    ['a computed key', `const env = { [name]: value, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['an indexed read of an alias of the environment', `const e = ${PE};\nconst env = { PATH: e[name], GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['a method', `const env = { f() { return 1; }, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['something after the literal', `const env = { PATH: p, GIT_CONFIG_NOSYSTEM: '1' } || fallback;\n`],
    ['declared twice', `const env = { PATH: p, GIT_CONFIG_NOSYSTEM: '1' };\nfunction f() { const env = { ...${PE} }; }\n`],
    ['declared with let', `let env = { PATH: p, GIT_CONFIG_NOSYSTEM: '1' };\n`],
    ['not declared here', ''],
  ]) {
    const r = alCensus(head);
    assert.equal(r.findings.length, 1, name);
    assert.equal(r.allowlist.length, 0, name);
  }
  // and the same literal, with plain named values, is clean
  assert.deepEqual(alCensus(`const env = { PATH: p, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };\n`).findings, []);
  // 08d: a template value is read by the tokenizer, not refused (a value cannot add a key); a GIT_ name inside it is still refused by the raw scan
  assert.deepEqual(alCensus(`const env = { HOME: \`\${dir}\`, GIT_CONFIG_NOSYSTEM: '1' };\n`).findings, []);
  assert.equal(alCensus(`const env = { HOME: \`GIT_DIR\`, GIT_CONFIG_NOSYSTEM: '1' };\n`).findings.length, 1);
});

test('08c allowlist: an allowlist env that is changed after it is declared is refused, like a gitEnv() alias', () => {
  for (const mutation of ["env.GIT_DIR = hookDir;", "env['GIT_DIR'] = hookDir;", 'env[k] = v;', `Object.assign(env, ${PE});`, 'delete env.GIT_CONFIG_NOSYSTEM;', 'env.X ||= 1;']) {
    const r = alCensus(AL_KEEP + AL_ENV + mutation + '\n');
    assert.equal(r.findings.length, 1, mutation);
    assert.match(r.findings[0], /mutated/, mutation);
  }
});

test('08c allowlist: a gitEnv() alias, an unsound alias and a bare literal keep their old verdicts and their old wording', () => {
  assert.deepEqual(alCensus(`const env = gitEnv(r);\n`).findings, []);
  assert.equal(alCensus(`const env = gitEnv(r);\n`).allowlist.length, 0, 'a gitEnv() spawn is not an allowlist one');
  const notSound = alCensus(`const env = { PATH: ${PE}.PATH };\n`);
  assert.equal(notSound.findings.length, 1);
  assert.match(notSound.findings[0], /env: env is not declared `const env = gitEnv\(\.\.\.\)`/, 'the old reason stays first');
  assert.match(notSound.findings[0], /GIT_CONFIG_NOSYSTEM/, 'and the allowlist reason follows it, so the reader knows what to add');
  const bare = alCensus('', `${SP}('git', [], { env: { PATH: '/x' } });\n`);
  assert.equal(bare.findings.length, 1);
});

test('08c allowlist: the room\'s own release-notes.mjs passes the census with NO exemption row (it builds its env from an allowlist)', () => {
  const file = fs.readFileSync(new URL('../release-notes.mjs', import.meta.url), 'utf8');
  const r = censusGitSpawns([{ label: 'scripts/release-notes.mjs', text: file }], { exemptions: [] });
  assert.deepEqual(r.findings, []);
  assert.equal(r.gitSpawns.length, 1);
  assert.equal(r.allowlist.length, 1);
});

test('08c allowlist: an exemption row for a spawn the allowlist rule now accepts is reported UNUSED, so the old pin cannot linger', () => {
  const row = { label: 'scripts/x.test.mjs', expr: 'env', count: 1, reason: 'old pin' };
  const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: BINDINGS + AL_KEEP + AL_ENV + AL_SPAWN }], { exemptions: [row] });
  assert.deepEqual(r.findings, []);
  assert.equal(r.unusedExemptions.length, 1);
});

test('08c allowlist: a write to process.env.X in the same file is not a mutation of a local env (a name preceded by a dot is someone else\'s object)', () => {
  const r = alCensus(AL_KEEP + AL_ENV + `${PE}.TZ = 'UTC';\n${PE}['LANG'] = 'C';\n${PE}.NODE_ENV ||= 'test';\n`);
  assert.deepEqual(r.findings, []);
  assert.equal(r.allowlist.length, 1);
  const g = alCensus(`const env = gitEnv(r);\n${PE}.TZ = 'UTC';\n`);
  assert.deepEqual(g.findings, [], 'the gitEnv() alias gets the same fix');
  // the real thing is still caught, dotted or not
  assert.equal(alCensus(AL_KEEP + AL_ENV + "env.GIT_DIR = x;\n").findings.length, 1);
});

// ======================================================================================================================================================================
// 08d: the CENSUS WITNESS LIST (U/scratchpad/dispatch/08d-census-witness-list.md): one red-first fixture per vector, F1 to F42, R1 and R2, P1 to P6, and the extras X1 to X11 this
// unit's own attack on the fix added. A vector with a const env runs in BOTH call forms, `env: env` and the shorthand `{ env }`; an env expression also runs inline. Every leg is fed to
// censusGitSpawns with NO exemption rows and must be counted as a git spawn and judged: exactly one finding for a FAIL leg, none for a PASS leg.
const W_LEGS = (() => {
  const PRO = 'process';
  const BT = String.fromCharCode(96); // a backtick
  const BS = String.fromCharCode(92); // a backslash
  const IMPORTS = `import { ${SP} } from 'node:child${'_'}process';\nimport { gitEnv } from './lib/git-env.mjs';\n`;
  const call = (envPart, cmd = "'git'") => `${SP}(${cmd}, ['status'], { cwd: d, ${envPart} });\n`;
  const CLEAN = `{ PATH: ${PE}.PATH, HOME: ${PE}.HOME, GIT_CONFIG_NOSYSTEM: '1' }`;
  const KEEP = `const keep = ['PATH', 'HOME'];\n`;
  const PICK = `...Object.fromEntries(keep.filter((k) => k in ${PE}).map((k) => [k, ${PE}[k]]))`;

  const out = [];
  const add = (id, fail, form, text, note = '') => out.push({ id, fail, form, text: IMPORTS + text, note });
  // an env EXPRESSION in the three forms: inline, a const read as env: env, a const read as the shorthand { env }; `post` lines run after the declaration
  function expr(id, fail, e, { pre = '', post = '', note = '' } = {}) {
    if (!post) add(id, fail, 'inline', `${pre}${call('env: ' + e)}`, note); // a mutation line needs a name to act on
    add(id, fail, 'env: env', `${pre}const env = ${e};\n${post}${call('env: env')}`, note);
    add(id, fail, '{ env }', `${pre}const env = ${e};\n${post}${call('env')}`, note);
  }
  // a const-env vector with its own text, both call forms
  function constForms(id, fail, textFor, note = '') {
    add(id, fail, 'env: env', textFor('env: env'), note);
    add(id, fail, '{ env }', textFor('env'), note);
  }

  // ---- MUST FAIL ----
  expr('F1a', true, `{ ...base, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const base = { ...${PE} };\n` });
  expr('F1b', true, `{ ...extra, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const extra = ${PE};\n` });
  expr('F1c', true, `{ ...Object.fromEntries(Object.entries(e)), GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const e = ${PE};\n` });
  expr('F2', true, `{ ...Object.fromEntries(Object.entries(${PE})), GIT_CONFIG_NOSYSTEM: '1' }`);
  expr('F3', true, `{ ...Object.fromEntries(Object.entries(${PE}).filter(() => true)), GIT_CONFIG_NOSYSTEM: '1' }`);
  expr('F4', true, `{ ...${PRO}['env'], GIT_CONFIG_NOSYSTEM: '1' }`);
  expr('F5', true, `{ ...penv, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `import { env as penv } from 'node:process';\n` });
  expr('F6', true, `{ ...gitEnv(d), ...${PE} }`);
  expr('F7', true, `{ ...gitEnv(d), ...base }`, { pre: `const base = { ...${PE} };\n` });
  expr('F8', true, `{ GIT_CONFIG_NOSYSTEM: '1', extra: { ...${PE} } }`);
  expr('F9', true, `{ ...Object.fromEntries(keep.filter(Boolean).map((k) => [k, ${PE}[k]]).concat(Object.entries(${PE}))), GIT_CONFIG_NOSYSTEM: '1' }`, { pre: KEEP });
  expr('F10', true, `{ ...Object.fromEntries(keep.filter(Boolean).flatMap(() => Object.entries(${PE}))), GIT_CONFIG_NOSYSTEM: '1' }`, { pre: KEEP });
  expr('F11', true, `{ GIT_CONFIG_NOSYSTEM: '1', all: ${PE} }`);
  expr('F12', true, `{ ...Object.fromEntries(Object.entries(all())), GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `function all() { return ${PE}; }\n` });
  add('F13', true, 'env: mk(d)', `function mk(x) { if (x) return { PATH: ${PE}.PATH, GIT_CONFIG_NOSYSTEM: '1' }; return ${PE}; }\n${call('env: mk(d)')}`);
  add('F14', true, 'env: sandboxEnv(cwd)', call('env: sandboxEnv(cwd)'));
  expr('F15', true, CLEAN, { post: `Object.assign(env, ${PE});\n` });
  expr('F16', true, `{ GIT_CONFIG_NOSYSTEM: '1' }`, { post: `for (const k of Object.keys(${PE})) env[k] = ${PE}[k];\n` });
  expr('F17', true, CLEAN, { post: `env.GIT_DIR = '/elsewhere/.git';\n` });
  expr('F18', true, `{ ...Object.fromEntries(KEYS.filter((k) => k in ${PE}).map((k) => [k, ${PE}[k]])), GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const KEYS = ['PATH'];\nKEYS.push('GIT_DIR');\n` });
  expr('F19', true, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const keep = ['PATH', 'GIT_DIR'];\n` });
  expr('F20', true, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const k2 = ['GIT_DIR'];\nconst keep = ['PATH', ...k2];\n` });
  expr('F21', true, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const keep = ['PATH', 'GIT_' + 'DIR'];\n` });
  expr('F22', true, `{ GIT_CONFIG_NOSYSTEM: '1', ['GIT' + '_DIR']: ${PE}['GIT' + '_DIR'] }`);
  expr('F23', true, `{ PATH: ${PE}.PATH, GIT_CONFIG_NOSYSTEM: '0' }`);
  expr('F24', true, `{ PATH: ${PE}.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '0' }`);
  expr('F25', true, `{ GIT_CONFIG_NOSYSTEM: '1', ${PICK}, ...over }`, { pre: `${KEEP}const over = { GIT_CONFIG_NOSYSTEM: '0' };\n` });
  expr('F26', true, `{ PATH: ${PE}.PATH }`);
  expr('F27', true, `{ PATH: ${PE}.PATH, GIT_CONFIG_NOSYSTEM: flag }`);
  expr('F28a', true, `{ PATH: ${PE}.PATH /* GIT_CONFIG_NOSYSTEM: '1' */ }`);
  expr('F28b', true, `{ PATH: ${PE}.PATH }`, { pre: `// GIT_CONFIG_NOSYSTEM: '1'\n` });
  expr('F28c', true, `{ // GIT_CONFIG_NOSYSTEM: '1'\n  PATH: ${PE}.PATH }`);
  expr('F29', true, `{ PATH: ${PE}.PATH, git_dir: d, GIT_CONFIG_NOSYSTEM: '1' }`);
  expr('F30', true, `{ PATH: ${PE}.PATH, GIT_DIR: x, GIT_CONFIG_NOSYSTEM: '1' }`);
  // scope and binding
  constForms('F31a', true, (form) => `function a() { const env = ${CLEAN}; return env; }\nfunction b() { ${call(form).trim()} }\n`, 'the spawn is not in the scope of the clean declaration');
  constForms('F31b', true, (form) => `function a() { const env = ${CLEAN}; return env; }\nfunction b() { const env = { ...${PE} }; ${call(form).trim()} }\n`, 'a second declaration in b()');
  add('F31c', true, 'inline', `function a() { const env = ${CLEAN}; return env; }\nfunction b() { ${call('env: { ...' + PE + ' }').trim()} }\n`);
  constForms('F32', true, (form) => `const env = ${CLEAN};\nfunction f() { let env = { ...${PE} }; ${call(form).trim()} }\n`);
  constForms('F33', true, (form) => `const env = ${CLEAN};\nfunction run(env) { ${call(form).trim()} }\n`, 'env is a parameter at the spawn');
  add('F34', true, 'env: e2', `function one() { const e2 = ${CLEAN}; return e2; }\nfunction two() { const e2 = { ...${PE} }; ${call('env: e2').trim()} }\n`);
  // round 2
  expr('F35', true, CLEAN, { post: `const alias = env;\nfor (const k in ${PE}) alias[k] = ${PE}[k];\n` });
  expr('F36', true, CLEAN, { post: `function fill(o) { for (const k in ${PE}) o[k] = ${PE}[k]; }\nfill(env);\n` });
  expr('F37', true, CLEAN, { post: `Reflect.set(env, 'GIT_DIR', d);\n` });
  expr('F38', true, CLEAN, { post: `const alias = env;\nalias.GIT_DIR = d;\n` });
  expr('F39', true, CLEAN, { post: `Object.assign(Object(env), { GIT_DIR: d });\n` });
  expr('F40', true, CLEAN, { post: `env.__defineGetter__('GIT_DIR', () => d);\n` });
  expr('F41a', true, `{ A: /'/.source, GIT_DIR: d, B: 'x', GIT_CONFIG_NOSYSTEM: '1' }`, { note: 'a regex literal holding a quote before the GIT_DIR entry' });
  expr('F41b', true, `{ A: ${BT}${BS}${BT}${BT}, GIT_DIR: d, GIT_CONFIG_NOSYSTEM: '1' }`, { note: 'a template value holding an escaped backtick before the GIT_DIR entry' });
  expr('F41c', true, `{ A: /"/.test(x) ? '${BS}x47IT_DIR' : 1, B: 'GIT_', GIT_DIR: d, GIT_CONFIG_NOSYSTEM: '1' }`);
  add('F41d', true, 'env: env', `const re = /'/;\nconst env = { GIT_DIR: d, ${'PATH: ' + PE + '.PATH'}, GIT_CONFIG_NOSYSTEM: '1' };\n${call('env: env')}`, 'a regex with a quote in the file region before the declaration');
  add('F41e', true, 'inline', `const r = /'${BS}//; ${call('env: ' + PE).trim()}\n`, 'a regex ending in // on the line before the spawn: the old comment test read the call as a comment');
  add('F42a', true, 'env: gitEnv()', `function gitEnv() { return { ...${PE} }; }\n${call('env: gitEnv()')}`.replace("import { gitEnv } from './lib/git-env.mjs';\n", ''));
  add('F42b', true, 'env: gitEnv()', `const gitEnv = (d) => ({ ...${PE}, GIT_CEILING_DIRECTORIES: d });\n${call('env: gitEnv(d)')}`);
  add('F42c', true, 'env: gitEnv()', `const gitEnv = () => ${PE};\n${call('env: gitEnv()')}`);
  add('R1', true, 'template command', call('env: ' + PE, BT + 'git' + BT), 'a counted spawn WITH a finding');
  add('R2', true, "'git.exe'", call('env: ' + PE, "'git.exe'"), 'a counted spawn WITH a finding');
  // extras found while building this unit (candidate rows for the list)
  expr('X1', true, `{ PATH: ${PE}.PATH, '${BS}x47IT_DIR': d, GIT_CONFIG_NOSYSTEM: '1' }`, { note: 'a hex escape inside a quoted key: the raw text holds no GIT_ at all' });
  expr('X2', true, `{ PATH: ${PE}.PATH, ${BS}u0047IT_DIR: d, GIT_CONFIG_NOSYSTEM: '1' }`, { note: 'a unicode escape in an unquoted key' });
  expr('X3', true, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: `const keep = ['PATH', 'GIT_${BS}x44IR'];\n`, note: 'an escaped GIT_ name in the key list' });
  add('X4', true, 'options spread', `const opts = {};\n${SP}('git', ['status'], { env: gitEnv(), ...opts });\n`, 'a later spread can carry env:');
  expr('X5', true, `{ GIT_CONFIG_NOSYSTEM: '1', ${PICK} }`, { pre: `const keep = ['PATH', 'GIT_CONFIG_NOSYSTEM'];\n`, note: 'the key list names NOSYSTEM and the spread comes after the literal 1: the ambient value wins' });
  add('X6', true, 'quoted env key', `${SP}('git', ['status'], { cwd: d, 'env': ${PE} });\n`, 'a quoted env key');
  add('X7', true, 'second env key', `${SP}('git', ['status'], { cwd: d, env: gitEnv(), env: ${PE} });\n`, 'the last env: wins');

  // ---- MUST PASS ----
  expr('P3', false, 'gitEnv(d)');
  expr('P4', false, CLEAN);
  expr('P5', false, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1' }`, { pre: KEEP });
  expr('P6', false, `{ ${PICK}, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: d }`, { pre: KEEP });
  add('P7', false, 'helper', `const sandboxEnv = (dir) => ({ PATH: ${PE}.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' });\n${call('env: sandboxEnv(cwd)')}`, 'a same-file arrow helper whose body is one allowlist literal');
  add('P8', false, 'helper function', `function sandboxEnv(dir) { return { PATH: ${PE}.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' }; }\n${call('env: sandboxEnv(cwd)')}`, 'a same-file function whose only statement is the return of one allowlist literal');
  add('P9', false, 'regex in a value', `const env = { HOME: d, X: d.replace(/[${BS}${BS}/]+$/, ''), GIT_CONFIG_NOSYSTEM: '1' };\n${call('env')}`, 'a regex literal in a value is read, not refused');
  // extras 2 (attack on the fix): the env: property must be the spawn's own, single, plainly-spelled one
  add('X8', true, "['env']: key", `${SP}('git', ['status'], { cwd: d, env: gitEnv(), ['env']: ${PE} });\n`, 'a computed key spelled out wins over the plain one');
  add('X9', true, 'getter env', `${SP}('git', ['status'], { cwd: d, env: gitEnv(), get env() { return ${PE}; } });\n`, 'a getter named env');
  add('X10', true, 'nested object', `${SP}('git', ['status'], Object.assign({}, { env: gitEnv() }, opts));\n`, 'another argument can override the env: of a wrapped object');
  add('X11', true, 'computed key', `${SP}('git', ['status'], { cwd: d, env: gitEnv(), [k]: ${PE} });\n`, 'a computed key can be env');
  return out;

})();
const W_BY_ID = new Map();
for (const leg of W_LEGS) { if (!W_BY_ID.has(leg.id)) W_BY_ID.set(leg.id, []); W_BY_ID.get(leg.id).push(leg); }
for (const [id, legs] of W_BY_ID) {
  const fail = legs[0].fail;
  const note = legs.map((l) => l.note).find(Boolean) || '';
  test(`08d witness ${id}: ${fail ? 'a finding' : 'clean, no row'} in ${legs.map((l) => l.form).join(' and ')}${note ? ' (' + note + ')' : ''}`, () => {
    for (const leg of legs) {
      const r = censusGitSpawns([{ label: 'scripts/x.test.mjs', text: leg.text }], { exemptions: [] });
      assert.ok(r.gitSpawns.length >= 1, `${id} [${leg.form}]: the spawn is counted`);
      if (fail) assert.equal(r.findings.length, 1, `${id} [${leg.form}] must be a finding: ${leg.text}`);
      else assert.deepEqual(r.findings, [], `${id} [${leg.form}] must be clean with no row`);
    }
  });
}

// ======================================================================================================================================================================
// 08d: one fixture per branch of the rewrite that the witness table alone left unkilled. The 08d mutation wave (return, ## 08d BUILD) listed each of these as a SURVIVOR
// before the leg existed; each leg below is the red-first proof for it. A refusal leg asserts exactly one finding and that the spawn is NOT counted as an allowlist spawn;
// an acceptance leg asserts no finding and one allowlist spawn.
const R_BS = String.fromCharCode(92); // a backslash, built from its code point
const R_NS = "GIT_CONFIG_NOSYSTEM: '1'";
const R_HEAD = `import { ${SP} } from '${MOD}';\n`; // a file that binds the spawn and NOTHING else (no gitEnv import)
const R_SPAWN = (env) => `${SP}('git', ['x'], { env: ${env} });\n`;
const R_FROM = (keys, tail = '') => `...Object.fromEntries(${keys}.map((k) => [k, ${PE}[k]])${tail})`;
const refused = (r, why, re) => {
  assert.equal(r.findings.length, 1, `${why}: ${JSON.stringify(r.findings)}`);
  assert.equal(r.allowlist.length, 0, `${why}: not an allowlist spawn`);
  if (re) assert.match(r.findings[0], re, why);
};
const accepted = (r, why) => {
  assert.deepEqual(r.findings, [], why);
  assert.equal(r.allowlist.length, 1, `${why}: counted as an allowlist spawn`);
};
const withKeys = (head, keysExpr = 'KEYS', tail = '') => raw(BINDINGS + head + R_SPAWN(`{ ${R_FROM(keysExpr, tail)}, ${R_NS} }`));

test('08d rules: gitEnv is trusted from the room git-env.mjs (or git-test-env.mjs) and from no other module', () => {
  refused(raw(R_HEAD + `import { gitEnv } from './other.mjs';\n` + R_SPAWN('gitEnv()')), 'another module', /gitEnv/);
  assert.equal(raw(R_HEAD + `import { gitEnv } from './lib/git-env.mjs';\n` + R_SPAWN('gitEnv()')).findings.length, 0);
  assert.equal(raw(R_HEAD + `import { gitTestEnv } from '../scripts/lib/git-test-env.mjs';\n` + R_SPAWN('gitTestEnv()')).findings.length, 0);
});

test('08d rules: a renamed import does not bind the trusted name', () => {
  refused(raw(R_HEAD + `import { gitEnv as other } from './lib/git-env.mjs';\n` + R_SPAWN('gitEnv()')), 'import ... as other');
  refused(raw(R_HEAD + `import { gitEnv as other, thing as gitEnv } from './lib/git-env.mjs';\n` + R_SPAWN('gitEnv()')), 'another export renamed to gitEnv');
});

test('08d rules: a dynamic import binds the trusted name only by the bare shorthand (MUTATION FINDING: { other: gitEnv } bound it to another export and was trusted)', () => {
  refused(raw(R_HEAD + `const { other: gitEnv } = await import('./lib/git-env.mjs');\n` + R_SPAWN('gitEnv()')), 'a rename in a dynamic import');
  assert.equal(raw(R_HEAD + `const { gitEnv } = await import('./lib/git-env.mjs');\n` + R_SPAWN('gitEnv()')).findings.length, 0);
  assert.equal(raw(R_HEAD + `const { x, gitEnv } = await import('./lib/git-env.mjs');\n` + R_SPAWN('gitEnv()')).findings.length, 0);
});

test('08d rules: a mention of the trusted helper other than a call may be a rebinding, so it is refused', () => {
  refused(raw(BINDINGS + 'const copy = gitEnv;\n' + R_SPAWN('gitEnv()')), 'gitEnv copied', /mentioned other than as a call/);
});

test('08d rules: brackets that do not balance are a finding, whatever the mismatch', () => {
  const spawn = R_SPAWN('gitEnv()');
  assert.match(raw(BINDINGS + spawn + 'x = 1);\n').findings.join('\n'), /do not balance/);
  assert.match(raw(BINDINGS + spawn + 'x = [1, 2);\n').findings.join('\n'), /do not balance/);
  assert.match(raw(BINDINGS + spawn + 'x = (1, 2;\n').findings.join('\n'), /do not balance/);
});

test('08d rules: a file the lexer cannot read whole is a finding, not a guess', () => {
  assert.match(raw(BINDINGS + R_SPAWN('gitEnv()') + "const s = 'oops;\n").findings.join('\n'), /could not be tokenized/);
});

test('08d rules: scope -- a binding declared in another block is not the binding the spawn reads', () => {
  refused(raw(BINDINGS + `if (a) { const KEYS = ['PATH']; }\nconst env = { ${R_FROM('KEYS')}, ${R_NS} };\n` + R_SPAWN('env')), 'a key list in another block', /block/);
  refused(raw(BINDINGS + `if (a) { const env = { ${R_NS} }; }\n` + R_SPAWN('env')), 'an env alias in another block', /block/);
  accepted(raw(BINDINGS + `{ const env = { ${R_NS} };\n${R_SPAWN('env')}}\n`), 'the same block');
});

test('08d rules: a statement that goes on after the literal is not the bare literal', () => {
  refused(raw(BINDINGS + `const env = { ${R_NS} }\n${BT}x${BT};\n` + R_SPAWN('env')), 'a tagged template on the next line');
  refused(raw(BINDINGS + `const env = { ${R_NS} }\n  .x;\n` + R_SPAWN('env')), 'a member access on the next line');
  accepted(raw(BINDINGS + `const env = { ${R_NS} }\nconst z = 1;\n` + R_SPAWN('env')), 'a plain next statement');
  refused(raw(BINDINGS + `const KEYS = ['PATH'].concat(['GIT_DIR']);\nconst env = { ${R_FROM('KEYS')}, ${R_NS} };\n` + R_SPAWN('env')), 'a key list with a call after the array');
});

test('08d rules: a same-file helper is read only when it is one plain declaration that returns one literal', () => {
  const lit = `{ ${R_NS} }`;
  accepted(raw(BINDINGS + `const mk = () => (${lit});\n` + R_SPAWN('mk()')), 'an arrow helper');
  accepted(raw(BINDINGS + `function mk() { return ${lit}; }\n` + R_SPAWN('mk()')), 'a function helper');
  refused(raw(BINDINGS + `const mk = () => (${lit});\nconst other = mk;\n` + R_SPAWN('mk()')), 'the helper is mentioned other than as a call', /other than as a call/);
  refused(raw(BINDINGS + `const mk = () => (${lit});\nfunction mk() { return ${lit}; }\n` + R_SPAWN('mk()')), 'declared twice', /declared 2 times/);
  refused(raw(BINDINGS + `const mk = async () => (${lit});\n` + R_SPAWN('mk()')), 'async', /async/);
  refused(raw(BINDINGS + `function mk() { return ${lit}; mutate(); }\n` + R_SPAWN('mk()')), 'more than the return', /does more than return/);
  refused(raw(BINDINGS + `const mk = () => (${lit}).x;\n` + R_SPAWN('mk()')), 'more after the object', /more after the object/);
});

test('08d rules: the key list is declared once with const, holds only literals of harmless names, is used only as the head of the chain, and ends its statement', () => {
  accepted(withKeys(`const KEYS = ['PATH', 'GIT_CEILING_DIRECTORIES'];\n`), 'the canon shape');
  refused(withKeys(`const KEYS = ['PATH'];\nlet KEYS = ['GIT_DIR'];\n`), 'declared twice', /declared 2 times/);
  refused(withKeys(`let KEYS = ['PATH'];\n`), 'declared with let', /not declared with const/);
  refused(withKeys(`const KEYS = ['PATH', other];\n`), 'a non-literal entry', /more than plain string literals/);
  refused(withKeys(`const KEYS = ['PATH', 'GIT_DIR'];\n`), 'a GIT_ name', /GIT_DIR/);
  refused(withKeys(`const KEYS = ['PATH'];\nconsole.log(KEYS.length);\n`), 'used another way', /used other than as the head/);
});

test('08d rules: the one spread read is Object.fromEntries(KEYS[.filter(canon)].map(canon)) and nothing wraps or follows it', () => {
  accepted(withKeys(`const KEYS = ['PATH'];\n`, 'KEYS.filter((k) => ' + PE + '[k] !== undefined)'), 'with the canon filter');
  accepted(withKeys(`const KEYS = ['PATH'];\n`, 'KEYS.filter((k) => k in ' + PE + ')'), 'with the in-form filter');
  refused(withKeys(`const KEYS = ['PATH'];\n`, 'KEYS.filter((k) => keep(k))'), 'a filter that is not the canon predicate', /\.filter/);
  refused(raw(BINDINGS + `const KEYS = ['PATH'];\n` + R_SPAWN(`{ ...evil(KEYS.map((k) => [k, ${PE}[k]])), ${R_NS} }`)), 'a wrapper that is not Object.fromEntries', /spreads/);
  refused(raw(BINDINGS + `const KEYS = ['PATH'];\n` + R_SPAWN(`{ ...Object.fromEntries(KEYS.map((k) => [k, ${PE}[k]]).concat(more)), ${R_NS} }`)), 'a chain that goes on after .map', /after \.map|more after/);
});

test('08d rules: a literal property is a name or a string with a plain value, never a computed key, __proto__ or a bare expression', () => {
  refused(raw(BINDINGS + R_SPAWN(`{ [name]: 'x', ${R_NS} }`)), 'a computed key', /computed key/);
  refused(raw(BINDINGS + R_SPAWN(`{ __proto__: evil, ${R_NS} }`)), '__proto__', /__proto__/);
  refused(raw(BINDINGS + R_SPAWN(`{ A: 'x', ${R_NS}, wat }`).replace(', wat', ', 1 + 2')), 'a property that is no key');
});

test('08d rules: GIT_CONFIG_NOSYSTEM is the literal 1, set once, after every spread', () => {
  accepted(raw(BINDINGS + R_SPAWN(`{ ${R_NS}, A: 'x' }`)), 'a plain literal');
  accepted(raw(BINDINGS + R_SPAWN(`{ GIT_CONFIG_NOSYSTEM: 1 }`)), 'the number 1');
  refused(raw(BINDINGS + R_SPAWN(`{ GIT_CONFIG_NOSYSTEM: '1' + other }`)), 'an expression starting with 1', /must be the literal 1/);
  refused(raw(BINDINGS + R_SPAWN(`{ GIT_CONFIG_NOSYSTEM: 0 }`)), 'the number 0', /must be the literal 1/);
  refused(raw(BINDINGS + R_SPAWN(`{ GIT_CONFIG_NOSYSTEM: 2 }`)), 'the number 2', /must be the literal 1/);
  refused(raw(BINDINGS + R_SPAWN(`{ ${R_NS}, A: 'x', ${R_NS} }`)), 'set twice', /more than once/);
  refused(raw(BINDINGS + R_SPAWN(`{ A: 'x' }`)), 'missing', /does not set GIT_CONFIG_NOSYSTEM/);
  refused(raw(BINDINGS + `const KEYS = ['PATH'];\n` + R_SPAWN(`{ ${R_NS}, ${R_FROM('KEYS')} }`)), 'before a spread', /before a spread/);
});

test('08d rules: an env alias is used only as the env value of a child_process call, and is declared once', () => {
  accepted(raw(BINDINGS + `const env = { ${R_NS} };\n${SP}('git', ['x'], { env });\n`), 'the shorthand');
  refused(raw(BINDINGS + `const env = { ${R_NS} };\nconst other = { env };\n${SP}('git', ['x'], { env });\n`), 'the shorthand outside a call', /used outside its declaration/);
  refused(raw(BINDINGS + `const e = { ${R_NS} };\n${SP}('git', ['x'], { env: e, input: { e } });\n`), 'a shorthand of another name inside the call', /used outside its declaration/);
  accepted(raw(BINDINGS + `const env = { ${R_NS} };\nconst p = cfg?.env;\n${SP}('git', ['x'], { env });\n`), 'a property named env after ?. is not a use');
  accepted(raw(BINDINGS + `const ${R_BS}u0065nv = { ${R_NS} };\n${SP}('git', ['x'], { env });\n`), 'a declaration spelled with a unicode escape is still env');
});

test('08d rules: the options object has ONE env property, spelled env:, in the spawn own object, with nothing after it that can override', () => {
  refused(raw(BINDINGS + `${SP}('git', ['x'], { ['env']: gitEnv() });\n`), 'a computed key', /computed key/);
  refused(raw(BINDINGS + `${SP}('git', ['x'], { env: gitEnv(), env: gitEnv() });\n`), 'twice', /2 env properties/);
  refused(raw(BINDINGS + `${SP}('git', ['x'], merge({ env: gitEnv() }, other));\n`), 'inside a call that another argument can override', /not an argument of the spawn itself/);
  refused(raw(BINDINGS + `${SP}('git', ['x'], { env: gitEnv(), [k]: 1 });\n`), 'a computed key beside it', /computed key/);
  refused(raw(BINDINGS + `${SP}('git', ['x'], { env: gitEnv(), ...other });\n`), 'a spread after it', /spreads another object after env/);
  accepted(raw(BINDINGS + `${SP}('git', ['x'], { ...base, ${'env'}: { ${R_NS} } });\n`), 'a spread BEFORE it is overridden by it');
});

test('08d rules: a command written with escapes is read as written AND as decoded', () => {
  const r = raw(BINDINGS + `${SP}('g${R_BS}x69t', ['x'], {});\n`);
  assert.equal(r.gitSpawns.length, 1, 'g\\x69t is git');
  assert.equal(r.findings.length, 1);
});

test('08d rules: a comment inside an allowlist literal that names a GIT_ variable is a comment, not a key', () => {
  accepted(raw(BINDINGS + R_SPAWN(`{ /* GIT_DIR is dropped */ ${R_NS} }`)), 'a block comment');
  accepted(raw(BINDINGS + R_SPAWN(`{ ${R_NS} // GIT_INDEX_FILE too\n}`)), 'a line comment');
});

test('08d rules: process[env] is a mention of the environment, named so in the finding', () => {
  refused(raw(BINDINGS + R_SPAWN(`process['env']`)), 'process[env]', /mentions process\.env/);
});

// 08d: the COMMAND row. A command that is not a string literal is a finding no env row can cover; one byte-equal carrier needs it once, so a row may name the command's source,
// pinned by blob id and counted, exactly as an env row does.
const C_TEXT = `${R_HEAD}const r = ${SP}(process.env.ComSpec || 'cmd.exe', ['/c', script], { env: other });\n`;
const C_ROW = (over = {}) => ({ label: 'scripts/carrier.test.mjs', command: "process.env.ComSpec || 'cmd.exe'", count: 1, blob: blobId(C_TEXT), reason: 'a computed shell that is not git', ...over });

test('08d command row: with no row a computed command is a finding; with a pinned row it is exempt, counted and printed', () => {
  const none = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: C_TEXT }], { exemptions: [] });
  assert.equal(none.findings.length, 1);
  assert.match(none.findings[0], /command is not a string literal/);
  const row = C_ROW();
  const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: C_TEXT }], { exemptions: [row] });
  assert.deepEqual(r.findings, []);
  assert.equal(r.exempt.length, 1);
  assert.equal(r.exempt[0].reason, row.reason);
  assert.match(r.exempt[0].expr, /^command /);
  assert.equal(r.gitSpawns.length, 1, 'counted with the spawns, so the printed arithmetic adds up');
  assert.deepEqual(r.unusedExemptions, []);
});

test('08d command row: a changed file (another blob) is a finding naming the pin', () => {
  const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: C_TEXT + '// edited\n' }], { exemptions: [C_ROW()] });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /exempt only at blob/);
  assert.equal(r.exempt.length, 0);
});

test('08d command row: another file, another command, or one spawn too many is a finding', () => {
  assert.equal(censusGitSpawns([{ label: 'scripts/other.test.mjs', text: C_TEXT }], { exemptions: [C_ROW()] }).findings.length, 1, 'another label');
  const other = C_TEXT.replace('process.env.ComSpec', 'process.env.Other');
  assert.equal(censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: other }], { exemptions: [C_ROW({ blob: undefined })] }).findings.length, 1, 'another command');
  const twice = C_TEXT + C_TEXT.split('\n')[1] + '\n';
  const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: twice }], { exemptions: [C_ROW({ blob: undefined })] });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /allows 1 spawn/);
});

test('08d command row: a row whose spawn is gone is reported as unused, so it cannot outlive its content', () => {
  const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text: `${R_HEAD}const a = 1;\n` }], { exemptions: [C_ROW({ blob: undefined })] });
  assert.equal(r.unusedExemptions.length, 1);
  assert.match(r.unusedExemptions[0].expr, /^command /);
});

test('08d command row: a file with a command row AND an env row judges each spawn by its own row, in either order', () => {
  const text = `${R_HEAD}const r = ${SP}(process.env.ComSpec || 'cmd.exe', ['/c', script], { env: other });\n${SP}('git', ['x'], { env: wrapped(1) });\n`;
  const envRow = { label: 'scripts/carrier.test.mjs', expr: 'wrapped(1)', count: 1, reason: 'a wrapper' };
  const cmdRow = C_ROW({ blob: undefined });
  for (const rows of [[cmdRow, envRow], [envRow, cmdRow]]) {
    const r = censusGitSpawns([{ label: 'scripts/carrier.test.mjs', text }], { exemptions: rows });
    assert.deepEqual(r.findings, []);
    assert.equal(r.exempt.length, 2);
    assert.deepEqual(r.unusedExemptions, []);
  }
});
