// CWK-133 -- unit tests for gitEnv() itself, plus a reproduction of the incident it exists to
// prevent. Shape ported from CoalFace 0a614ae (the four unit properties) and CoalTipple's
// git-env.test.mjs (the incident reproduction), re-derived for this room's variables:
// the REDIRECT is universal, the core.bare FLIP is platform-conditional (CoalTipple f0b95b9:
// only a native-backslash GIT_DIR under Git for Windows flips it), so the redirect and
// containment legs run everywhere and the flip leg is PROBED and skips visibly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitEnv } from './git-env.mjs';

// Restores process.env exactly (keys added AND keys changed) after a test that plants ambient state.
function withEnv(planted, fn) {
  const saved = {};
  for (const k of Object.keys(planted)) saved[k] = process.env[k];
  try {
    Object.assign(process.env, planted);
    return fn();
  } finally {
    for (const k of Object.keys(planted)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('gitEnv: strips every GIT_-prefixed key, whatever the name', () => {
  withEnv({
    GIT_DIR: '/somewhere/.git',
    GIT_INDEX_FILE: '/somewhere/.git/index',
    GIT_WORK_TREE: '/somewhere',
    GIT_SOME_FUTURE_KEY_NOBODY_HAS_WRITTEN_YET: 'x',
  }, () => {
    const env = gitEnv('/ceiling');
    for (const key of Object.keys(env)) {
      assert.ok(!/^git_/i.test(key) || key === 'GIT_CEILING_DIRECTORIES',
        `${key} is a GIT_* key that survived the strip`);
    }
  });
});

test('gitEnv: a lowercase git_ key is stripped too (a Windows environment is case-insensitive)', () => {
  withEnv({ git_dir: '/somewhere/.git' }, () => {
    const env = gitEnv('/ceiling');
    assert.equal(Object.keys(env).some((k) => k.toLowerCase() === 'git_dir'), false);
  });
});

test('gitEnv: sets GIT_CEILING_DIRECTORIES to the given ceiling', () => {
  assert.equal(gitEnv('/tmp/some-parent').GIT_CEILING_DIRECTORIES, '/tmp/some-parent');
});

test('gitEnv: with NO ceiling given an ambient GIT_CEILING_DIRECTORIES survives; with none ambient there is none', () => {
  withEnv({ GIT_CEILING_DIRECTORIES: '/ambient' }, () => {
    assert.equal(gitEnv().GIT_CEILING_DIRECTORIES, '/ambient');
  });
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  try {
    delete process.env.GIT_CEILING_DIRECTORIES;
    assert.equal('GIT_CEILING_DIRECTORIES' in gitEnv(), false);
  } finally {
    if (saved !== undefined) process.env.GIT_CEILING_DIRECTORIES = saved;
  }
});

test('gitEnv: an ambient GIT_CEILING_DIRECTORIES is replaced, not appended to', () => {
  withEnv({ GIT_CEILING_DIRECTORIES: '/ambient' }, () => {
    assert.equal(gitEnv('/ours').GIT_CEILING_DIRECTORIES, '/ours');
  });
});

test('gitEnv: non-GIT_ keys pass through unchanged (a plain copy, not a wipe)', () => {
  withEnv({ COALHEARTH_GITENV_TEST_PROBE: 'kept' }, () => {
    assert.equal(gitEnv('/ceiling').COALHEARTH_GITENV_TEST_PROBE, 'kept');
  });
});

test('gitEnv: mutating the returned object never touches process.env (a real copy)', () => {
  withEnv({ GIT_DIR: '/ambient/.git' }, () => {
    const env = gitEnv('/ceiling');
    env.GIT_DIR = '/poisoned';
    env.PATH = 'x';
    assert.equal(process.env.GIT_DIR, '/ambient/.git');
    assert.notEqual(process.env.PATH, 'x');
  });
});

// The incident against a THROWAWAY sandbox "enclosing repo" -- never the real one. poisonedRepo
// plays the part a linked worktree's hook plays in production (something upstream already exported
// an absolute GIT_DIR naming it); fixtureDir is the empty directory a test then tries to `git init`.
// EVERY spawn here, setup and check included, goes through gitEnv(), so this file is itself safe
// to run from a hook that already exports a poisoned GIT_DIR.
function mkIncident(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-gitenv-incident-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const poisonedRepo = path.join(root, 'poisoned-repo');
  const fixtureDir = path.join(root, 'fixture-target');
  fs.mkdirSync(poisonedRepo, { recursive: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const git = (cwd, args, env) => spawnSync('git', args, { cwd, encoding: 'utf8', env: env || gitEnv(root) });
  const init = git(poisonedRepo, ['init', '-q', '.']);
  assert.equal(init.status, 0, `setup: poisonedRepo must init cleanly -- ${init.stderr}`);
  const bareOf = () => git(poisonedRepo, ['config', '--get', 'core.bare']).stdout.trim();
  assert.equal(bareOf(), 'false', 'setup: an ordinary git init starts non-bare');
  // gitEnv() plus the ONE planted GIT_DIR -- never a raw process.env spread, so an ambient GIT_*
  // leftover cannot compound with the deliberate poison.
  const poisonedEnv = { ...gitEnv(root), GIT_DIR: path.join(poisonedRepo, '.git') };
  return { root, poisonedRepo, fixtureDir, poisonedEnv, bareOf, git };
}

test('incident: an unguarded git init under an ambient absolute GIT_DIR is REDIRECTED away from its own directory (every platform)', (t) => {
  const { fixtureDir, poisonedEnv, git } = mkIncident(t);
  const badInit = git(fixtureDir, ['init', '-q', '.'], poisonedEnv);
  assert.equal(badInit.status, 0, `the poisoned init must itself succeed for this to be the real hazard -- ${badInit.stderr}`);
  assert.equal(fs.existsSync(path.join(fixtureDir, '.git')), false, 'the poisoned run never created the FIXTURE its caller asked for');
});

test('incident: the CoalFace signature -- a poisoned git init flips the unrelated repo to bare -- reproduces where this git/platform does it', (t) => {
  const { fixtureDir, poisonedEnv, bareOf, git } = mkIncident(t);
  git(fixtureDir, ['init', '-q', '.'], poisonedEnv);
  const bareAfterPoison = bareOf();
  if (bareAfterPoison !== 'true') {
    const ver = git(fixtureDir, ['--version']).stdout.trim();
    t.skip(`the bare-flip does not occur on ${process.platform} with ${ver} (GIT_DIR=${poisonedEnv.GIT_DIR}); it needs a native-backslash GIT_DIR under Git for Windows -- the redirect and containment legs still run`);
    return;
  }
  assert.equal(bareAfterPoison, 'true', 'confirms the incident: the unrelated repo was silently flipped to bare');
});

test('incident: with gitEnv() applied the SAME ambient poisoning is contained -- the fixture gets its .git, the other repo is untouched (every platform)', (t) => {
  const { poisonedRepo, fixtureDir, bareOf, git } = mkIncident(t);
  const configBefore = fs.readFileSync(path.join(poisonedRepo, '.git', 'config'));
  withEnv({ GIT_DIR: path.join(poisonedRepo, '.git') }, () => {
    const guarded = gitEnv(path.dirname(fixtureDir));
    assert.equal(guarded.GIT_DIR, undefined, 'gitEnv() must have stripped the planted GIT_DIR before this assertion even runs');
    const goodInit = git(fixtureDir, ['init', '-q', '.'], guarded);
    assert.equal(goodInit.status, 0, `the guarded init must succeed -- ${goodInit.stderr}`);
    assert.equal(fs.existsSync(path.join(fixtureDir, '.git')), true, 'the guarded run creates the FIXTURE its caller actually asked for');
    assert.equal(bareOf(), 'false', 'the poisoned repo is left non-bare');
    assert.ok(configBefore.equals(fs.readFileSync(path.join(poisonedRepo, '.git', 'config'))), 'the poisoned repo config is byte-unchanged');
  });
});
