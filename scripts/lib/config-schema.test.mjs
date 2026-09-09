import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_SCHEMA, validateValue, validateConfig } from './config-schema.mjs';

test('validateValue accepts a valid int within bounds', () => {
  assert.equal(validateValue(CONFIG_SCHEMA.update.updateCheckDays, 14), null);
});

test('validateValue rejects a non-integer for an int spec', () => {
  assert.match(validateValue(CONFIG_SCHEMA.update.updateCheckDays, 1.5), /integer/);
});

test('validateValue rejects below min', () => {
  assert.match(validateValue(CONFIG_SCHEMA.journal.atomicityRetries, 0), />=/);
});

test('validateValue rejects atomicityRetries above the clamp max', () => {
  assert.match(validateValue(CONFIG_SCHEMA.journal.atomicityRetries, 50), /<=/);
});

test('validateValue accepts a bool', () => {
  assert.equal(validateValue(CONFIG_SCHEMA.recovery.autoInjectPrompt, true), null);
});

test('validateValue rejects a non-bool for a bool spec', () => {
  assert.match(validateValue(CONFIG_SCHEMA.recovery.autoInjectPrompt, 'yes'), /boolean/);
});

test('validateConfig passes on the full factory shape', () => {
  const errors = validateConfig({
    language: 'auto',
    journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 3 },
    recovery: { autoInjectPrompt: true, stashUnsavedChanges: true },
    update: { updateMode: 'ask', updateCheckDays: 14 },
  });
  assert.deepEqual(errors, []);
});

// AL-2: `language` is a top-level SCALAR entry (carries its own `.type`), not a group of
// sub-keys — validateConfig must validate it directly, never descend into it as if `.type`/
// `.values`/`.help` were its config keys.
test('validateValue accepts every language enum value, case-insensitively', () => {
  for (const v of ['auto', 'th', 'en', 'ja', 'zh', 'es', 'TH', 'En']) {
    assert.equal(validateValue(CONFIG_SCHEMA.language, v), null, v);
  }
});

test('validateValue rejects a language value outside the closed six', () => {
  assert.match(validateValue(CONFIG_SCHEMA.language, 'fr'), /must be one of/);
});

test('validateConfig validates the language SCALAR directly, not as a group', () => {
  assert.deepEqual(validateConfig({ language: 'th' }), []);
  assert.deepEqual(validateConfig({ language: 'fr' }), ["'language' must be one of: auto, th, en, ja, zh, es"]);
});

test('validateConfig rejects an object given for the language scalar (never silently descended into)', () => {
  const errors = validateConfig({ language: { auto: true } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^'language' must be one of/);
});

test('CONFIG_SCHEMA.language is a top-level scalar, distinguishable from a group by its own .type', () => {
  assert.equal(CONFIG_SCHEMA.language.type, 'enum');
  assert.deepEqual(CONFIG_SCHEMA.language.values, ['auto', 'th', 'en', 'ja', 'zh', 'es']);
  // A GROUP (journal/recovery/update) carries no `.type` of its own — only its leaves do.
  assert.equal(CONFIG_SCHEMA.journal.type, undefined);
});

// r29 findings-back LOW 4: validateConfig called an unknown top-level entry a "group",
// which was never known — an unrecognized entry could equally be an intended SCALAR
// (this exact fixture) as a group. RED-PROOF: reverting the message back to
// `` `group '${name}' not in schema` `` makes this fail on the word "key".
test('validateConfig never calls an unrecognized top-level entry a "group" -- it does not know that', () => {
  const errors = validateConfig({ verbosity: 'loud' });
  assert.deepEqual(errors, ["key 'verbosity' not in schema"]);
});

test('validateConfig flags an unknown group', () => {
  const errors = validateConfig({ bogus: { x: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /key 'bogus' not in schema/);
});

test('validateConfig flags an unknown key within a known group', () => {
  const errors = validateConfig({ journal: { notAKey: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'journal.notAKey' not in schema/);
});
