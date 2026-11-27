// CoalHearth configurator — edit .coalhearth.json from the command line.
// Flags, parsing, and validation all come from ONE schema (scripts/lib/config-schema.mjs,
// shared with verify.mjs): a key added there is automatically settable and validated here.
//
// Ported (CWK-023, owner-signed ใบ D — configure.mjs is now a flock standard: config
// must be CLI-settable, not merely documented). Two exemplars read before writing:
// CoalMine's original (scripts/configure.mjs) and CoalLedger's adopter port (94e994f) —
// same SHAPE, not a re-derivation from description. Every deviation from BOTH is named
// here with its reason, per CoalLedger's own header discipline; a deviation with no
// stated reason is drift, not a port.
//
//   - NOT A GATE (node/runtime.md 1's own scope carve-out, restated so this file's
//     top-level imports read as correct rather than as a missed rule): this is a plain
//     CLI entry with no enumerate-and-report contract, so ordinary top-level
//     `import ... from './lib/x.mjs'` is the right shape — no dynamic-import wrapping.
//   - `process.exitCode`, NEVER `process.exit()` — CoalMine's own file already does
//     this correctly; CoalLedger's own adopter port REGRESSED to `process.exit()` at
//     four sites (help, unrecognized flag, parse-continuation is not one of them, write
//     failure). This room swept that exact class out of scripts/ at CWK-071 (r30/r31);
//     re-introducing it here would undo that sweep in the one new file this unit adds.
//     So `main()` uses `return` after setting `exitCode`, never CoalLedger's shape.
//   - THE CENTRAL ADAPTATION, OURS ALONE: neither exemplar's CONFIG_SCHEMA is nested.
//     Ours is three groups (`journal`/`recovery`/`update`) plus one top-level SCALAR
//     (`language`, AL-2) — a spec entry is a scalar iff it carries its OWN `.type`
//     field, exactly the discriminator `validateConfig`, the config-key gate's
//     container/leaf derivation, and `engine.test.mjs`'s group count already use.
//     `buildFlagSpecs()` below walks the schema once into a FLAT list so the rest of
//     this file (help, parsing, flag lookup) reads exactly like both exemplars' flat-
//     schema code, at the cost of one extra function neither of them needed.
//   - FLAG NAMING (head's ruling): every flag is the DOTTED key verbatim —
//     `--journal.outputDirectory`, `--recovery.autoInjectPrompt`, bare `--language` for
//     the one scalar. Every doc, the README key table, and the config-key gate's own L1
//     locator already name these keys in dotted form; a flat `--outputDirectory` would
//     be a SECOND user-visible spelling of one key — the exact drift the config-key
//     gate exists to catch.
//   - ROOT WALK + CONFIG PATHS from OUR OWN `./lib/config-load.mjs`
//     (`findProjectRoot`, `projectConfigPath`, `projectConfigCandidates`,
//     `globalConfigPath`) — never a local copy (CoalMine's own file keeps a local
//     `findGitRoot` only because its hook side is CJS and cannot import this ESM lib;
//     this is an ESM script importing an ESM lib, so duplicating it would be a second
//     source of truth for the SAME walk, not a real constraint). No `ownDirDefault`
//     export exists in this room's loader — `projectConfigCandidates(...)[0]` already
//     IS the own-dir-or-first-agent-dir default (the candidate order's own first
//     entry), so nothing needed adding to the loader to get it.
//   - `ownDir` PASSED AS UNDEFINED, and this is a genuinely NEW question neither
//     exemplar's single-platform room had to answer: CoalHearth's read-order can be
//     anchored to "the running agent's own dir" (`.claude`/`.agents`/`.gemini`), but
//     `configure.mjs` is invoked directly by a human or an agent via a plain shell
//     command — there is no hook payload naming which agent is running it. Omitting
//     `ownDir` falls back to the loader's own `.claude`-first order, which is the
//     correct default for a tool with no caller-identity signal to read.
//   - PARSE VIA OUR OWN `parseJsonc` (jsonc.mjs), not a raw `stripJsonc`+`JSON.parse`:
//     ours carries a proto-pollution guard (`__proto__`/`constructor`/`prototype`
//     dropped at parse) that neither exemplar's own `jsonc.mjs` had at the time they
//     were written — using the weaker path here would be a live regression relative to
//     every OTHER read of this room's own untrusted config file class.
//   - NO LEGACY-KEY MIGRATION BLOCK, same absence as CoalLedger's own file and for the
//     same reason, checked at OUR source rather than assumed: CoalHearth has never
//     RENAMED a schema key. Every schema removal in this room's history (the beta.6
//     `maxTurns`/`warningTurnThreshold` tombstone, the v2.0.0 `budgets` group tombstone)
//     deleted the key OUTRIGHT with no replacement — `validateConfig` already reports
//     an old key as "not in schema" on its own, which is the correct outcome for a
//     retired key, not a migration target. Porting CoalMine's dead migration branches
//     (`conductor` -> `enableConductor` etc, names that never existed here) would be
//     migrating keys this room never had.
//   - `--string`-TYPE PARSING, a case NEITHER exemplar's `parseValue` needed: neither
//     CoalMine's nor CoalLedger's own schema exposes a plain unconstrained `'string'`
//     type via this CLI (their `parseValue` switches have no `'string'` case at all,
//     matching their own schemas' type space). Ours does — `journal.outputDirectory`
//     — so `parseValue` below adds the one case their files never had reason to write.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { CONFIG_SCHEMA, validateValue } from './lib/config-schema.mjs';
import { parseJsonc } from './lib/jsonc.mjs';
import { findProjectRoot, projectConfigPath, projectConfigCandidates, globalConfigPath } from './lib/config-load.mjs';
import { MAX_CONFIG_BYTES, readRepoBytesWithIdentity, writeRepoFile, RepoWriteRefused, ReadOnlyRefused, refuseIfReadOnly } from './lib/repo-fs.mjs';
import { gitEnv } from './lib/git-env.mjs';

// R19 (CodeRabbit PR #19 thread 14): does git TRACK `file`? 'tracked' | 'untracked' | 'unknown'. The legacy migration removes the old config only
// when it is untracked or there is nothing to ask: a tracked root `.coalhearth.json` is often a team-shared, committed file, and deleting it here
// would remove it for the whole team at the next `git commit -a`. NO-EXTERNAL-ASSUMPTION: git is optional. No git binary (ENOENT) or no
// repository means there is nothing to protect, so the answer is 'untracked' and the behaviour is exactly what it was before this check. Git exits 128
// for EVERY fatal error, not only "not a git repository": a repository it refuses to read (dubious ownership, a corrupt .git) also answers 128 for a file it
// tracks. So 128 reads as "no repository" only when no `.git` entry exists above the project at all (decided with fs, never by matching git's localised
// stderr); with one present it is 'unknown'. Any OTHER failure (a timeout, a signal, an unexpected status) is 'unknown' too, which KEEPS the file: the safe side. The spawn takes
// `env: gitEnv(...)` (the room's census, CWK-133: a hook's absolute GIT_DIR must never steer it), an explicit timeout (coding-style Error
// Handling 6) and no shell. NO ceiling is passed: the project root is not always the repository root (a config file is itself a root marker, so a
// project directory inside a bigger repository is normal), and a repository ABOVE the project that tracks the file must be allowed to say so.
// Is there a `.git` entry (a directory, or a worktree's file) in `dir` or any parent? The marker findProjectRoot uses, walked to the filesystem root the way git walks.
function gitEntryAbove(dir) {
  for (let d = path.resolve(dir); ; ) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}
// BB-533: is a path there, by lstat (a link counts, a dangling link counts). 'present' | 'absent' | 'unchecked'. Never throws.
function presence(p) {
  try {
    fs.lstatSync(p);
    return 'present';
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'absent' : 'unchecked';
  }
}
// The global config is the user's own home file, and a link to it is followed on purpose. An existing target resolves by realpath.
// A dangling link, or an absent file, resolves to where the write lands today: the link's own target, or the path itself.
function resolveGlobalTarget(p) {
  try { return fs.realpathSync.native(p); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  let cur = p;
  for (let hops = 0; hops < 40; hops++) {
    let st;
    try { st = fs.lstatSync(cur); } catch { return cur; } // nothing at cur: the write creates it here
    if (!st.isSymbolicLink()) return cur;
    cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
  }
  throw new Error(`too many links to resolve ${p}`);
}
// The mode of the file a rename is about to replace, or null when there is none yet. The replacement takes these bits (writeRepoFile).
function existingMode(p) {
  try { return fs.statSync(p).mode & 0o7777; } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
// BB-533: the legacy file is MOVED aside, never deleted. The rename is the one destroying call: nothing is checked before it and
// removed after it. It runs after the new home is written and reads the backup back, bounded, against the bytes read before the BOM
// strip. Every failure says what it knows and sets the exit code; a rename that fails is never retried.
function moveLegacyAside(readPath, writePath, projectRoot, snapshot, tracking, earlierBak) {
  const bak = readPath + '.bak';
  const bakNote = earlierBak ? 'replaced an earlier backup' : 'no earlier backup';
  // r29ni N: the legacy file's write bit is read by name BEFORE the rename. A rename keeps the file's mode, so a read-only legacy file stays
  // read-only under its backup name, and the success line says so. A failed lstat says nothing here: the rename below decides.
  let readOnlyLegacy = false;
  try { readOnlyLegacy = (fs.lstatSync(readPath).mode & 0o222) === 0; } catch { /* the rename decides */ }
  try {
    fs.renameSync(readPath, bak);
  } catch (e) {
    const code = (e && e.code) || 'error';
    process.exitCode = 1;
    // A failed rename does not prove the source is there: say "kept" only when an lstat finds it.
    const now = presence(readPath);
    if (now === 'present') console.error(`Error: could not move ${readPath} aside (${code}). It is kept, untouched by this run; the new config at ${writePath} does not include any change made to it. Nothing was retried: release whatever holds it and run this again.`);
    else if (now === 'absent') console.error(`Error: could not move ${readPath} aside (${code}), and it is no longer there. What it held after it was read is not known; check ${bak} and the new config at ${writePath} by hand.`);
    else console.error(`Error: could not move ${readPath} aside (${code}), and it could not be checked whether it is still there. Nothing was retried; check ${readPath} by hand.`);
    return;
  }
  // Read back what now sits at the backup name. A writer that holds the file open and writes after this read is not seen (a stated limit).
  const back = readRepoBytesWithIdentity(bak, projectRoot, MAX_CONFIG_BYTES);
  if (back.bytes === null) {
    process.exitCode = 1;
    console.error(`Error: ${readPath} was moved to ${bak}, but the backup could not be read back (${back.why}), so the check that it holds what was read could not be done (${bakNote}). Check it by hand.`);
  } else if (Buffer.compare(back.bytes, snapshot) !== 0) {
    process.exitCode = 1;
    console.error(`Warning: ${bak} differs from ${readPath} as it was read before the move (${bakNote}). It holds a change the new config at ${writePath} does not include: merge that change by hand. ${bak} is yours to keep or delete.`);
  } else {
    const keptAs = readOnlyLegacy ? `kept as ${bak}, read-only as it was` : `kept as ${bak}`; // r29ni N: a writable file's line is unchanged
    console.log(`Migrated the project config to ${writePath}; the old file is ${keptAs} (${bakNote}).`);
  }
  const rel = path.relative(projectRoot, readPath).split(path.sep).join('/');
  if (tracking === 'tracked') console.log(`${rel} is tracked by git: commit its removal (git add -A -- ${rel}). ${bak} is untracked and yours to keep or delete.`);
  else if (tracking === 'unknown') console.log(`git could not be asked whether ${rel} is tracked; it was moved aside anyway. If git tracks it, commit its removal (git add -A -- ${rel}).`);
}
function gitTracks(file, projectRoot) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: projectRoot, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'], env: gitEnv(),
  });
  if (r.error) return r.error.code === 'ENOENT' ? 'untracked' : 'unknown'; // no git binary: nothing to ask; a timeout or other spawn error: keep
  if (r.status === 0) return 'tracked';
  if (r.status === 1) return 'untracked'; // in a repository, not tracked
  if (r.status === 128) return gitEntryAbove(projectRoot) ? 'unknown' : 'untracked'; // 128: a repository git refuses (keep), or no repository at all (nothing to protect)
  return 'unknown';
}

// FLATTEN THE NESTED SCHEMA ONCE. Each entry: `flagKey` (the dotted CLI name, or the
// bare scalar name), `groupKey` (the top-level group this leaf lives under, or `null`
// for the `language` scalar), `leafKey` (the key WITHIN the group, or the same as
// `flagKey` for a scalar), and `spec` (the leaf's own type/help/bounds — the exact
// object `validateValue` already knows how to read, unchanged by nesting).
function buildFlagSpecs() {
  const specs = [];
  for (const [topKey, topSpec] of Object.entries(CONFIG_SCHEMA)) {
    if (topSpec.type) {
      // A SCALAR entry (AL-2's `language`) carries its own `.type` directly.
      specs.push({ flagKey: topKey, groupKey: null, leafKey: topKey, spec: topSpec });
      continue;
    }
    for (const [leafKey, leafSpec] of Object.entries(topSpec)) {
      specs.push({ flagKey: `${topKey}.${leafKey}`, groupKey: topKey, leafKey, spec: leafSpec });
    }
  }
  return specs;
}
const FLAG_SPECS = buildFlagSpecs();
// Keys only the GLOBAL layer may set (the loaders ignore a project value for them): refused for a project write, see main().
const GLOBAL_ONLY_FLAGS = ['journal.outputDirectory'];

function printHelp() {
  const lines = [
    'CoalHearth Configurator Utility',
    'Usage: node scripts/configure.mjs [options]',
    '',
    'Options:',
  ];
  for (const { flagKey, spec } of FLAG_SPECS) {
    lines.push(`  ${('--' + flagKey).padEnd(40)} ${spec.help}`);
  }
  lines.push(`  ${'--global'.padEnd(40)} Write ~/.claude/.coalhearth.json (the global layer) instead of the project config`);
  lines.push(`  ${'--help, -h'.padEnd(40)} Show this help message`);
  lines.push('');
  lines.push('Examples:');
  lines.push('  node scripts/configure.mjs --language th');
  lines.push('  node scripts/configure.mjs --journal.outputDirectory .claude/coalhearth');
  lines.push('  node scripts/configure.mjs --global --update.updateMode auto');
  console.log(lines.join('\n'));
}

// Parse one raw CLI value against a leaf spec. Returns { value } or { error }.
function parseValue(flagKey, spec, raw) {
  switch (spec.type) {
    case 'bool': {
      if (raw !== 'true' && raw !== 'false') return { error: `${flagKey} needs true or false` };
      return { value: raw === 'true' };
    }
    case 'int':
    case 'number': {
      // Number() (not parseInt) so a float like "5.9" or a garbage tail like "50abc" is
      // rejected outright rather than silently truncated. validateValue then enforces
      // the int-vs-number + min/max contract — the SAME check verify.mjs runs on the
      // JSON value, so the CLI parser and the JSON validator cannot drift apart.
      const n = Number(raw);
      const err = validateValue(spec, n);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: n };
    }
    case 'enum': {
      const v = (raw || '').toLowerCase();
      const err = validateValue(spec, v);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: v };
    }
    case 'string': {
      // No CoalHearth schema key constrains a string's SHAPE (no pattern/length bound
      // in validateValue's 'string' case) -- this exists so a raw CLI arg still goes
      // through the same validator the JSON path uses, never a second, un-validated
      // acceptance path.
      const err = validateValue(spec, raw);
      if (err) return { error: `${flagKey} ${err}` };
      return { value: raw };
    }
    default:
      return { error: `internal: unknown spec type '${spec.type}'` };
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  // --global targets the global layer (globalConfigPath -- honors CLAUDE_CONFIG_DIR);
  // default targets the project config. Hooks merge the two per key, project wins
  // (loadMergedConfig's safer-value-wins clamp on updateMode/autoInjectPrompt; journal.outputDirectory is
  // the one key the project layer cannot set at all, below).
  //
  // READ follows projectConfigPath's own rail (own-dir -> other known agent dirs ->
  // LEGACY nested .claude/.coalhearth.json -> LEGACY root dotfile — see config-load.mjs's
  // header for the full precedence).
  // WRITE goes back to wherever the config was found, EXCEPT a config found at EITHER
  // LEGACY location (UMB-133 added the nested one) migrates on THIS write to the
  // own-dir-or-first-agent-dir default
  // (`projectConfigCandidates(...)[0]`) — never a bare `.claude`, so a project that
  // only uses `.agents`/`.gemini` does not get a foreign `.claude/` planted into it.
  // Move-on-CONFIG-WRITE-only (Phoenix #5): a hook never performs this move on a mere
  // read; configure.mjs is a CLI script the user/agent explicitly runs.
  const globalIdx = args.indexOf('--global');
  const isGlobal = globalIdx !== -1;
  if (isGlobal) args.splice(globalIdx, 1);
  // 08a (owner BB-49 (1), UMB-456): journal.outputDirectory is GLOBAL-ONLY -- the loader ignores a project value (hooks-safety.md section 9), so writing one would leave a value
  // that does nothing. Refused here, before the config is read or anything is backed up or written, so the whole invocation writes nothing.
  const projectOnlyRefused = GLOBAL_ONLY_FLAGS.find((k) => !isGlobal && args.includes('--' + k));
  if (projectOnlyRefused) {
    process.exitCode = 1;
    console.error(`Error: --${projectOnlyRefused} can only be set in the GLOBAL config: a project config's value is ignored (a cloned repo must not choose where the hooks write). Run it with --global to write the global config. Nothing was written.`);
    return;
  }
  const projectRoot = findProjectRoot(process.cwd());
  const legacyPaths = [path.join(projectRoot, '.claude', '.coalhearth.json'), path.join(projectRoot, '.coalhearth.json')];
  const readPath = isGlobal ? globalConfigPath() : projectConfigPath(process.cwd());
  const readIsLegacy = !isGlobal && legacyPaths.includes(readPath);
  const writePath = isGlobal
    ? readPath
    : (readIsLegacy ? projectConfigCandidates(process.cwd())[0] : readPath);

  let cfg = {};
  let hadComments = false;
  let malformedLegacy = null; // why the legacy file is malformed: it is moved aside after the new config is written, not copied here (BB-533 bounce F-a)
  // An earlier backup is looked for before this run writes anything, so a backup this run makes is never counted as earlier.
  const earlierBak = readIsLegacy && presence(readPath + '.bak') === 'present';
  // Read once via try/catch (no existsSync precheck) so there is no check-to-use gap.
  // BOM strip via charCodeAt, this room's own established shape (config-load.mjs's
  // readJsonc) -- never a typed regex/literal for U+FEFF (this room's own hard-won
  // lesson: a raw BOM character pasted into source gets silently converted to a real
  // char by the tool layer).
  // CWK-137 (R14): the read is bounded and, for the PROJECT config, contained. This is a WRITER, so anything that is
  // present but cannot be read safely (an over-bound file, a FIFO or device, a link out of the project, a denied
  // read) is a loud refusal -- never "absent", which would overwrite the one copy of a file the user wrote. The
  // global layer keeps following links (a dotfile manager's symlink is legitimate there) but is still bounded.
  const readRoot = isGlobal ? null : projectRoot;
  const got = readRepoBytesWithIdentity(readPath, readRoot, MAX_CONFIG_BYTES);
  let rawConfig = null;
  let rawBytes = null;
  if (got.bytes !== null) {
    rawBytes = got.bytes;
    let content = got.bytes.toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    rawConfig = content;
  } else if (got.why !== 'absent' && got.why !== 'dir') {
    process.exitCode = 1;
    console.error(`Error: the existing config ${readPath} cannot be read safely (${got.why}) \u2014 nothing was written and it is untouched. Remove or fix it (a file over ${MAX_CONFIG_BYTES} bytes, a link to a file outside the project or in another folder, a linked folder above it, a special file or a permission problem), then run this again.`);
    return;
  }
  // r29mq F3 (the reviewer's bounce): every target the run would write is checked before the FIRST write of the run. The config itself is written
  // on every run, so a read-only config refuses HERE, before the malformed branch can write its .bak and before any temp exists. A valid read-only
  // config refuses the same way it always did, only earlier. The backup's own check stays where the backup is written (writeRepoFile).
  // r29sm: the global target is resolved here, once, and the check runs on it, the same path the write and the backup use. A link
  // followed to a read-only file refuses before any .bak is written beside the link. A link that cannot be resolved refuses too, by name.
  let globalTarget = null;
  try {
    if (isGlobal) globalTarget = resolveGlobalTarget(writePath);
    refuseIfReadOnly(globalTarget !== null ? globalTarget : writePath);
  } catch (e) {
    if (!(e instanceof ReadOnlyRefused)) {
      process.exitCode = 1;
      console.error(`Error: Failed to write to config file: ${e.message}`);
      return;
    }
    console.error(`FAIL ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (rawConfig !== null) {
    let notObject = false;
    try {
      hadComments = rawConfig.includes('//');
      const parsed = parseJsonc(rawConfig); // proto-pollution-guarded parse (jsonc.mjs)
      // CWK-120 ride-along (a): valid JSON that is not a plain object ([], "str", 42, null, true) is NEVER
      // accepted as the config -- and this is a WRITER: the old `... ? parsed : {}` fallback treated it as
      // an empty config and OVERWROTE the file with no backup and no notice. It takes the malformed
      // recovery below instead (back up, rebuild from defaults, exit 1), with an accurate message.
      if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) { notObject = true; throw new Error('not a JSON object'); }
      cfg = parsed;
    } catch (e) {
      // Fail loud (scripts-quality.md 1): a malformed config we silently overwrite is a
      // partial failure the user must notice -- flag the non-zero exit even though the
      // run continues from defaults.
      process.exitCode = 1;
      const why = notObject ? 'is valid JSON but not a JSON object' : 'is malformed';
      if (readIsLegacy) {
        // BB-533 (bounce F-a): a legacy file is not copied to a .bak here. The migration below moves it aside (these bytes included), so the
        // backup holds them, and an earlier backup is replaced by that one rename. The warning is printed just before that move.
        malformedLegacy = why;
      } else {
      try {
        writeRepoFile(readPath + '.bak', rawBytes, readRoot); // the bytes already read: never copyFileSync, which follows a link planted at the .bak
        console.warn(`Warning: existing config ${why} \u2014 backed it up to ${readPath}.bak and rebuilding.`);
      } catch (bakErr) {
        // r29mq Z: a read-only backup is refused by name, and nothing was written (the config itself is not written past this point).
        if (bakErr instanceof ReadOnlyRefused) { console.error(`FAIL ${bakErr.message}`); return; }
        // R8 FIXBACK L4 (head's ruling): NEVER write when the backup did not land -- the original is the only copy of a
        // file the user wrote. Refuse: nothing written, the original stays byte-exact, exit 1, and the message says what
        // happened and what to do next (Standard System 4). Keyed on the errno CODE, never its message (node/runtime.md 7).
        console.error(`Error: existing config ${why}, and it could not be backed up to ${readPath}.bak (${(bakErr && bakErr.code) || 'error'}) \u2014 nothing was written and ${readPath} is untouched. Remove or rename ${readPath}.bak (it may be a directory), or free the space/permission it needs, then run again.`);
        return;
      }
      }
    }
  }

  // Flag lookup: the dotted key (or bare `language`) is the ONLY spelling recognised —
  // no per-leaf aliases (neither exemplar's own `spec.flags` mechanism is used by any
  // leaf in this schema today).
  const flagMap = new Map();
  for (const flagSpec of FLAG_SPECS) flagMap.set(`--${flagSpec.flagKey}`, flagSpec);

  for (let i = 0; i < args.length; i++) {
    const entry = flagMap.get(args[i]);
    if (!entry) {
      console.error(`Error: Unrecognized option '${args[i]}'`);
      printHelp();
      process.exitCode = 1;
      return;
    }
    const parsed = parseValue(entry.flagKey, entry.spec, args[++i]);
    if (parsed.error) {
      console.error(`Error: ${parsed.error}`);
      process.exitCode = 1;
      return;
    }
    if (entry.groupKey === null) {
      // The `language` scalar (AL-2) -- lands as a top-level value, NEVER wrapped in an
      // object, however it was shaped before this write (a malformed prior value, an
      // object, anything) -- a plain assignment replaces it cleanly.
      cfg[entry.leafKey] = parsed.value;
    } else {
      // NEST WITHOUT CLOBBERING SIBLINGS: spread whatever is ALREADY at cfg[groupKey]
      // (including any earlier flag in THIS SAME invocation targeting the same group)
      // only when it is a genuine object; a missing or wrong-shaped prior value starts
      // fresh rather than propagating garbage forward.
      const existing = cfg[entry.groupKey];
      const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      cfg[entry.groupKey] = { ...base, [entry.leafKey]: parsed.value };
    }
  }

  try {
    const out = JSON.stringify(cfg, null, 2) + '\n';
    // r29mq Z: every target is checked BEFORE the first write. A read-only earlier backup refuses the run here, so the new home is not written
    // first and the move at the end is never left to fail after it (the BB-533 order, with the 0444 refusal).
    if (readIsLegacy && writePath !== readPath) refuseIfReadOnly(readPath + '.bak');
    if (isGlobal) {
      // The user's own home config: a link to it (a dotfile manager's) is followed on purpose, so the write goes to the RESOLVED target,
      // as a temp renamed over it. writeRepoFile checks that target for read-only before the folder or the temp exists. No root is
      // passed, so there is no containment check: the global file is the user's own, wherever its link points.
      writeRepoFile(globalTarget, out, null, existingMode(globalTarget)); // the replacement keeps the mode of the file it replaces (r29sm)
    } else {
      writeRepoFile(writePath, out, projectRoot); // CWK-137: realpath-and-contain, then a temp replaced into place
    }
    // BB-533: the legacy file is moved aside once the new home is written. The git probe runs before the move and only chooses the
    // extra line. A null snapshot means the legacy path gave no bytes to compare with, so nothing is moved.
    if (readIsLegacy && writePath !== readPath) {
      if (rawBytes === null) {
        process.exitCode = 1;
        console.error(`Error: ${readPath} gave no bytes to check, so nothing was moved. The new config at ${writePath} is written; check ${readPath} by hand.`);
      } else {
        const tracking = gitTracks(readPath, projectRoot);
        // The earlier-backup check was taken before this run wrote anything (stated limit: a backup another process creates in the window is not seen).
        if (malformedLegacy !== null) console.warn(`Warning: existing config ${malformedLegacy} — the new config is built from defaults, and the old file is kept as ${readPath}.bak.`);
        moveLegacyAside(readPath, writePath, projectRoot, rawBytes, tracking, earlierBak);
      }
    }
    if (hadComments) {
      console.warn('Note: inline comments were stripped (this tool writes plain JSON). Every key stays documented in platform-configs/.coalhearth.json.');
    }
    console.log(`Successfully updated configuration in: ${writePath}`);
    console.log(JSON.stringify(cfg, null, 2));
  } catch (e) {
    if (e instanceof ReadOnlyRefused) {
      console.error(`FAIL ${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(e instanceof RepoWriteRefused
      ? `Error: refused to write the config \u2014 ${e.message}. Nothing was written. Remove the link (or run from the real project) and run this again.`
      : `Error: Failed to write to config file: ${e.message}`);
    process.exitCode = 1;
    return;
  }
}

main();
