// Single source of truth for every .coalhearth.json key. Mirrors CoalTipple's
// scripts/lib/config-schema.mjs pattern (series parity), adapted for CoalHearth's
// 4 nested groups (budgets/journal/recovery/update) instead of a flat key list — the
// factory config + config/schema.json (draft-07) both derive from this file.
//
// Spec fields per group-key:
//   type   'bool' | 'int' | 'number' | 'string' | 'enum'
//   min/max bounds for 'int'/'number'
//   values allowed values for 'enum' (compared case-insensitively)
//   help   one-line description

export const CONFIG_SCHEMA = {
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
export function validateConfig(cfg) {
  const errors = [];
  for (const [group, value] of Object.entries(cfg)) {
    const groupSpec = CONFIG_SCHEMA[group];
    if (!groupSpec) { errors.push(`group '${group}' not in schema`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`group '${group}' must be an object`); continue; }
    for (const [key, v] of Object.entries(value)) {
      const spec = groupSpec[key];
      if (!spec) { errors.push(`'${group}.${key}' not in schema`); continue; }
      const err = validateValue(spec, v);
      if (err) errors.push(`'${group}.${key}' ${err}`);
    }
  }
  return errors;
}
