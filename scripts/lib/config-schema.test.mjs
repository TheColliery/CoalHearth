import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_SCHEMA, validateValue, validateConfig } from './config-schema.mjs';

test('validateValue accepts a valid int within bounds', () => {
  assert.equal(validateValue(CONFIG_SCHEMA.budgets.maxTokens, 2000000), null);
});

test('validateValue rejects a non-integer for an int spec', () => {
  assert.match(validateValue(CONFIG_SCHEMA.budgets.maxTokens, 1.5), /integer/);
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
    budgets: { maxTokens: 2000000, warningTokenPercentage: 0.15 },
    journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 3 },
    recovery: { autoInjectPrompt: true, stashUnsavedChanges: true },
  });
  assert.deepEqual(errors, []);
});

test('validateConfig flags an unknown group', () => {
  const errors = validateConfig({ bogus: { x: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /group 'bogus' not in schema/);
});

test('validateConfig flags an unknown key within a known group', () => {
  const errors = validateConfig({ budgets: { notAKey: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'budgets.notAKey' not in schema/);
});
