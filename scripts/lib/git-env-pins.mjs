// git-env-pins.mjs -- this room's own PINS for the canon git-spawn census (scripts/lib/git-env-census.mjs, adopted by blob id in 09a), the walk that feeds it, and the check that no pin
// has gone stale. The canon ships no pin of its own; a room passes its rows to scanGitSpawns(files, pins) (git-env-census.mjs, the pins paragraph). A row is { rel, blob, why } and matches
// only while the file's git blob id (line endings normalised) equals `blob`, so any edit to the file spends the pin and the census reads the file again. Nothing here edits the canon.
//
// WHAT IS PINNED, and why each is a carrier we cannot route through the room's gitEnv() (derived in 09a from the canon census's own output over this tree, never from the old rows):
//   - scripts/lib/git-env.test.mjs: the hazard proof feeds a deliberately poisoned GIT_DIR into a sandbox to reproduce the incident (CWK-133), so its env is `env || gitEnv(root)` on purpose.
//   - scripts/secret-gate.mjs (.github blob 856956a1): a byte-equal org carrier whose own gitEnv keeps GIT_INDEX_FILE (a commit is made from that index), a GIT_ name the rule does not accept.
//   - (scripts/secret-gate.test.mjs had a row at .github blob 71452210, a carrier whose own gitEnv named GIT_CONFIG_GLOBAL; the canon rewrote it to named keys at 2f066650 and the room
//     adopted that blob in 09a, so the canon census reads it with no row.)
//   - scripts/secret-scan.test.mjs (Bankfire source, blob d0db994d, D1): its own gitEnv strips the GIT_ family from a copy of the environment (a filter, which the census does not read) instead of
//     naming keys, and its 8.3 short-name probe runs the shell named by ComSpec on a generated script in its sandbox (not git, but a computed command the census cannot prove is not git).
//     The old per-spawn counts (five gitEnv() spawns, one command row) are gone with the old census: a pin hides the whole file, so the row is exactly as strong as the blob it names.
import fs from 'node:fs';
import path from 'node:path';
import { gitBlobId } from './git-env-census.mjs';

export const GIT_ENV_PINS = [
  { rel: 'scripts/lib/git-env.test.mjs', blob: '5504e5ccae309d33d7b45387f99e6ea347f04bb5', why: 'the hazard proof feeds a deliberately poisoned GIT_DIR into a sandbox to reproduce the incident' },
  { rel: 'scripts/secret-gate.mjs', blob: '856956a1cca6f716e5507f6c23ac90ed34cbbe5f', why: 'a byte-equal org carrier whose own gitEnv keeps GIT_INDEX_FILE, the index a commit is made from' },
  { rel: 'scripts/secret-scan.test.mjs', blob: 'd0db994df855ccd647f3ded878a6867bb198e196', why: 'the Bankfire scanner source: its own gitEnv filters the GIT_ family out of a copy of the environment, and a ComSpec probe runs a generated script in its sandbox' },
];

const CODE_EXT = /\.(mjs|cjs|js)$/;

// Every .mjs/.cjs/.js file under the given roots of a repository, tests included (the fixtures are where a bare git spawn lives), as { rel, text } with forward-slash names.
export function collectCensusFiles(repo, roots) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE_EXT.test(e.name)) files.push({ rel: path.relative(repo, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const root of roots) walk(path.join(repo, root));
  return files;
}

// A pin that matches no file of the walk (the file changed, moved or is gone) holds nothing out, and says so: a pin must not outlive the bytes it names.
export function stalePins(files, pins = GIT_ENV_PINS) {
  return pins
    .filter((p) => !files.some((f) => f.rel === p.rel && gitBlobId(f.text) === p.blob))
    .map((p) => `the census pin for ${p.rel} (blob ${p.blob.slice(0, 8)}) matches no file of the walk: the file changed or is gone, so the pin holds nothing out -- re-derive it from the census's own output on the new bytes, or drop it`);
}
