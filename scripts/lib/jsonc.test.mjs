import test from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc } from './jsonc.mjs';

test('strips // line comments', () => {
  assert.equal(stripJsonc('{ "a": 1 // comment\n}'), '{ "a": 1 \n}');
});

test('strips /* */ block comments', () => {
  assert.equal(stripJsonc('{ /* c */ "a": 1 }'), '{  "a": 1 }');
});

test('never mangles a string containing // or /* */', () => {
  const src = '{ "a": "https://example.com/* not a comment */" }';
  assert.equal(JSON.parse(stripJsonc(src)).a, 'https://example.com/* not a comment */');
});

test('a value ending in a literal backslash does not leak escape state', () => {
  const src = '{ "path": "C:\\\\" , "b": "//still a string" }';
  const parsed = JSON.parse(stripJsonc(src));
  assert.equal(parsed.path, 'C:\\');
  assert.equal(parsed.b, '//still a string');
});
