// 08d -- unit tests for the tokenizer the git-spawn census reads source through (scripts/lib/js-lex.mjs).
// Fixtures that need a backslash or a backtick build it from a code point (AGENTS.md Hard-won lessons: the tools that write this file can decode a four-hex escape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, codeTokens, inNonCode, matchClose, enclosingOpen, decodeString, decodeIdent } from './js-lex.mjs';

const BS = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const kinds = (text) => { const r = lex(text); assert.equal(r.error, undefined, text); return r.tokens.map((t) => `${t.t}:${t.v}`); };

test('lex: names, numbers and punctuation come out as tokens with positions', () => {
  const r = lex('a=1+b_2;');
  assert.deepEqual(r.tokens.map((t) => [t.t, t.v, t.s, t.e]), [['id', 'a', 0, 1], ['punct', '=', 1, 2], ['num', '1', 2, 3], ['punct', '+', 3, 4], ['id', 'b_2', 4, 7], ['punct', ';', 7, 8]]);
});

test('lex: a string holding brackets, quotes and a comment marker is ONE token', () => {
  assert.deepEqual(kinds(`x("a ) ] } // /* ${BS}" b", 'c ${BS}' d')`), ['id:x', 'punct:(', `str:"a ) ] } // /* ${BS}" b"`, 'punct:,', `str:'c ${BS}' d'`, 'punct:)']);
});

test('lex: a template literal is text pieces and the tokens of its holes, nested holes included', () => {
  const k = kinds(`${BT}a ${'${'} f(${BT}b ${'${'} c ${'}'}${BT}) ${'}'} d${BT}`);
  assert.deepEqual(k.filter((v) => v.startsWith('id:')), ['id:f', 'id:c']);
  assert.ok(k.some((v) => v.startsWith('tpl-open')) && k.some((v) => v.startsWith('tpl-close')));
});

test('lex: an escaped backtick and an escaped dollar-brace stay inside the template text', () => {
  const r = lex(`${BT}x${BS}${BT} y ${BS}${'${'} z${BT} + w`);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tokens.map((t) => t.t), ['tpl', 'punct', 'id']);
});

test('lex: a regex literal holding a quote, a slash in a class and flags is one token; a division is not', () => {
  assert.deepEqual(kinds(`a = /'[/]x/gi.test(s)`), ['id:a', 'punct:=', "re:/'[/]x/gi", 'punct:.', 'id:test', 'punct:(', 'id:s', 'punct:)']);
  assert.deepEqual(kinds('a / b / c'), ['id:a', 'punct:/', 'id:b', 'punct:/', 'id:c']);
  assert.deepEqual(kinds('(a) / 2'), ['punct:(', 'id:a', 'punct:)', 'punct:/', 'num:2']);
  assert.deepEqual(kinds('x[0] / 2'), ['id:x', 'punct:[', 'num:0', 'punct:]', 'punct:/', 'num:2']);
  assert.deepEqual(kinds('return /x/'), ['id:return', 're:/x/']);
  assert.deepEqual(kinds('i++ / 2'), ['id:i', 'punct:++', 'punct:/', 'num:2']);
});

test('lex: a slash after the end of a template or a hole is a division, after an operator a regex', () => {
  assert.deepEqual(kinds(`${BT}x${BT} / 2`).slice(1), ['punct:/', 'num:2']);
  assert.ok(kinds('a = 1 + /x/.source').includes('re:/x/'));
});

test('lex: comments are tokens, so a caller can drop them, and a comment marker inside a string or a regex is not one', () => {
  const k = kinds('a // c\n/* b\n */ c');
  assert.deepEqual(k, ['id:a', 'comment:// c', 'comment:/* b\n */', 'id:c']);
  assert.deepEqual(codeTokens(lex('a // c\n/* b */ c').tokens).map((t) => t.v), ['a', 'c']);
  assert.deepEqual(kinds(`'//' + /\\/\\//`), ["str:'//'", 'punct:+', `re:/\\/\\//`]);
});

test('lex: a leading shebang line is skipped', () => {
  assert.deepEqual(kinds('#!/usr/bin/env node\nconst a = 1;'), ['id:const', 'id:a', 'punct:=', 'num:1', 'punct:;']);
});

test('lex: identifiers carry unicode letters and \\u escapes, numbers carry exponents, hex and separators', () => {
  assert.deepEqual(kinds(`${BS}u0047IT_DIR = caf${String.fromCharCode(0xe9)} + 1e-3 + 0x1f + 1_000`), [`id:${BS}u0047IT_DIR`, 'punct:=', `id:caf${String.fromCharCode(0xe9)}`, 'punct:+', 'num:1e-3', 'punct:+', 'num:0x1f', 'punct:+', 'num:1_000']);
});

test('lex: what it cannot read is an error with a position, never a guess', () => {
  for (const [text, why] of [["'abc", /unterminated string/], ['"abc\nd"', /unterminated string/], [`${BT}abc`, /template/], [`a ${BT}${'${'} b`, /hole|template/], ['/* open', /block comment/], ['x = /abc', /regex/]]) {
    const r = lex(text);
    assert.match(r.error, why, text);
    assert.equal(typeof r.at, 'number', text);
  }
});

test('inNonCode: comments, strings, regexes and template text are not code; template holes and everything else are', () => {
  const text = `a /* b */ 'c' + /d/.x ${BT}t${'${'}h${'}'}u${BT} e`;
  const { tokens } = lex(text);
  const at = (s) => text.indexOf(s);
  assert.equal(inNonCode(tokens, at('b')), true);
  assert.equal(inNonCode(tokens, at('c')), true);
  assert.equal(inNonCode(tokens, at('/d/') + 1), true);
  assert.equal(inNonCode(tokens, at('t' + '$')), true, 'the text of a template');
  assert.equal(inNonCode(tokens, at('h')), false, 'a hole is code');
  assert.equal(inNonCode(tokens, at('u')), true);
  assert.equal(inNonCode(tokens, at('a')), false);
  assert.equal(inNonCode(tokens, at(' e') + 1), false);
});

test('matchClose and enclosingOpen: brackets inside strings, regexes and comments never count', () => {
  const { tokens } = lex(`f( ')' , [ /)/ , { a: 1 } ] /* ) */ )`);
  const ct = codeTokens(tokens);
  assert.equal(ct[matchClose(ct, 1)].v, ')');
  assert.equal(matchClose(ct, 1), ct.length - 1);
  const brace = ct.findIndex((t) => t.v === '{');
  assert.equal(ct[matchClose(ct, brace)].v, '}');
  assert.equal(ct[enclosingOpen(ct, brace)].v, '[');
  assert.equal(enclosingOpen(ct, 0), -1);
  assert.equal(matchClose(codeTokens(lex('( ]').tokens), 0), -1, 'a mismatched closer is -1');
  assert.equal(matchClose(codeTokens(lex('( (').tokens), 0), -1, 'an open bracket with no end is -1');
});

test('decodeString: every escape the language has is resolved; one it cannot read is null', () => {
  assert.equal(decodeString("'a" + BS + 'x47' + BS + 'u0049' + BS + 'u{54}' + BS + "n'"), 'aGIT\n');
  assert.equal(decodeString(`"${BS}t${BS}r${BS}b${BS}f${BS}v${BS}0${BS}${BS}${BS}'${BS}""`), `\t\r\b\f\v\0${BS}'"`);
  assert.equal(decodeString(`'a${BS}\nb'`), 'ab', 'a line continuation adds nothing');
  assert.equal(decodeString(`'${BS}q'`), 'q', 'an unknown escape is the character');
  for (const bad of [`'${BS}x4'`, `'${BS}u00'`, `'${BS}u{110000}'`, `'${BS}u{}'`, `'${BS}1'`, `'${BS}u{12'`]) assert.equal(decodeString(bad), null, bad);
});

test('decodeIdent: a unicode escape in a name resolves to the character, so GIT_DIR cannot hide behind one', () => {
  assert.equal(decodeIdent(`${BS}u0047IT_DIR`), 'GIT_DIR');
  assert.equal(decodeIdent(`G${BS}u{49}T_DIR`), 'GIT_DIR');
  assert.equal(decodeIdent('plain'), 'plain');
});

// 08d mutation wave: one leg per lexer branch the first table listed as a survivor.
test('lex: a slash at the very start opens a regex, and so does one right after a hole opener', () => {
  assert.deepEqual(kinds('/x/.test(a)'), ['re:/x/', 'punct:.', 'id:test', 'punct:(', 'id:a', 'punct:)']);
  assert.ok(kinds(`${BT}${'${'}/x/.source${'}'}${BT}`).includes('re:/x/'));
});

test('lex: a regex literal does not run across a line break', () => {
  assert.match(lex('x = /ab\ncd/').error, /regex/);
});

test('lex: braces nested in a template hole do not end it early', () => {
  const k = kinds(`${BT}a ${'${'} ({ a: { b: 1 } }).a ${'}'} z${BT}`);
  assert.deepEqual(k.filter((v) => v.startsWith('id:')), ['id:a', 'id:b', 'id:a']);
  assert.equal(k.filter((v) => v.startsWith('tpl-close')).length, 1);
  assert.ok(k[k.length - 1].startsWith('tpl:'));
});

test('lex: a hole that never closes is a HOLE error, not a template error', () => {
  assert.match(lex(`${BT}${'${'} a`).error, /hole/);
});

test('lex: ?. before a digit is a ternary, ?. before a name is optional chaining; /= is one token; a slash after a closing brace divides', () => {
  assert.deepEqual(kinds('x?.5:1'), ['id:x', 'punct:?', 'num:.5', 'punct::', 'num:1']);
  assert.deepEqual(kinds('x?.y'), ['id:x', 'punct:?.', 'id:y']);
  assert.deepEqual(kinds('a /= 2'), ['id:a', 'punct:/=', 'num:2']);
  assert.deepEqual(kinds('o = {}/2/3'), ['id:o', 'punct:=', 'punct:{', 'punct:}', 'punct:/', 'num:2', 'punct:/', 'num:3']);
});

test('enclosingOpen: the end of a template hole pops it, so a later argument still sits inside its call', () => {
  const ct = codeTokens(lex(`f(${BT}a${'${'}x${'}'}b${BT}, y)`).tokens);
  const y = ct.findIndex((t) => t.t === 'id' && t.v === 'y');
  assert.equal(ct[enclosingOpen(ct, y)].v, '(');
});

test('decodeString: backslash-0 before a digit is a legacy octal and is not read; a CRLF line continuation adds nothing', () => {
  assert.equal(decodeString(`'${BS}01'`), null);
  assert.equal(decodeString(`'${BS}0'`), '\0');
  assert.equal(decodeString(`'a${BS}\r\nb'`), 'ab');
});
