// CWK-060 — config-key drift gate. Each case drives the checker in memory (the `read`
// injection point exists for exactly this), so no fixture tree and no temp dirs.
//
// EVERY LOCATOR IS PROVEN TO DETECT, and every DECLARATION path is exercised even where this
// room's own lists are empty — an empty list that was never run is an assumption, not a proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConfigKeys } from './config-keys.mjs';

const SCHEMA = {
  journal: { outputDirectory: {}, atomicityRetries: {} },
  recovery: { autoInjectPrompt: {}, stashUnsavedChanges: {} },
  update: { updateMode: {}, updateCheckDays: {} },
};
const mk = (files) => (f) => {
  if (!Object.hasOwn(files, f)) throw new Error('ENOENT ' + f);
  return files[f];
};
const fails = (r) => r.findings.filter((x) => x.level === 'FAIL').map((x) => x.msg);
const skips = (r) => r.findings.filter((x) => x.level === 'SKIP').map((x) => x.msg);
// Every case that is not specifically about a locator being broken supplies all three, so a
// zero-sites FAIL never masquerades as the finding under test.
const FULL_TEMPLATE = '{\n  // updateMode: ask\n  "update": {}\n}';
const FULL_TABLE = '## Configure\n\n| Key | Default |\n|---|---|\n| `update.updateMode` | `ask` |\n';

test('L1 prose: a dotted key that does not resolve FAILs, naming file and key', () => {
  const r = checkConfigKeys({
    schema: SCHEMA,
    mdFiles: ['README.md'],
    templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ 'README.md': 'Set `journal.historyLimit` to rotate.\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  const f = fails(r);
  assert.equal(f.length, 1, f.join(' | '));
  assert.match(f[0], /journal\.historyLimit is named in README\.md/);
});

test('L1 prose: a resolving dotted key is silent, and a non-key dotted token is not a candidate', () => {
  const r = checkConfigKeys({
    schema: SCHEMA,
    mdFiles: ['README.md'],
    templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    // `fs.statSync` and `task.md` are the shapes a naive dotted rule flagged (measured 11 FPs);
    // constraining the container half to the schema's own groups excludes them by construction.
    read: mk({ 'README.md': 'See `recovery.autoInjectPrompt`, `fs.statSync`, `task.md`.\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.deepEqual(fails(r), []);
});

test('L2 key table is SHAPE-FREE: a BARE unresolved first cell FAILs where L1 is blind', () => {
  const table = '## Configure\n\n| Key | Default |\n|---|---|\n| `bareInvented` | `1` |\n';
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], templateFiles: ['tpl'],
    keyTables: [{ file: 'README.md', heading: 'Configure' }],
    read: mk({ 'README.md': table, tpl: FULL_TEMPLATE }),
  });
  const f = fails(r);
  assert.equal(f.length, 1, f.join(' | '));
  assert.match(f[0], /key table README\.md \(under "Configure"\) documents bareInvented/);
});

test('L2: a CONTAINER name as the first cell RESOLVES — a group row is a correct claim', () => {
  // The defect this room's own history proof caught: an earlier README listed group rows.
  const table = '## Configure\n\n| Key | Default |\n|---|---|\n| `journal` | — |\n| `recovery` | — |\n';
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], templateFiles: ['tpl'],
    keyTables: [{ file: 'README.md', heading: 'Configure' }],
    read: mk({ 'README.md': table, tpl: FULL_TEMPLATE }),
  });
  assert.deepEqual(fails(r), []);
});

test('L3 template comments: a bare unresolved key in a SHIPPED comment FAILs', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    templateFiles: ['platform-configs/.coalhearth.json'],
    read: mk({
      'platform-configs/.coalhearth.json': '{\n  // legacyRetryCap is honoured here\n  "journal": {}\n}',
      'T.md': FULL_TABLE,
    }),
  });
  const f = fails(r);
  assert.equal(f.length, 1, f.join(' | '));
  assert.match(f[0], /legacyRetryCap is named in platform-configs/);
});

test('L3 scans the COMMENT half only: a camelCase JSON value is not a candidate', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    templateFiles: ['tpl'],
    read: mk({ tpl: '{\n  // updateMode: ask\n  "journal": { "outputDirectory": "someInventedPath" }\n}', 'T.md': FULL_TABLE }),
  });
  assert.deepEqual(fails(r), []);
});

// ZERO MATCHES MUST FAIL — a locator that found nothing is broken, not clean. This is the
// failure every prior adopter of this gate hit: a mis-ported locator reports GREEN.
test('zero sites: L1 reading none of its named docs FAILs, never passes quietly', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['gone-a.md', 'gone-b.md'], templateFiles: ['tpl'],
    keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /L1 read none of its 2 named doc surfaces/.test(m)), fails(r).join(' | '));
});

test('zero sites: a key table whose heading is gone FAILs (renamed heading is not "clean")', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], templateFiles: ['tpl'],
    keyTables: [{ file: 'README.md', heading: 'Configure' }],
    read: mk({ 'README.md': '## Settings\n\n| Key |\n|---|\n| `x` |\n', tpl: FULL_TEMPLATE }),
  });
  assert.ok(fails(r).some((m) => /found no heading "Configure"/.test(m)), fails(r).join(' | '));
});

test('zero sites: a template with no comment lines FAILs', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    templateFiles: ['tpl'],
    read: mk({ tpl: '{ "journal": {} }', 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /L3 found no comment lines/.test(m)), fails(r).join(' | '));
});

// BLIND_KEYS — the precondition and all four expiry paths, exercised although this room's own
// list is EMPTY. An empty list that was never run is an assumption.
test('BLIND_KEYS: an undeclared unreachable schema key is a hard FAIL, not a warning', () => {
  // A HYPHENATED leaf: `journal.history-limit` cannot match the dotted rule's leaf part, so no
  // locator can reach it. Realistic — kebab-case keys are ordinary in config files.
  const odd = { journal: { 'history-limit': {} } };
  const r = checkConfigKeys({
    schema: odd, mdFiles: [], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /cannot be detected by any locator/.test(m)), fails(r).join(' | '));
});

test('BLIND_KEYS: a declared unreachable key STOPS the fail and still DISCLOSES via SKIP', () => {
  const odd = { journal: { 'history-limit': {} } };
  const r = checkConfigKeys({
    schema: odd, mdFiles: [], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    blind: { 'journal.history-limit': 'declared for the test' },
    read: mk({ tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(!fails(r).some((m) => /cannot be detected/.test(m)), fails(r).join(' | '));
  assert.ok(skips(r).some((m) => /^blind to 1 DECLARED schema key/.test(m)), skips(r).join(' | '));
});

test('BLIND_KEYS expiry: a declaration whose key left the schema FAILs', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    blind: { 'gone.key': 'stale' },
    read: mk({ tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /BLIND_KEYS declares gone\.key, but it is not in the schema/.test(m)), fails(r).join(' | '));
});

test('BLIND_KEYS expiry: a declaration the rule CAN now see FAILs (the list cannot rot into a bypass)', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: [], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    blind: { 'update.updateMode': 'no longer true' },
    read: mk({ tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /declares update\.updateMode as unreachable, but a locator can now see it/.test(m)), fails(r).join(' | '));
});

// PENDING / NOT_CONFIG / RETIRED — rule 1 (no longer true) and rule 2 (protects nothing).
test('PENDING_KEYS suppresses the FAIL for an honestly-planned key', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    pending: { 'journal.rotateAfter': 'CWK-999 planned' },
    read: mk({ 'README.md': 'Planned: `journal.rotateAfter`.\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.deepEqual(fails(r), []);
});

test('rule 1: a PENDING entry that now resolves FAILs ("implemented, delete this")', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    pending: { 'update.updateMode': 'CWK-999' },
    read: mk({ 'README.md': '`update.updateMode`\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /PENDING_KEYS lists update\.updateMode, but it now resolves/.test(m)), fails(r).join(' | '));
});

test('rule 1: a NOT_CONFIG entry that became a real key FAILs ("the entry is a lie")', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    notConfig: { 'recovery.autoInjectPrompt': 'was never a key' },
    read: mk({ 'README.md': '`recovery.autoInjectPrompt`\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /NOT_CONFIG lists recovery\.autoInjectPrompt .* now resolves/.test(m)), fails(r).join(' | '));
});

test('rule 2: a declaration no scanned surface names FAILs as dead weight', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    notConfig: { neverMentioned: 'protects nothing' },
    read: mk({ 'README.md': 'nothing here\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /no scanned surface names neverMentioned/.test(m)), fails(r).join(' | '));
});

test('rule 2 is GATED on a complete scan: an unreadable surface degrades to SKIP, never a false conviction', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md', 'absent.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    notConfig: { neverMentioned: 'protects nothing' },
    read: mk({ 'README.md': 'nothing here\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(!fails(r).some((m) => /protects nothing/.test(m)), fails(r).join(' | '));
  assert.ok(skips(r).some((m) => /declaration-pruning not checked/.test(m)), skips(r).join(' | '));
});

test('RETIRED_KEYS: a retired key is reported BY NAME as a SKIP, never silently uncovered', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    retired: { 'journal.historyLimit': 'dropped at v0.1.0-beta.4' },
    read: mk({ 'README.md': 'Once `journal.historyLimit`.\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.deepEqual(fails(r), []);
  assert.ok(skips(r).some((m) => /retired key journal\.historyLimit is named in README\.md/.test(m)), skips(r).join(' | '));
});

test('coverage string reports every locator, so a silent locator is visible in the run output', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, mdFiles: ['README.md'], templateFiles: ['tpl'],
    keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ 'README.md': '`update.updateMode`\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.match(r.coverage, /L1 1 docs->1 · L2 1 rows->1 · L3 1 comment lines->1/);
});

test('MEDIUM-2: ONE unreadable hand-named surface FAILs — partial loss is not "clean"', () => {
  // The all-or-nothing version passed here: 1 of 2 docs readable, so L1 saw a file and stayed
  // quiet while a renamed surface left coverage forever behind a green line.
  const r = checkConfigKeys({
    schema: SCHEMA,
    mdFiles: ['README.md', 'SECURITY.md'],
    namedSurfaces: ['README.md', 'SECURITY.md'],
    templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ 'README.md': '`update.updateMode`\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(fails(r).some((m) => /1 hand-named surface\(s\) unreadable \(SECURITY\.md\)/.test(m)), fails(r).join(' | '));
});

test('MEDIUM-2: a readdir-derived surface that is absent does NOT fail (only hand-named ones can)', () => {
  const r = checkConfigKeys({
    schema: SCHEMA,
    mdFiles: ['README.md', 'commands/gone.md'],
    namedSurfaces: ['README.md'],
    templateFiles: ['tpl'], keyTables: [{ file: 'T.md', heading: 'Configure' }],
    read: mk({ 'README.md': '`update.updateMode`\n', tpl: FULL_TEMPLATE, 'T.md': FULL_TABLE }),
  });
  assert.ok(!fails(r).some((m) => /hand-named surface/.test(m)), fails(r).join(' | '));
  assert.ok(skips(r).some((m) => /declaration-pruning not checked/.test(m)), skips(r).join(' | '));
});
