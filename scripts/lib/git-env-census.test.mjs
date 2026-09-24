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
  assert.deepEqual(raw(`require('${MOD}').${SP}('git', ['init'], { env: gitEnv(x) });\n`).findings, []);
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
