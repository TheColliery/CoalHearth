// CWK-075 — pointer gate. Driven in memory; `resolve`/`hasEntry` are injected, so no
// fixture tree and no temp dirs.
//
// PLATFORM: every assertion about separators is made EXPLICITLY, never left to the local
// run. A sibling room turned all four of its Unix CI legs red because a test asserted a
// WINDOWS fact as universal — on POSIX a backslash is a legal FILENAME character, not a
// separator, so `..\..\escape.md` resolves INSIDE the repo there. The shipped module was
// never platform-conditional; the test was. Ours asserts the module's own rule (a citation
// is `/`-delimited, and a backslash is rejected outright) which holds identically on both.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pointerCandidates, checkPointers } from './pointer-check.mjs';

const OURS = new Set(['scripts', 'lib', 'bin', 'README.md', '.github', 'commands']);
const base = (over = {}) => ({
  ourRoots: OURS,
  ignoredRoots: new Set(),
  agentHomes: new Set(),
  vendorHomes: [],
  hasEntry: () => false,
  resolve: () => 'tracked',
  pending: [],
  ...over,
});
const fails = (f) => f.filter((x) => x.level === 'FAIL').map((x) => x.msg);

// ---------------------------------------------------------------- SHAPE
test('shape: a plain in-tree path is a candidate; the eight rejects are not', () => {
  const t = [
    '`lib/handoff-journal.js`',              // kept
    '`node scripts/verify.mjs`',             // whitespace: a command
    '`<project>/.coalhearth.json`',          // <placeholder>
    '`scripts/*.mjs`',                       // glob
    '`SKILL.md`',                            // no slash: the USER's repo
    '`/etc/passwd`', '`~/.claude/x`', '`https://example.com/a/b`', // outside
    '`../hooks.json`',                       // dot segment
    '`scripts\\lib\\x.mjs`',                 // backslash
  ].join(' ');
  assert.deepEqual(pointerCandidates(t), ['lib/handoff-journal.js']);
});

test('shape: a fenced block is an EXAMPLE, not a claim about this tree', () => {
  const t = '```\n`lib/inside-fence.js`\n```\n`lib/outside.js`\n';
  assert.deepEqual(pointerCandidates(t), ['lib/outside.js']);
});

test('shape: a dot-DIR survives — `.github/workflows/ci.yml` is a real name, not navigation', () => {
  assert.deepEqual(pointerCandidates('`.github/workflows/ci.yml`'), ['.github/workflows/ci.yml']);
});

test('POSIX vs win32, asserted explicitly rather than inferred from the local run', () => {
  // The module rejects the backslash outright, so the token never reaches resolution on
  // EITHER platform. Both joins are computed here only to show the divergence the
  // rejection makes irrelevant: win32 escapes the repo, posix does not.
  assert.deepEqual(pointerCandidates('`scripts/..\\..\\escape.md`'), []);
  assert.ok(path.win32.resolve('C:/repo', 'scripts/..\\..\\escape.md').toLowerCase().indexOf('c:\\repo\\') !== 0,
    'win32 treats the backslash as a separator, so this escapes the repo');
  assert.ok(path.posix.resolve('/repo', 'scripts/..\\..\\escape.md').startsWith('/repo/'),
    'posix treats the backslash as a FILENAME character, so this stays inside');
});

// ---------------------------------------------------------------- THREE STATES
test('a MISSING path FAILs, naming the citer and the token', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`lib/gone.js`' }],
    resolve: () => 'missing',
  }));
  assert.equal(fails(f).length, 1);
  assert.match(fails(f)[0], /README\.md cites `lib\/gone\.js`, which does not resolve/);
});

test('an EXISTING but UNTRACKED path FAILs — "exists" is not "reachable"', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`lib/local-only.js`' }],
    resolve: () => 'untracked',
  }));
  assert.match(fails(f)[0], /exists here but is UNTRACKED — a clone does not have it/);
});

test('a TRACKED path is silent', () => {
  const f = checkPointers(base({ surfaces: [{ label: 'README.md', text: '`lib/real.js`' }] }));
  assert.deepEqual(fails(f), []);
});

// ---------------------------------------------------------------- GITIGNORED
test('a GITIGNORED root FAILs even though resolve() would call it tracked', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`MEMORY.md/notes`' }],
    ourRoots: new Set([...OURS, 'MEMORY.md']),
    ignoredRoots: new Set(['MEMORY.md']),
    resolve: () => 'tracked',
  }));
  assert.match(fails(f)[0], /lives under the gitignored `MEMORY\.md`/);
});

test('a declaration CANNOT launder a gitignored path — the check runs before `pending`', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`MEMORY.md/notes`' }],
    ourRoots: new Set([...OURS, 'MEMORY.md']),
    ignoredRoots: new Set(['MEMORY.md']),
    pending: [{ path: 'MEMORY.md/notes', reason: 'trying to excuse it' }],
  }));
  assert.ok(fails(f).some((m) => /gitignored/.test(m)), fails(f).join(' | '));
});

test('a historyOnly surface is still checked for the gitignored case, and nothing else', () => {
  const ignored = checkPointers(base({
    surfaces: [{ label: 'CHANGELOG.md', text: '`MEMORY.md/x`', historyOnly: true }],
    ourRoots: new Set([...OURS, 'MEMORY.md']),
    ignoredRoots: new Set(['MEMORY.md']),
  }));
  assert.ok(fails(ignored).some((m) => /gitignored/.test(m)));
  const renamed = checkPointers(base({
    surfaces: [{ label: 'CHANGELOG.md', text: '`lib/renamed-away.js`', historyOnly: true }],
    resolve: () => 'missing',
  }));
  assert.deepEqual(fails(renamed), []); // correct on the day it was written
});

// ---------------------------------------------------------------- SCOPE
test('citer-relative: a path resolving only against the citer own dir is IN scope', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'platform-configs/hooks/README.md', text: '`templates/x.json`' }],
    hasEntry: (dir, name) => dir === 'platform-configs/hooks' && name === 'templates',
    resolve: () => 'missing',
  }));
  assert.match(fails(f)[0], /does not resolve/);
});

test('a path into someone else own tree is OUT of scope, silently and correctly', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`node_modules/pkg/index.js`' }],
    resolve: () => 'missing',
  }));
  assert.deepEqual(fails(f), []);
});

test('an AGENT HOME is excluded even where the root is also ours', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`.claude/coalhearth/session_handoff.json`' }],
    ourRoots: new Set([...OURS, '.claude']),
    agentHomes: new Set(['.claude']),
    resolve: () => 'missing',
  }));
  assert.deepEqual(fails(f), []);
});

test('a VENDOR HOME colliding with a real root of ours is excluded', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'platform-configs/hooks/README.md', text: '`.github/hooks/coalhearth.json`' }],
    vendorHomes: [{ path: '.github/hooks', reason: 'Copilot CLI home in the USER tree' }],
    resolve: () => 'missing',
  }));
  assert.deepEqual(fails(f), []);
});

test('a VENDOR HOME that no longer collides FAILs as dead weight', () => {
  const f = checkPointers(base({
    surfaces: [],
    vendorHomes: [{ path: '.nowhere/hooks', reason: 'stale' }],
  }));
  assert.match(fails(f)[0], /is not a root of this repo — nothing collides/);
});

// ---------------------------------------------------------------- CIRCULARITY
test('CIRCULAR-COUNT: `checked` does NOT move with the verdict for one in-scope token', () => {
  const run = (state) => {
    const f = checkPointers(base({
      surfaces: [{ label: 'README.md', text: '`lib/x.js`' }],
      resolve: () => state,
    }));
    return [f.checked, fails(f).length];
  };
  assert.deepEqual(run('tracked'), [1, 0]);
  assert.deepEqual(run('untracked'), [1, 1]);
  assert.deepEqual(run('missing'), [1, 1]);
  // Out of scope is the ONE case where checked legitimately drops — the token was never a
  // claim about this tree, so it is not counted and not judged.
  const out = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`elsewhere/x.js`' }],
    resolve: () => 'missing',
  }));
  assert.deepEqual([out.checked, fails(out).length], [0, 0]);
});

// ---------------------------------------------------------------- HYGIENE
test('an unreadable surface is NAMED as a SKIP, never filtered away by the caller', () => {
  const f = checkPointers(base({ surfaces: [{ label: 'GONE.md', text: null }] }));
  assert.ok(f.some((x) => x.level === 'SKIP' && /could not read GONE\.md/.test(x.msg)));
});

test('no resolve() supplied is a FAIL, never a quiet pass', () => {
  const f = checkPointers({ surfaces: [{ label: 'README.md', text: '`lib/x.js`' }] });
  assert.match(fails(f)[0], /no resolve\(\) supplied/);
});

test('PENDING expiry: a declared path that now resolves FAILs', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`lib/x.js`' }],
    pending: [{ path: 'lib/x.js', reason: 'CWK-000' }],
    resolve: () => 'tracked',
  }));
  assert.match(fails(f)[0], /but it now resolves — delete the entry/);
});

test('PENDING expiry: a declaration no surface cites FAILs as dead weight', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: 'nothing here' }],
    pending: [{ path: 'lib/never.js', reason: 'CWK-000' }],
    resolve: () => 'missing',
  }));
  assert.match(fails(f)[0], /no in-scope surface cites it — delete the entry/);
});

test('PENDING hygiene: an entry with no reason is a bypass with no author', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`lib/x.js`' }],
    pending: [{ path: 'lib/x.js' }],
    resolve: () => 'missing',
  }));
  assert.ok(fails(f).some((m) => /with no reason/.test(m)), fails(f).join(' | '));
});

test('a repeated token is judged once per surface, not once per occurrence', () => {
  const f = checkPointers(base({
    surfaces: [{ label: 'README.md', text: '`lib/gone.js` and again `lib/gone.js`' }],
    resolve: () => 'missing',
  }));
  assert.equal(fails(f).length, 1);
  assert.equal(f.checked, 1);
});
