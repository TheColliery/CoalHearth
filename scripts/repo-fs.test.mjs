// CWK2-069: the leftover-temp and failed-write paths of writeRepoFile (scripts/lib/repo-fs.mjs), the class CoalMine 02dff20 repaired
// (a raw EEXIST on a leftover `<target>.<pid>.tmp`, a temp left when the write threw). This room's writeTempExclusive replaces the leftover
// instead of refusing it (CWK-137 R14); these legs pin the behaviour so a later edit cannot drop either cure silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRepoFile } from './lib/repo-fs.mjs';

function sandbox(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-repofs-')));
  assert.ok(base.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep), 'the sandbox must sit under the temp folder');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('CWK2-069 (a): a leftover <target>.<pid>.tmp is replaced, the write succeeds with no stack trace, and no temp is left', (t) => {
  const dir = sandbox(t);
  const target = path.join(dir, 'config.json');
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, 'leftover from an earlier holder of this pid');
  writeRepoFile(target, '{"language":"th-TH"}\n', dir);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"language":"th-TH"}\n');
  assert.equal(fs.existsSync(temp), false, 'the leftover temp must be consumed by the rename');
});

test('CWK2-069 (b): a write that throws after its temp exists rethrows the original error, keeps the old target, and leaves no temp', (t) => {
  const dir = sandbox(t);
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, 'old\n');
  t.mock.method(fs, 'renameSync', () => {
    const e = new Error('EIO: simulated rename failure');
    e.code = 'EIO';
    throw e;
  });
  assert.throws(() => writeRepoFile(target, 'new\n', dir), (e) => e.code === 'EIO');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n', 'the old target must survive a failed rename');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no <target>.*.tmp may be left behind');
});
