// Single source of truth for every .coalhearth.json key. Mirrors CoalTipple's
// scripts/lib/config-schema.mjs pattern (series parity), adapted for CoalHearth's
// 3 nested groups (budgets/journal/recovery) instead of a flat key list — the
// factory config + config/schema.json (draft-07) both derive from this file.
//
// Spec fields per group-key:
//   type   'bool' | 'int' | 'number' | 'string'
//   min/max bounds for 'int'/'number'
//   help   one-line description

export const CONFIG_SCHEMA = {
  budgets: {
    maxTurns: { type: 'int', min: 1, help: 'Turns before the session is considered budget-exhausted (advisory). Default 30' },
    maxTokens: { type: 'int', min: 1, help: 'Token ceiling for the char-heuristic budget estimate (advisory, not precise). Default 2000000' },
    warningTurnThreshold: { type: 'int', min: 0, help: 'Turns remaining that trigger a warning nudge. Default 5' },
    warningTokenPercentage: { type: 'number', min: 0, max: 1, help: 'Fraction of maxTokens remaining that triggers a warning nudge. Default 0.15' },
  },
  journal: {
    outputDirectory: { type: 'string', help: 'Where session_handoff.json is written. Default .claude/coalhearth' },
    historyLimit: { type: 'int', min: 0, help: 'How many prior handoff logs to retain before pruning. Default 5' },
    atomicityRetries: { type: 'int', min: 0, help: 'Retries for the atomic tmp-then-rename journal write. Default 3' },
  },
  recovery: {
    autoInjectPrompt: { type: 'bool', help: 'Prepend the generated recovery block to the next session prompt. Default true' },
    stashUnsavedChanges: { type: 'bool', help: 'Advise stashing unsaved changes on a detected aborted session. Default true' },
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
