// 08d -- a small JavaScript tokenizer for the git-spawn census (scripts/lib/git-env-census.mjs). Zero-dependency, node builtins only.
//
// WHY IT EXISTS. The census used to read source as TEXT with a quote model of its own (blank every string, find the closing bracket by counting). A regex
// literal holding a quote, a template holding an escaped backtick, or a regex ending in // desyncs a text scanner: the entry or the call that follows is hidden
// (CoalLedger D1, D2, D4, CoalMine C6). This tokenizer reads the four things a text scanner gets wrong -- strings, template literals (with their ${ } holes),
// regex literals and comments -- as single tokens, so what is inside them is never mistaken for code, and what is code is never swallowed by them.
//
// WHAT IT IS NOT. It is not a parser and it does not judge. It gives the census a flat token list with positions; the census judges. Where it cannot read
// (an unterminated string, a regex with no end on its line, an unbalanced hole) it returns an error and the census FAILS CLOSED on that file.
//
// ONE KNOWN APPROXIMATION, named: telling a regex literal from a division by the PREVIOUS token (the standard heuristic). After `)`, `]`, `}`, a name or a
// number a slash is a division; after any other punctuator or after return/typeof/in/of/... it opens a regex. `if (x) /re/.test(y)` and a regex at the start of
// a statement after a closing brace are read as divisions; the wrong guess either errors (a quote or a slash with no partner) or reads the regex body as code,
// and the census refuses what it cannot read whole. It never makes a hidden entry look safe: the raw-text scan for GIT_ names in the census does not depend on it.

const ID_START = /[\p{L}\p{Nl}_$]/u;
const ID_PART = new RegExp('[\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}$' + String.fromCharCode(0x200c, 0x200d) + ']', 'u');
const UNI_ESC = /^\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/;
const PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
// a slash after one of these keywords opens a regex; after any other name it is a division
const RE_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const DIVISION_AFTER = new Set([')', ']', '}', '++', '--']);

const SPACES = ' \t\n\r\v\f' + String.fromCharCode(0xa0, 0xfeff, 0x2028, 0x2029);
const isSpace = (c) => SPACES.includes(c);
const isDigit = (c) => c >= '0' && c <= '9';

// the end index of an identifier starting at i (with \uXXXX escapes allowed), or i when none starts there
function identEnd(text, i) {
  let j = i;
  for (;;) {
    const c = text[j];
    if (c === undefined) return j;
    if (c === '\\') {
      const m = UNI_ESC.exec(text.slice(j, j + 12));
      if (!m) return j;
      j += m[0].length;
    } else if ((j === i ? ID_START : ID_PART).test(c)) j++;
    else return j;
  }
}

// A string literal starting at i (a quote). Returns the end index after the closing quote, or -1.
function stringEnd(text, i, limit) {
  const q = text[i];
  let j = i + 1;
  while (j < limit) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n' || c === '\r') return -1;
    j++;
  }
  return -1;
}

// A regex literal starting at i (a slash that opens one). Returns the end index after its flags, or -1 (no closing slash on the line).
function regexEnd(text, i, limit) {
  let j = i + 1;
  let inClass = false;
  while (j < limit) {
    const c = text[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') { j += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; j++; continue; }
    if (c === '[') { inClass = true; j++; continue; }
    if (c === '/') {
      j++;
      while (j < limit && /[A-Za-z]/.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

// Tokenize text[i..limit). When stopAtBrace, return at the unmatched closing brace (the end of a template hole) with end = the index after it.
function lexCode(text, i, limit, tokens, stopAtBrace) {
  let depth = 0;
  const lastSig = () => { for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].t !== 'comment') return tokens[k]; return null; };
  while (i < limit) {
    const c = text[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < limit && text[j] !== '\n' && text[j] !== '\r') j++;
      tokens.push({ t: 'comment', v: text.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      if (j === -1 || j + 2 > limit) return { error: 'an unterminated block comment', at: i };
      tokens.push({ t: 'comment', v: text.slice(i, j + 2), s: i, e: j + 2 });
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const j = stringEnd(text, i, limit);
      if (j === -1) return { error: 'an unterminated string', at: i };
      tokens.push({ t: 'str', v: text.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (c === '`') {
      const r = lexTemplate(text, i, limit, tokens);
      if (r.error) return r;
      i = r.end;
      continue;
    }
    if (c === '/') {
      const prev = lastSig();
      const opensRegex = prev === null
        || (prev.t === 'punct' && !DIVISION_AFTER.has(prev.v))
        || (prev.t === 'id' && RE_AFTER_WORD.has(prev.v))
        || prev.t === 'tpl-open';
      if (opensRegex) {
        const j = regexEnd(text, i, limit);
        if (j === -1) return { error: 'a regex literal with no end on its line', at: i };
        tokens.push({ t: 're', v: text.slice(i, j), s: i, e: j });
        i = j;
        continue;
      }
      if (text[i + 1] === '=') { tokens.push({ t: 'punct', v: '/=', s: i, e: i + 2 }); i += 2; continue; }
      tokens.push({ t: 'punct', v: '/', s: i, e: i + 1 });
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] || ''))) {
      let j = i + 1;
      while (j < limit && (/[\w.]/.test(text[j]) || ((text[j] === '+' || text[j] === '-') && /[eE]/.test(text[j - 1]) && !/^0[xX]/.test(text.slice(i, j))))) j++;
      tokens.push({ t: 'num', v: text.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    const e = identEnd(text, i);
    if (e > i) {
      tokens.push({ t: 'id', v: text.slice(i, e), s: i, e });
      i = e;
      continue;
    }
    if (stopAtBrace) {
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) return { end: i + 1 };
        depth--;
      }
    }
    let p = null;
    for (const cand of PUNCTS) if (text.startsWith(cand, i)) { p = cand; break; }
    if (p === '?.' && isDigit(text[i + 2] || '')) p = '?';
    if (p === null) p = c;
    tokens.push({ t: 'punct', v: p, s: i, e: i + p.length });
    i += p.length;
  }
  if (stopAtBrace) return { error: 'an unterminated template hole', at: i };
  return { end: i };
}

// A template literal starting at i (a backtick). Pushes 'tpl' pieces (the text between holes) and the tokens of each ${ } hole, in source order.
function lexTemplate(text, i, limit, tokens) {
  let seg = i;
  let j = i + 1;
  while (j < limit) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      tokens.push({ t: 'tpl', v: text.slice(seg, j + 1), s: seg, e: j + 1 });
      return { end: j + 1 };
    }
    if (c === '$' && text[j + 1] === '{') {
      tokens.push({ t: 'tpl', v: text.slice(seg, j + 2), s: seg, e: j + 2 });
      tokens.push({ t: 'tpl-open', v: '${', s: j, e: j + 2 });
      const r = lexCode(text, j + 2, limit, tokens, true);
      if (r.error) return r;
      tokens.push({ t: 'tpl-close', v: '}', s: r.end - 1, e: r.end });
      j = r.end;
      seg = j;
      continue;
    }
    j++;
  }
  return { error: 'an unterminated template literal', at: i };
}

// lex(text) -> { tokens } or { error, at }. A leading #! line is skipped.
export function lex(text) {
  const tokens = [];
  let i = 0;
  if (text.startsWith('#!')) { while (i < text.length && text[i] !== '\n') i++; }
  const r = lexCode(text, i, text.length, tokens, false);
  if (r.error) return { error: r.error, at: r.at };
  return { tokens };
}

// The tokens of code only (no comments), in order. A template's holes are code; its text pieces are not.
export const codeTokens = (tokens) => tokens.filter((k) => k.t !== 'comment');

// Is the character index inside a comment, a string, a regex literal or the text of a template (anything that is not code)?
export function inNonCode(tokens, pos) {
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = tokens[mid];
    if (pos < k.s) hi = mid - 1;
    else if (pos >= k.e) lo = mid + 1;
    else return k.t === 'comment' || k.t === 'str' || k.t === 're' || k.t === 'tpl';
  }
  return false;
}

const CLOSER = { '(': ')', '[': ']', '{': '}' };
// The index of the token that closes the bracket at tokens[i], or -1 (unbalanced). Brackets inside strings, regexes and comments are not tokens, so they never count.
export function matchClose(tokens, i) {
  const stack = [];
  for (let k = i; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'tpl-open') { stack.push('}'); continue; }
    if (t.t === 'tpl-close') { if (stack.pop() !== '}') return -1; if (!stack.length) return k; continue; }
    if (t.t !== 'punct') continue;
    if (CLOSER[t.v]) stack.push(CLOSER[t.v]);
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      if (stack.pop() !== t.v) return -1;
      if (!stack.length) return k;
    }
  }
  return -1;
}

// The index of the innermost unclosed opening bracket before tokens[i], or -1 at the top level.
export function enclosingOpen(tokens, i) {
  const stack = [];
  for (let k = 0; k < i; k++) {
    const t = tokens[k];
    if (t.t === 'tpl-open') { stack.push(k); continue; }
    if (t.t === 'tpl-close') { stack.pop(); continue; }
    if (t.t !== 'punct') continue;
    if (CLOSER[t.v]) stack.push(k);
    else if (t.v === ')' || t.v === ']' || t.v === '}') stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : -1;
}

// The decoded value of a string literal token (quotes included in `src`), or null when an escape cannot be read.
export function decodeString(src) {
  const body = src.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) return null;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'v') out += '\v';
    else if (n === '0' && !isDigit(body[i + 1] || '')) out += '\0';
    else if (n === 'x') {
      const h = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
      out += String.fromCharCode(parseInt(h, 16));
      i += 2;
    } else if (n === 'u') {
      let h;
      if (body[i + 1] === '{') {
        const close = body.indexOf('}', i + 2);
        if (close === -1) return null;
        h = body.slice(i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(h) || parseInt(h, 16) > 0x10ffff) return null;
        out += String.fromCodePoint(parseInt(h, 16));
        i = close;
      } else {
        h = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) return null;
        out += String.fromCharCode(parseInt(h, 16));
        i += 4;
      }
    } else if (n === '\n') { /* a line continuation adds nothing */ }
    else if (n === '\r') { if (body[i + 1] === '\n') i++; }
    else if (isDigit(n)) return null; // a legacy octal escape: not read
    else out += n;
  }
  return out;
}

// The decoded name of an identifier token (its \uXXXX escapes resolved).
export function decodeIdent(src) {
  return src.replace(/\\u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]+)\})/g, (_, a, b) => String.fromCodePoint(parseInt(a || b, 16)));
}
