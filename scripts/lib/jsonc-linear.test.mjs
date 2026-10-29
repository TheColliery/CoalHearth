// Config parsing stays linear on malformed input: the comment stripper reads a config in one pass,
// and an opener that never closes is kept as written, so the file still fails JSON.parse as before.
// Two copies of the strip exist (scripts/lib/jsonc.mjs for ESM, lib/load-config.js for the shipped CJS
// bundle); the guard below keeps both on the same line so they cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './jsonc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The strip as it stood before this change, kept as the reference for the differential test.
const OLD_RE = /"(?:\\.|[^"\\])*"|\/\/.*|\/\*[\s\S]*?\*\//g;
const oldStrip = (c) => c.replace(OLD_RE, (m) => (m[0] === '"' ? m : ''));

// The one strip line both copies must carry, byte for byte (ported from CoalMine v3.23.7).
const STRIP_LINE = String.raw`  return content.replace(/"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|\/\/.*|\/\*[\s\S]*?(\*\/|$)/g, (m, close) => (m[0] === '"' || (m[1] === '*' && close !== '*/') ? m : ''));`;

const SIZE = 48 * 1024;
// None of these shapes closes: the block openers never meet a star-slash, and the escaped quotes never meet an unescaped one.
const SHAPES = {
  unclosedBlockOpeners: '/* a'.repeat(SIZE / 4),
  unclosedStringEscapes: '"' + '\\"'.repeat(SIZE / 3),
  // A string opener whose body ends in a lone backslash: the string branch fails there and restarts two characters on.
  danglingBackslash: '"\\'.repeat(SIZE / 2),
};
const BUDGET_MS = 50;

test('config parsing stays linear: 48 KB of unclosed openers strips in under 50 ms (best of 3 runs)', () => {
  for (const [name, input] of Object.entries(SHAPES)) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      stripJsonc(input);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.ok(Math.min(...times) < BUDGET_MS, `${name}: best of 3 = ${Math.min(...times).toFixed(1)} ms, budget ${BUDGET_MS} ms`);
  }
});

test('an unclosed opener is kept as written, so a malformed config still fails to parse', () => {
  for (const [name, input] of Object.entries(SHAPES)) {
    assert.equal(stripJsonc(input), input, `${name}: the unclosed text is emitted unchanged`);
  }
  assert.throws(() => JSON.parse(stripJsonc('{"a":1} /* never closed')));
  assert.throws(() => JSON.parse(stripJsonc('{"a":"never closed')));
});

test('well-formed JSON with comments strips exactly as the previous strip did', () => {
  const fixtures = [
    '',
    '{}',
    '{"url":"http://example.com","mode":"auto"}',
    '{"p":"C:\\\\","x":"a//b"}',
    '{"q":"he said \\"hi\\""}',
    '{\n  "a": "keep", // line comment with "quotes" inside\n  "b": "x" /* block */\n}',
    '{"s":"/* not a comment */","t":"// not either"} // trailing',
    '{"a":1 /**/ , "b":2 /* a */ /* b */}',
    '{"a":"x\\\\"} /* after an escaped-backslash value */',
    '/* header */ {"k": [1, 2, 3]} // footer */',
    '{"w":"a/*b","v":"c*/d"}',
  ];
  for (const f of fixtures) {
    assert.equal(stripJsonc(f), oldStrip(f), `differs on ${JSON.stringify(f)}`);
  }
});

test('both strip copies carry the one pinned line, so the bundle and the module cannot drift', () => {
  const copies = ['scripts/lib/jsonc.mjs', 'lib/load-config.js'];
  for (const rel of copies) {
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    const lines = text.split(/\r?\n/);
    assert.ok(lines.includes(STRIP_LINE), `${rel} does not carry the pinned strip line`);
  }
});
