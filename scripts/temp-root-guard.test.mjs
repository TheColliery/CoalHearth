// The guard: no test under lib/, bin/ or scripts/ hands the shared temp folder to ResumeEngine or HandoffJournal as its root.
// The fixtures below are split across string joins, so this file never contains the flagged shape itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBareTmpdirEngines } from './lib/temp-root-guard.mjs';

const room = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The test files the guard reads: lib/*.test.js, bin/*.test.js and every scripts/**/*.test.mjs.
function testFiles() {
  const out = [];
  for (const dir of ['lib', 'bin']) {
    for (const f of fs.readdirSync(path.join(room, dir))) if (f.endsWith('.test.js')) out.push(path.join(dir, f));
  }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.mjs')) out.push(path.relative(room, p));
    }
  };
  walk(path.join(room, 'scripts'));
  return out;
}

test('no test hands the shared temp folder to an engine as its root', () => {
  const files = testFiles();
  assert.ok(files.length > 10, `the guard reads the test files (read ${files.length})`);
  const hits = [];
  for (const rel of files) {
    for (const h of findBareTmpdirEngines(fs.readFileSync(path.join(room, rel), 'utf8'))) hits.push(`${rel}: ${h}`);
  }
  assert.deepStrictEqual(hits, []);
});

test('the guard flags the shape that littered the temp folder, for both engines', () => {
  const resume = 'const engine = new ResumeEngine({}, {}, ' + 'os.tmpdir());';
  const journal = 'const journal = new HandoffJournal({ outputDirectory: dir }, ' + 'os.tmpdir());';
  assert.equal(findBareTmpdirEngines(resume).length, 1);
  assert.equal(findBareTmpdirEngines(journal).length, 1);
});

test('the guard lets an engine root of the test\'s own, or a subfolder of the temp folder, pass', () => {
  const own = 'const engine = new ResumeEngine({}, {}, root);';
  const sub = 'const engine = new ResumeEngine({}, {}, path.join(os.tmpdir(), "sub"));';
  assert.equal(findBareTmpdirEngines(own).length, 0);
  assert.equal(findBareTmpdirEngines(sub).length, 0);
});
