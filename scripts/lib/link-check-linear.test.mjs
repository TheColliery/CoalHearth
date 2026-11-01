// Link extraction is linear on every input shape, and a test proves it by counting work, never by reading a clock.
// extractLinks is a single-pass scanner with an optional counter ({ steps }, one step per character visit). This file holds:
//   1. the work witness: its step count stays under C * text length and at most doubles when the text doubles, on the shapes
//      that used to be quadratic and on shapes aimed at the scanner's own stop sets;
//   2. that witness goes red on a deliberately quadratic stand-in (a copy of the scanner whose label or target does not stop at
//      a bracket, the two reads the previous pattern had), and on the previous pattern itself, so it can fail;
//   3. an ordinary-link check of the forms the scanner reads.
// Ported from CoalMine's scripts/lib/link-check-linear.test.mjs (3.23.9). The repository .md walk and the differential leg are dropped.
// Zero-dep (node:test + built-ins), scripts-quality.md section 2; testing.md Determinism: no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, stripCode } from './link-check.mjs';

// The pattern extractCitations ran before the scanner: a label run from every '[' to the next ']' or newline. Its work is
// modelled as that run's characters (the regex engine exposes no counter), so the model is the witness's stand-in for the old shape.
const PREVIOUS_LINK_RE = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const previousShape = (text, counter) => {
  const n = text.length;
  let steps = 0;
  for (let p = 0; p < n; p++) {
    steps++;
    if (text[p] !== '[') continue;
    let j = p + 1;
    while (j < n && text[j] !== ']' && text[j] !== '\n') { steps++; j++; }
  }
  if (counter) counter.steps += steps;
  return [];
};

// C is the most character visits per input character the witness accepts. The scanner visits a character once to find a start,
// once in a label, target or title run, so it measures at most 2 per character; 6 leaves room and still fails a quadratic
// scan at these sizes. SLACK covers a fixed handful of steps at both sizes.
const C = 6;
const SLACK = 64;
const SIZES = [4096, 8192];

function work(extract, text) {
  const counter = { steps: 0 };
  extract(text, counter);
  return { steps: counter.steps, length: text.length };
}

// Returns '' when the extractor is linear on the shape at both sizes, else the first thing that is not.
function witness(extract, name, build) {
  const small = work(extract, build(SIZES[0]));
  const large = work(extract, build(SIZES[1]));
  if (small.steps < 1 || large.steps < 1) return `${name}: no steps counted (${small.steps}, ${large.steps}): the extractor does not count its work`;
  if (small.steps > C * small.length) return `${name}: ${small.steps} steps for ${small.length} characters, over ${C} per character`;
  if (large.steps > C * large.length) return `${name}: ${large.steps} steps for ${large.length} characters, over ${C} per character`;
  if (large.steps > 2 * small.steps + SLACK) return `${name}: ${small.steps} steps became ${large.steps} when the text went from ${small.length} to ${large.length} characters`;
  return '';
}

const SHAPES = {
  'the unclosed "[" run': (n) => '['.repeat(n),
  'the "[](" run, with no ")" anywhere': (n) => '[]('.repeat(n),
  'the "[a](" run, with no ")" anywhere': (n) => '[a]('.repeat(n),
  'nested brackets that never close': (n) => '[[a]('.repeat(n),
  'many closed links': (n) => '[a](b) '.repeat(n),
  'a title that never closes': (n) => '[](a "' + 'x'.repeat(4 * n),
  'a white space run after a target that does not close': (n) => '[](a' + ' '.repeat(4 * n) + 'x',
  'a title that closes without ")" after every start': (n) => '[](a "t"x'.repeat(n),
  'a single-quoted title that never closes': (n) => "[](a '" + 'x'.repeat(4 * n),
  'an angle-bracket destination that never closes': (n) => '[](<' + 'x'.repeat(4 * n),
};

test('extractLinks work is linear in the text: steps stay under C per character and at most double when the text doubles', () => {
  for (const [name, build] of Object.entries(SHAPES)) {
    assert.equal(witness(extractLinks, name, build), '', name);
  }
});

// Quadratic stand-ins: a copy of the scanner whose label, or whose target, does not stop at a bracket. Each start then rescans
// to the end of the text, the way the two reads of the previous pattern did. A witness red here is the proof the witness can fail.
function standIn({ labelStopsAtBracket, targetStopsAtBracket }) {
  return (text, counter) => {
    const s = stripCode(text);
    const n = s.length;
    let steps = 0;
    for (let p = 0; p < n; p++) { // every opening bracket starts a fresh read, the way the previous pattern did
      steps++;
      if (s[p] !== '[') continue;
      let j = p + 1;
      while (j < n && (labelStopsAtBracket ? s[j] !== '[' && s[j] !== ']' : s[j] !== ']')) { steps++; j++; }
      if (j >= n || s[j] !== ']' || j + 1 >= n || s[j + 1] !== '(') continue;
      let e = j + 2;
      while (e < n && s[e] !== ')' && !/\s/.test(s[e]) && (!targetStopsAtBracket || (s[e] !== '[' && s[e] !== ']'))) { steps++; e++; }
    }
    counter.steps += steps;
    return [];
  };
}

test('the work witness goes red on a quadratic stand-in whose label does not stop at a bracket', () => {
  const v = witness(standIn({ labelStopsAtBracket: false, targetStopsAtBracket: true }), 'the unclosed "[" run', SHAPES['the unclosed "[" run']);
  assert.notEqual(v, '', 'a label that rescans to the next closing bracket must fail the witness');
});

test('the work witness goes red on a quadratic stand-in whose target does not stop at a bracket', () => {
  const v = witness(standIn({ labelStopsAtBracket: true, targetStopsAtBracket: false }), 'the "[](" run', SHAPES['the "[](" run, with no ")" anywhere']);
  assert.notEqual(v, '', 'a target that runs across brackets must fail the witness');
});

test('the work witness goes red on the previous pattern\'s shape: the unclosed "[" run is quadratic under it', () => {
  const v = witness(previousShape, 'the unclosed "[" run', SHAPES['the unclosed "[" run']);
  assert.notEqual(v, '', 'the previous shape must fail the witness, or the witness proves nothing about the port');
});

test('the work witness goes red on an extractor that counts nothing, so it cannot pass vacuously', () => {
  const uncounted = (text) => text.match(PREVIOUS_LINK_RE) || [];
  assert.notEqual(witness(uncounted, 'many closed links', SHAPES['many closed links']), '', 'an extractor that leaves the counter at zero must fail');
});

test('extractLinks still finds an ordinary link, an image, a link after an unclosed bracket, and the title and angle-bracket forms', () => {
  assert.deepEqual(extractLinks('see [docs](./a.md) and ![logo](./img/b.png) and [x [y](./c.md) tail').map((l) => l.target), ['./a.md', './img/b.png', './c.md']);
  assert.deepEqual(extractLinks('[unclosed\n\nlater [y](./d.md)').map((l) => l.target), ['./d.md']);
  assert.deepEqual(extractLinks('[![badge](./badge.svg)](./home.md)').map((l) => l.target), ['./badge.svg']);
  assert.deepEqual(extractLinks('[t](./a.md "a title") and [u](./b.md "second")').map((l) => l.target), ['./a.md', './b.md']);
  assert.deepEqual(extractLinks("[t](./a.md 'a title') and [u](./b.md 'it\"s')").map((l) => l.target), ['./a.md', './b.md']);
  assert.deepEqual(extractLinks('[v](./c.md \n"x")').map((l) => l.target), [], 'a title after a line break is not part of the link');
  assert.deepEqual(extractLinks('[x](<./a b.md>) and [y](<./c.md> "t")').map((l) => l.target), ['./a b.md', './c.md']);
  assert.deepEqual(extractLinks('[x](<>) and [y](<a\nb>)').map((l) => l.target), [], 'an empty or line-broken angle destination is not a link');
});
