// Run: node --test lib/resume-engine.test.js
// A transcript path that is not a local absolute path is never stat'ed. The path is read from the journal, a file a cloned
// repository can supply, and on Windows a network path would make the stat reach another machine. A refused path is treated
// as not known gone (no GC note), and the path still shows in the fenced snapshot.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeEngine } = require('./resume-engine.js');

const NOT_LOCAL = [
  '\\\\host\\share\\t.jsonl',
  '//host/share/t.jsonl',
  '\\\\?\\UNC\\host\\share\\t.jsonl',
  '\\\\.\\pipe\\x',
  't.jsonl',
];

// Replaces fs.statSync for the test and restores it in t.after. A path that is not local is answered with EACCES and never
// reaches the real stat, so the test itself can never touch a network share. A local absolute path is passed to the real call.
function recordStats(t) {
  const real = fs.statSync;
  const seen = [];
  fs.statSync = function (p, ...rest) {
    seen.push(String(p));
    const local = typeof p === 'string' && path.isAbsolute(p) && !/^[\\/]{2}/.test(p);
    if (!local) {
      const e = new Error('stubbed: not a local path');
      e.code = 'EACCES';
      throw e;
    }
    return real.call(fs, p, ...rest);
  };
  t.after(() => { fs.statSync = real; });
  return seen;
}

// Each test gets its own temp root: the engine builds its output folder (and its self-ignore file) under the root it is given,
// so a root shared with the rest of the machine's temp folder would be left littered by the run.
function ownTempRoot(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-re-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a transcript path on a network share, or a relative one, is never opened', (t) => {
  const seen = recordStats(t);
  const engine = new ResumeEngine({}, {}, ownTempRoot(t));
  for (const p of NOT_LOCAL) {
    seen.length = 0;
    const out = engine.generateHandoffPrompt({ transcriptPath: p });
    assert.equal(seen.length, 0, `stat was called for ${JSON.stringify(p)}`);
    assert.ok(!out.includes('garbage-collected'), `a refused path ${JSON.stringify(p)} must not read as GC'd`);
    assert.ok(out.includes(p), `the refused path ${JSON.stringify(p)} still shows in the snapshot`);
  }
});

test('a local absolute path that does not exist still yields the GC note', (t) => {
  recordStats(t);
  const root = ownTempRoot(t);
  const engine = new ResumeEngine({}, {}, root);
  const gone = path.join(root, 'coalhearth-gc-probe-' + process.pid + '-' + Date.now() + '.jsonl');
  const out = engine.generateHandoffPrompt({ transcriptPath: gone });
  assert.ok(out.includes('garbage-collected'), 'a local absolute path with no file behind it is noted as GC\'d');
});
