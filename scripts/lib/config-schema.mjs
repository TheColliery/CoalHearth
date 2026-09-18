// Single source of truth for every .coalhearth.json key. Mirrors CoalTipple's
// scripts/lib/config-schema.mjs pattern (series parity), adapted for CoalHearth's
// nested groups (journal/recovery/update — budgets tombstoned, see below) instead of a
// flat key list, plus one top-level SCALAR (`language`, AL-2) — the factory config +
// config/schema.json (draft-07) both derive from this file.
//
// Spec fields per group-key:
//   type   'bool' | 'int' | 'number' | 'string' | 'enum'
//   min/max bounds for 'int'/'number'
//   values allowed values for 'enum' (compared case-insensitively)
//   help   one-line description
//
// AL-2 (owner-signed): `language` is a TOP-LEVEL SCALAR, not a group — the ONE entry in
// this object that carries its own `.type` field directly rather than holding sub-key
// specs. Reason (head-ruled): the user-visible key name must read the same in every
// room ("language": "auto") — nesting it under a group here would spell it
// `ui.language` in CoalHearth and `language` everywhere else, and our nesting is an
// internal shape, not a user-facing one. Every consumer of this object (validateConfig
// below, scripts/lib/config-keys.mjs's container/leaf derivation, engine.test.mjs's
// group count) branches on `.type` presence to tell a scalar entry from a group.

export const CONFIG_SCHEMA = {
  // 5 Standard Systems #2 (AGENTS.md): factory AUTO follows the conversation's
  // language, EN fallback, no extra work — this key exists to LOCK it. A lock
  // translates PROSE only; commands/paths/identifiers/config keys/severity labels
  // stay VERBATIM. Shape ported verbatim from the flock exemplar, CoalMine's
  // scripts/lib/config-schema.mjs:17 (`type: 'enum'`, the same six values) — no
  // `flags` field, because this room ships no CLI/configure.mjs to read one (CWK-065).
  language: { type: 'enum', values: ['auto', 'th', 'en', 'ja', 'zh', 'es'], help: 'Lock the reply language (auto, th, en, ja, zh, es). Translates prose only — commands, paths, identifiers and config keys stay verbatim. Default auto' },
  // TOMBSTONED — the entire `budgets` group (`maxTokens`, `warningTokenPercentage`) is
  // removed together with the advisory budget guardrail, joining the earlier beta.6
  // `maxTurns`/`warningTurnThreshold` tombstone (the IDENTICAL flaw): a FRESH BudgetTracker
  // per PostToolUse (Phoenix #6, stateless) never accumulated, so shouldBlockSpawning needed
  // a single >6.8 MB payload to fire at the 2M default — structurally unreachable. The
  // recovery core is the value; the guardrail was a false promise, removed rather than faked
  // (see CHANGELOG). Do NOT re-add a budget group without BOTH a session-persistence design
  // AND an honest source of real token usage — the hook sees only payload char-slices (a
  // gauge, not a safety device). (Same tombstone-by-removal pattern as CT's rankingMode/hardEnforce.)
  journal: {
    outputDirectory: { type: 'string', help: 'Where session_handoff.json is written (realpath-contained under the workspace root; an escaping path falls back to the default). Default .claude/coalhearth' },
    atomicityRetries: { type: 'int', min: 1, max: 5, help: 'Retries for the atomic tmp-then-rename journal write (clamped 1-5 — save() busy-waits synchronously on the hot-path). Default 3' },
  },
  recovery: {
    autoInjectPrompt: { type: 'bool', help: 'Prepend the generated recovery block to the next session prompt. Default true' },
    stashUnsavedChanges: { type: 'bool', help: 'Advise stashing unsaved changes on a detected aborted session. Default true' },
  },
  // Self-update (series-standard kind-1): the SessionStart HOOK only SCHEDULES via a
  // throttled stamp; the AGENT verifies + offers (/coalhearth:update). Orthogonal to
  // the journal/resume behavior — its own off-switch.
  update: {
    updateMode: { type: 'enum', values: ['ask', 'auto', 'remind', 'off'], help: 'Self-update behavior at session start (ask, auto, remind, off). The hook never networks — the agent verifies + offers, consent-gated. Default ask' },
    updateCheckDays: { type: 'int', min: 1, max: 365, help: 'Days between self-update checks/reminders (range 1-365; the hook CLAMPS an out-of-range value to the default on read). Default 14' },
  },
};

// Validate an already-parsed JSON value against a spec entry.
// Returns an error message fragment ("must be ...") or null when valid.
export function validateValue(spec, v) {
  switch (spec.type) {
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be a boolean';
    case 'int':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number';
      if (!Number.isInteger(v)) return 'must be an integer';
      if (spec.min != null && v < spec.min) return `must be >= ${spec.min}`;
      if (spec.max != null && v > spec.max) return `must be <= ${spec.max}`;
      return null;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number';
      if (spec.min != null && v < spec.min) return `must be >= ${spec.min}`;
      if (spec.max != null && v > spec.max) return `must be <= ${spec.max}`;
      return null;
    case 'string':
      return typeof v === 'string' ? null : 'must be a string';
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v.toLowerCase())
        ? null
        : `must be one of: ${spec.values.join(', ')}`;
    default:
      return `has an unknown spec type '${spec.type}'`;
  }
}

// Validate a full parsed config object (only the known groups/keys; unknown
// top-level groups or unknown keys within a known group are reported, never thrown).
// AL-2: a top-level entry carrying its OWN `.type` field (e.g. `language`) is a
// SCALAR leaf, validated directly against the cfg value — never descended into as if
// it held sub-keys (`.type`/`.values`/`.help` are the spec's own fields, not config).
export function validateConfig(cfg) {
  const errors = [];
  for (const [name, value] of Object.entries(cfg)) {
    const spec = CONFIG_SCHEMA[name];
    // r29 findings-back LOW 4: an UNRECOGNIZED top-level entry is not known to be a group
    // at all — that is exactly what "not in schema" means — so calling it one here would
    // be a guess this branch has no basis for (a scalar like `{verbosity:'loud'}` is
    // equally plausible). "group" is correct ONLY past this point, once `spec` resolves
    // and is confirmed to carry no `.type` of its own.
    if (!spec) { errors.push(`key '${name}' not in schema`); continue; }
    if (spec.type) {
      const err = validateValue(spec, value);
      if (err) errors.push(`'${name}' ${err}`);
      continue;
    }
    const groupSpec = spec;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`group '${name}' must be an object`); continue; }
    for (const [key, v] of Object.entries(value)) {
      const keySpec = groupSpec[key];
      if (!keySpec) { errors.push(`'${name}.${key}' not in schema`); continue; }
      const err = validateValue(keySpec, v);
      if (err) errors.push(`'${name}.${key}' ${err}`);
    }
  }
  return errors;
}
