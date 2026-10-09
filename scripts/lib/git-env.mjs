// CWK-133 -- the ONE place this room builds an environment for a `git` child.
//
// THE HAZARD: inside a LINKED worktree a git hook exports an ABSOLUTE `GIT_DIR` (and
// `GIT_INDEX_FILE`). Both OVERRIDE `cwd` and `GIT_CEILING_DIRECTORIES`, so a fixture's
// `git init` / `git config` / `git commit`, or a gate's own `git ls-files`, lands on the REAL
// enclosing repository instead of the sandbox it was aimed at (CoalFace measured core.bare=true
// on its own repo for ~2 minutes, 2026-09-23). The gate (scripts/verify.mjs) runs under
// .githooks/pre-commit, so it is in exactly that position.
//
// THE CLASS FIX: delete every key matching ^GIT_ from a COPY of the environment -- the whole
// family, never a hand list, so a git that grows a new GIT_* variable is covered the day it
// ships -- then set GIT_CEILING_DIRECTORIES so a fixture that fails to find its own .git can
// never climb into a parent repository.
//
// The ceiling is OPTIONAL. A caller that knows its own repo root (the gate) or its own sandbox
// (a fixture) passes the PARENT of it. A caller that does not (link-check.mjs runs from whatever
// directory the user is in, possibly a subdirectory of a repo) passes nothing, and then an
// ambient GIT_CEILING_DIRECTORIES the user set for their own reasons survives -- a ceiling never
// redirects git, so it is the guard and not the hazard.
//
// Zero-dep, node builtins only, never mutates process.env. Named `gitEnv` to match CoalTipple's
// `git-env.mjs` (same body); this room ALSO uses it for read-only gate spawns, which is why it
// lives in scripts/lib/ next to the gate and not beside a test.
export function gitEnv(ceilingDir) {
  const ambientCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^git_/i.test(key)) delete env[key]; // case-insensitive: a Windows env is, and git reads it that way
  }
  const ceiling = ceilingDir !== undefined ? ceilingDir : ambientCeiling;
  if (ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = ceiling;
  return env;
}
