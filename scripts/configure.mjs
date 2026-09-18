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
import { CONFIG_SCHEMA, validateValue } from './lib/config-schema.mjs';
import { parseJsonc } from './lib/jsonc.mjs';
import { findProjectRoot, projectConfigPath, projectConfigCandidates, globalConfigPath } from './lib/config-load.mjs';

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
  // (loadMergedConfig's safer-value-wins clamp on updateMode/autoInjectPrompt).
  //
  // READ follows projectConfigPath's own rail (own-dir -> other known agent dirs ->
  // LEGACY root dotfile — see config-load.mjs's header for the full precedence).
  // WRITE goes back to wherever the config was found, EXCEPT a config found at the
  // LEGACY location migrates on THIS write to the own-dir-or-first-agent-dir default
  // (`projectConfigCandidates(...)[0]`) — never a bare `.claude`, so a project that
  // only uses `.agents`/`.gemini` does not get a foreign `.claude/` planted into it.
  // Move-on-CONFIG-WRITE-only (Phoenix #5): a hook never performs this move on a mere
  // read; configure.mjs is a CLI script the user/agent explicitly runs.
  const globalIdx = args.indexOf('--global');
  const isGlobal = globalIdx !== -1;
  if (isGlobal) args.splice(globalIdx, 1);
  const projectRoot = findProjectRoot(process.cwd());
  const legacyPath = path.join(projectRoot, '.coalhearth.json');
  const readPath = isGlobal ? globalConfigPath() : projectConfigPath(process.cwd());
  const writePath = isGlobal
    ? readPath
    : (readPath === legacyPath ? projectConfigCandidates(process.cwd())[0] : readPath);

  let cfg = {};
  let hadComments = false;
  // Read once via try/catch (no existsSync precheck) so there is no check-to-use gap.
  // BOM strip via charCodeAt, this room's own established shape (config-load.mjs's
  // readJsonc) -- never a typed regex/literal for U+FEFF (this room's own hard-won
  // lesson: a raw BOM character pasted into source gets silently converted to a real
  // char by the tool layer).
  let rawConfig = null;
  try {
    let content = fs.readFileSync(readPath, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    rawConfig = content;
  } catch {}
  if (rawConfig !== null) {
    try {
      hadComments = rawConfig.includes('//');
      const parsed = parseJsonc(rawConfig); // proto-pollution-guarded parse (jsonc.mjs)
      cfg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      // Fail loud (scripts-quality.md 1): a malformed config we silently overwrite is a
      // partial failure the user must notice -- flag the non-zero exit even though the
      // run continues from defaults (the old config is backed up where possible).
      process.exitCode = 1;
      try {
        fs.copyFileSync(readPath, readPath + '.bak');
        console.warn(`Warning: existing config is malformed — backed it up to ${readPath}.bak and rebuilding.`);
      } catch {
        console.warn('Warning: existing config is malformed. Overwriting.');
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
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    // Move-on-CONFIG-WRITE-only (no-old-version-leftover): the legacy root file is
    // removed only AFTER the new-home write above succeeded, and only when this write
    // actually migrated it. Best-effort -- a failed delete here still leaves a
    // correctly-written new config; the stray legacy file is simply not cleaned up
    // this run.
    if (readPath === legacyPath && writePath !== legacyPath) {
      try { fs.rmSync(legacyPath, { force: true }); } catch {}
      console.log(`Migrated the project config from ${legacyPath} to ${writePath}.`);
    }
    if (hadComments) {
      console.warn('Note: inline comments were stripped (this tool writes plain JSON). Every key stays documented in platform-configs/.coalhearth.json.');
    }
    console.log(`Successfully updated configuration in: ${writePath}`);
    console.log(JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error(`Error: Failed to write to config file: ${e.message}`);
    process.exitCode = 1;
    return;
  }
}

main();
