// Run: node --test lib/state-snapshot-linear.test.js
// The task-file and constraint line matches stay linear on a long line of whitespace. Each one ended in `\s+(.+)$`, and `\s` and `.`
// overlap on whitespace (a line terminator such as U+2028 is whitespace to `\s` and not to `.`), so a failed match on such a line
// re-read the run for every place the `\s+` could end. The capture now starts at a non-space: `\s+(\S.*)$`.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildStateSnapshot } = require('./state-snapshot.js');

const MB = 1024 * 1024;
const BUDGET_MS = 1000; // per call, best of 3: the linear matches take milliseconds on 1 MB
const KILL_MS = 15000; // the quadratic matches run past this on 1 MB; the child is killed and the leg fails

// The three shapes, each about 1 MB of whitespace after the prefix its regex needs, with a line terminator the splitter keeps.
const SHAPES = {
  checklistSpacesThenLineSeparator: { file: 'task.md', text: '- [ ]' + ' '.repeat(MB) + ' ' },
  headingSpacesThenParagraphSeparator: { file: 'task.md', text: '# ' + ' '.repeat(MB) + ' ' },
  checklistTabsThenLoneCarriageReturn: { file: 'task.md', text: '- [x]' + '\t'.repeat(MB) + '\r' },
  constraintBulletSpacesThenLineSeparator: { file: 'AGENTS.md', text: '## Constraints\n- ' + ' '.repeat(MB) + ' ' },
};

// Each shape's files live in a folder of their own; the child times buildStateSnapshot on that folder three times.
function timeInChild(dir) {
  const code = `
    const { buildStateSnapshot } = require(process.argv[1]);
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      buildStateSnapshot(process.argv[2]);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    process.stdout.write(JSON.stringify(times));
  `;
  return spawnSync(process.execPath, ['-e', code, path.join(__dirname, 'state-snapshot.js'), dir], { encoding: 'utf8', timeout: KILL_MS });
}

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`${name}: a line of about 1 MB of whitespace is matched in under ${BUDGET_MS} ms per call (best of 3)`, (t) => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ss-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, shape.file), shape.text);
    const res = timeInChild(dir);
    assert.strictEqual(res.signal, null, `killed at ${KILL_MS} ms: the match ran past the kill timeout`);
    assert.strictEqual(res.status, 0, `the child exits 0, got ${res.status}: ${res.stderr}`);
    const best = Math.min(...JSON.parse(res.stdout));
    assert.ok(best < BUDGET_MS, `best of 3 = ${best.toFixed(1)} ms, budget ${BUDGET_MS} ms`);
  });
}

// The reference is the old parse, kept here with its old regexes, so the differential compares the product with what it did.
const OLD_CHECKLIST = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/;
const OLD_HEADING = /^#{1,2}\s+(.+)$/;
const OLD_BULLET = /^\s*[-*]\s+(.+)$/;
const OLD_CONSTRAINTS = /^##\s*(Constraints|Working Rules)(?=\s*(?:[^\w\s]|$)).*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im;

function oldTaskParse(text) {
  let goal = '';
  const checklist = [];
  const nextSteps = [];
  for (const line of text.split(/\r?\n/)) {
    const box = line.match(OLD_CHECKLIST);
    if (box) {
      const done = box[1].toLowerCase() === 'x';
      const task = box[2].trim();
      checklist.push({ task, status: done ? 'done' : 'todo' });
      if (!done) nextSteps.push(task);
      continue;
    }
    if (!goal) {
      const heading = line.match(OLD_HEADING);
      if (heading) goal = heading[1].trim();
    }
  }
  return { goal, checklist, nextSteps };
}

function oldConstraints(text) {
  const section = text.match(OLD_CONSTRAINTS);
  if (!section) return [];
  return section[2].split(/\r?\n/).map((l) => l.match(OLD_BULLET)).filter(Boolean).map((m) => m[1].trim());
}

// Ordinary lines, prefixes against bodies, plus whitespace-only and separator-bearing bodies.
const PREFIXES = ['- [ ] ', '- [x] ', '* [X] ', '  - [ ]  ', '# ', '## ', '- ', ''];
const BODIES = ['task one', 'a b   ', '   ', '\t', '', 'x y', 'tail\r', 'é 日本', 'Goal of the session'];

test('the new captures agree with the old ones on ordinary lines, and differ only where the old remainder was all whitespace', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-diff-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  for (const p of PREFIXES) for (const b of BODIES) lines.push(p + b);
  const text = lines.join('\n');
  fs.writeFileSync(path.join(dir, 'task.md'), text);
  const product = buildStateSnapshot(dir);
  const ref = oldTaskParse(text);

  const refChecklist = ref.checklist.filter((c) => c.task !== '');
  const dropped = ref.checklist.filter((c) => c.task === '');
  assert.deepStrictEqual(product.checklist, refChecklist, 'the checklist matches the old parse, less the empty tasks named below');
  assert.deepStrictEqual(product.activePlan.nextSteps, ref.nextSteps.filter((s) => s !== ''), 'the next steps match the old parse');
  assert.strictEqual(product.activePlan.goal, ref.goal, 'the goal matches the old parse');
  // Named: each dropped entry is a checklist line whose remainder after the box was whitespace only.
  for (const d of dropped) assert.strictEqual(d.task, '', 'only an all-whitespace remainder is dropped');
  t.diagnostic(`dropped ${dropped.length} empty-task checklist line(s) that the old parse matched as empty tasks`);

  const constraintLines = ['## Constraints', ...BODIES.map((b) => '- ' + b), '## Other', '- not a constraint'];
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), constraintLines.join('\n'));
  const product2 = buildStateSnapshot(dir);
  const refC = oldConstraints(constraintLines.join('\n')).filter((s) => s !== '');
  assert.deepStrictEqual(product2.activePlan.constraints, refC, 'the constraints match the old parse, less the empty ones');
});
