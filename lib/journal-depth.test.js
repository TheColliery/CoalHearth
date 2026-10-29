// Run: node --test lib/journal-depth.test.js
// A journal nested past the depth the hook writes is refused at every read, exactly as an unparseable journal is, and a journal
// this hook writes still reads and round-trips unchanged. The resume mark is written compact: re-rendering a deep journal with
// two-space indentation grows with its depth, and nothing needs the pretty form once the mark is written.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HandoffJournal, JOURNAL_NAME } = require('./handoff-journal');
const { ResumeEngine } = require('./resume-engine');

const DEEP = 2000; // far past any depth the hook writes (its own journals reach 3)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-depth-'));
}

// A journal whose one field is DEEP arrays nested in each other. Written compact, because that is how a repository could supply it.
function deepJournal() {
  let v = [];
  for (let i = 0; i < DEEP; i++) v = [v];
  return { status: 'in_progress', checklist: [], modifiedFiles: [], deep: v };
}

// Depth of a parsed value, counted the way the bound counts it: a container is 1 plus its deepest child. Iterative, for the test.
function depthOf(value) {
  let max = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    const here = d + 1;
    if (here > max) max = here;
    for (const k of Array.isArray(v) ? v : Object.values(v)) stack.push([k, here]);
  }
  return max;
}

// What the hook's own state looks like: a checklist, modified files, an in-flight subagent record and a plan with constraints.
function realisticState() {
  return {
    sessionId: 'session-depth-test',
    status: 'in_progress',
    checklist: [{ task: 'first step', status: 'done' }, { task: 'second step', status: 'todo' }],
    modifiedFiles: ['lib/a.js', 'lib/b.js'],
    inFlightAgents: [{ description: 'walk a folder', subagentType: 'general', outputPath: 'out.json', spawnedAt: '2026-10-29T00:00:00Z' }],
    activePlan: { goal: 'ship the fix', nextSteps: ['test', 'commit'], constraints: ['never push', 'keep the dist in step'] },
  };
}

test('a journal nested past the bound is refused by the handoff reader, as an unparseable one is', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  fs.writeFileSync(path.join(dir, JOURNAL_NAME), JSON.stringify(deepJournal()));
  assert.strictEqual(journal.load(), null, 'a too-deep journal is read as no journal');
});

test('a journal nested past the bound is quarantined by the recovery reader, as an unparseable one is', () => {
  const dir = tmpDir();
  const engine = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  fs.writeFileSync(path.join(dir, JOURNAL_NAME), JSON.stringify(deepJournal()));
  assert.strictEqual(engine.detectAbortedSession(), null, 'a too-deep journal yields no resume block');
  const left = fs.readdirSync(dir).filter((n) => /corrupt/.test(n));
  assert.ok(left.length >= 1, 'the too-deep journal is set aside as corrupt, the same as an unparseable one');
});

test('a journal this hook writes still reads and round-trips unchanged', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const state = realisticState();
  assert.strictEqual(journal.save(state), true);
  const back = journal.load();
  for (const k of Object.keys(state)) assert.deepStrictEqual(back[k], state[k], `field ${k} survives the round trip`);
  assert.ok(depthOf(back) <= 8, 'a journal the hook writes sits well inside the bound');
});

test('the resume mark is written compact and parses to the same value as the state it marks', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const state = realisticState();
  journal.save(state);
  const engine = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  assert.strictEqual(engine.markResumed(state), true);
  const raw = fs.readFileSync(path.join(dir, JOURNAL_NAME), 'utf8');
  assert.ok(!raw.includes('\n'), 'the mark is one line, with no indentation');
  assert.deepStrictEqual(JSON.parse(raw), { ...state, status: 'resumed' });
});
