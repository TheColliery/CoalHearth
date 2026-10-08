// CWK-136 -- the git-spawn census. Does every `git` child this room spawns take its environment
// from gitEnv() (scripts/lib/git-env.mjs), and only from it? (Or, since 08c, from an ALLOWLIST object: see the paragraph before SAFE_GIT_KEYS.)
//
// It proves SAFETY, not presence. CoalTipple's census (the exemplar) only tested that an `env:` key
// existed in the call, which passes `env: process.env` -- the exact hole CWK-133 closes: inside a
// linked worktree a git hook exports an absolute GIT_DIR, and a child that inherits it acts on the
// enclosing repository. Here a git spawn is refused when
//   (a) it carries no `env:` key at all, or
//   (b) its `env:` text mentions process.env AT ALL (a spread, a bare pass-through, a helper call
//       beside it) -- except inside an ALLOWLIST object (08c, below), where process.env is read only by
//       named key, or
//   (c) its `env:` is anything but gitEnv(...) ALONE: the WHOLE expression is a call to it, or a
//       bare identifier declared `const NAME = gitEnv(...)` in the same file, exactly that call
//       and not mutated afterwards. An expression that merely CONTAINS `gitEnv(` -- a spread beside
//       an alias of process.env, Object.assign(gitEnv(), ...), `env || gitEnv(root)` -- is refused:
//       the helper's presence is not the property, the absence of everything else is.
// (R8 FIXBACK M1: rule (c) used to test only that `gitEnv(` appeared somewhere in the expression, so
// the gate printed "every one takes env from gitEnv() alone" while its own instrument did not
// produce that claim.)
//
// EXEMPTIONS are explicit, exact, COUNTED and PRINTED -- never a silent pass. GIT_ENV_EXEMPTIONS
// (below) names a file, the exact env expression, and the reason. The one entry is the hazard proof
// in git-env.test.mjs, which feeds a deliberately poisoned GIT_DIR to reproduce the incident inside a
// sandbox. Each entry carries the COUNT of spawns it covers: an exemption that matches fewer (none at all
// included) is reported as UNUSED and the gate fails on it, and a spawn beyond the count is a finding, so an
// entry can neither outlive its spawn nor widen to cover a new one (R8 FIXBACK 2 LOW-1).
//
// It is TEXTUAL, not a parser. What it sees:
//   - calls to the child_process functions a file binds: a destructured import or require (with `as`
//     / `:` renames), an alias by assignment (`const run = spawnSync`), a whole-module binding used
//     as `cp.spawnSync(` or `cp.default.spawnSync(`, and the inline `require('child_process').fn(`
//     and `(await import('child_process')).fn(` forms.
//   - a git spawn however the binary is spelled (`git`, `git.exe`, `git.cmd`, an absolute path to
//     one), and git through a shell: `sh -c '... git ...'`, an `execSync`/`exec` command string, or
//     any call with `shell:` set.
//   - a spawn whose command is neither a string literal nor process.execPath is REFUSED: it cannot
//     be proven not to be git.
//   - a `//` comment or a `*` block-comment line is skipped.
// What it does NOT see -- named-open, on purpose, not closed:
//   - a callee obtained any other way: returned from a function, a property of another object,
//     Reflect.apply, or a WRAPPER around git defined elsewhere and called by its own name (the
//     wrapper's own spawn is seen only if it binds child_process where it is defined).
//   - the env identifier mutated through ANOTHER alias (`const H = G; H.GIT_DIR = x`) or by a
//     function it is passed to (`tweak(G)`); only direct mutation of the declared name is seen.
//   - a shell command that reaches git without the word appearing in the call (`sh script.sh`, a
//     command assembled at runtime from parts), or a `shell:` call whose arguments are a variable
//     rather than an array literal (its strings are not in the call text).
//   - a call inside a multi-line block comment whose lines do not start with `*`, or inside a
//     string, would be misread.
//   - a node child (process.execPath) is COUNTED and left alone: it is not a git spawn, and the
//     gates it runs strip their own git children.
//
// Pure: a list of { label, text } in, a report out, so it is unit-tested red-first without a clone.
// The enumeration is NOT walked here -- scripts/verify.mjs feeds it the same surfaces the pointer
// gate walks (see the wiring there).

import { createHash } from 'node:crypto';

// BLOB-PINNED rows (CWK-174, R14): a row may carry `blob`, a git blob id (git hash-object <file>). It then applies ONLY while the
// file's text is exactly those bytes; any edit, or a template re-sync that changes them, spends nothing, reads as UNUSED and adds a
// finding naming the new id. This is for a byte-equal org carrier (the house secret scan's tests): the umbrella's parity check forbids
// editing it here, so the census cannot be satisfied by routing its spawns through gitEnv(), and the row must not outlive that content.
// A row whose `expr` is null covers a spawn that carries no env: key at all.
//
// NAMED DIVERGENCE (05a FIXBACK 2): scripts/release-notes.test.mjs is HELD at blob d2f5b830, the blob this room carried before the adoption, not the canon's a8f3ba69 (.github 7afc4ef). The
// canon's test asserts the child env holds nothing but what node needs, which is red on macOS (it injects __CF_USER_TEXT_ENCODING) and on the coverage leg (NODE_V8_COVERAGE); CoalBoard
// measured it (CI run 37224469491). The held file passes the census with no row. Exit: re-sync the file when the canon fix lands, and skeleton-check then reads equal.
//
// The deliberate exemptions. Exact file label + exact env expression (whitespace-normalised) + the EXPECTED
// COUNT of spawns it covers (default 1): a further match fails the gate, fewer than the count fails it as
// stale. The reason is printed by the gate: keep it free of parentheses.
export const GIT_ENV_EXEMPTIONS = [
  // CWK-174 (R14): the canon's two secret-scan tests, byte-equal org carriers from the published-code template at .github 05da36a.
  // secret-gate.test.mjs builds its env from a LOCAL gitEnv helper that strips every GIT_* variable and then spreads a per-call overlay,
  // so the census refuses the SHAPE (CWK-136 asks for the room's helper alone); secret-scan.test.mjs spawns git with no env: at all,
  // so a pathspec or -a commit run from a hook hands those children an absolute GIT_INDEX_FILE (the CWK-133 class in the canon, routed
  // to the .github deputy). Delete each row when the canon carries the fix and this room re-copies the file.
  // 05a (UMB-444): secret-gate.test.mjs was re-copied at .github 7afc4ef (blob f61a33e7, was 3fcd3f0d: the explicit test env). Measured on the new bytes: without this row the census
  // still fails on the same line, because the canon keeps its own GIT_-stripping helper plus the per-call overlay, so the row stays and its pin moves to the new blob.
  {
    label: 'scripts/secret-gate.test.mjs',
    expr: '{ ...gitEnv(), ...extra }',
    count: 1,
    blob: 'f61a33e75a3a420e0de0116f45d2b1fd44936a50',
    reason: 'a byte-equal org carrier at blob f61a33e7 from the published-code template whose env is its own GIT_-stripping helper plus an overlay, pinned by blob id and deleted when the canon uses the room helper',
  },
  {
    label: 'scripts/secret-scan.test.mjs',
    expr: null,
    count: 3,
    blob: 'a9cb7145e31139ec3c490dd7714df8fa7dc6cf86',
    reason: 'a byte-equal org carrier from the published-code template whose git children inherit the environment, so a pathspec or -a commit hands them an absolute GIT_INDEX_FILE, pinned by blob id and deleted when the canon fixes it',
  },
  // 08c (UMB-456 (2) rule (a)): the row for scripts/release-notes.mjs (05a, blob 674592e0) is GONE. That file builds its env from an allowlist, and the census
  // now accepts that shape (the paragraph before SAFE_GIT_KEYS), so the carrier needs no pin and its re-syncs cannot spend or strand one.
  {
    label: 'scripts/lib/git-env.test.mjs',
    expr: 'env || gitEnv(root)',
    count: 1,
    reason: 'the hazard proof feeds a deliberately poisoned GIT_DIR into a sandbox to reproduce the incident',
  },
];

const FNS = ['spawnSync', 'execFileSync', 'spawn', 'execFile', 'execSync', 'exec'];
const SHELL_STRING_FNS = new Set(['execSync', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const STRING_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const CP_MOD = String.raw`['"](?:node:)?child_process['"]`;
const DESTRUCTURED_RE = new RegExp(String.raw`\{([^}]*)\}\s*(?:=\s*(?:await\s+import|require)\(\s*|from\s*)` + CP_MOD, 'g');
const NS_IMPORT_RE = new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*` + CP_MOD, 'g');
const NS_REQUIRE_RE = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+import|require)\(\s*` + CP_MOD, 'g');
// A name that reaches new RegExp(...) is escaped in FULL (every metacharacter and the backslash), not for `$` alone: a
// bound local is whatever a destructuring list holds, comments included (R8 ALERT #19, CodeQL js/incomplete-sanitization).
const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split one destructuring/import list into [canonical function, local name] pairs.
function bindingPairs(list) {
  const out = [];
  for (const part of list.split(',')) {
    const [canon, local] = part.trim().split(/\s+as\s+|\s*:\s*/);
    if (FNS.includes(canon)) out.push([canon, (local || canon).trim()]);
  }
  return out;
}

// Which names does this file bind to child_process functions? locals: local name -> the real
// function; spaces: whole-module bindings, used as `cp.spawnSync(`. Returns { locals, re } where re
// finds the calls. Named groups: qfn = the function of a qualified call, ifn = the function of an
// inline require/import call, loc = the local name of a bare call.
function bindingsOf(text) {
  const locals = new Map();
  for (const m of text.matchAll(DESTRUCTURED_RE)) for (const [canon, local] of bindingPairs(m[1])) locals.set(local, canon);
  const spaces = new Set();
  for (const m of text.matchAll(NS_IMPORT_RE)) spaces.add(m[1]);
  for (const m of text.matchAll(NS_REQUIRE_RE)) spaces.add(m[1]);
  if (spaces.size) {
    const ns = [...spaces].map(escapeRegex).join('|');
    // const { spawnSync: run } = cp;
    for (const m of text.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*(?:${ns})\s*(?:;|\n|$)`, 'g'))) {
      for (const [canon, local] of bindingPairs(m[1])) locals.set(local, canon);
    }
    // const run = cp.spawnSync;
    for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:${ns})\.(?:default\.)?(${FNS.join('|')})\s*(?:;|\n|,|$)`, 'g'))) locals.set(m[1], m[2]);
  }
  // const run = spawnSync;  (an alias by assignment, chained: a fixpoint over the assignments)
  for (let pass = 0; pass < 3; pass++) {
    for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*([\w$]+)\s*(?:;|\n|,|$)/g)) {
      if (locals.has(m[2]) && !locals.has(m[1])) locals.set(m[1], locals.get(m[2]));
    }
  }
  const alts = [];
  if (spaces.size) alts.push(`(?<ns>${[...spaces].map(escapeRegex).join('|')})\\.(?:default\\.)?(?<qfn>${FNS.join('|')})`);
  if (locals.size) alts.push(`(?<loc>${[...locals.keys()].map(escapeRegex).join('|')})`);
  alts.push(`(?:require\\(\\s*${CP_MOD}\\s*\\)|\\(\\s*await\\s+import\\(\\s*${CP_MOD}\\s*\\)\\s*\\))\\.(?:default\\.)?(?<ifn>${FNS.join('|')})`);
  return { locals, re: new RegExp('(?<![.\\w$])(?:' + alts.join('|') + ')\\(', 'g') };
}

// A match inside a line comment is not code. Strip string literals from the text BEFORE the match on
// its own line first, so a `//` inside a URL string does not hide a real call.
function isInComment(text, matchIndex) {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  const before = text.slice(lineStart, matchIndex);
  const trimmed = before.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  return before.replace(STRING_RE, '').includes('//');
}

function findMatchingClose(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// The text of one argument starting at `from`: up to the first `,` or closer at nesting depth 0.
function readExpr(text, from, limit) {
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) return text.slice(from, i); depth--; }
    else if (c === ',' && depth === 0) return text.slice(from, i);
  }
  return text.slice(from, limit);
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const normalise = (s) => s.replace(/\s+/g, ' ').trim();

// Does a command string, run by a shell, invoke git? `git` as a whole word, at a command position or
// reached by a path (`/usr/bin/git`, `C:/Program Files/Git/cmd/git.exe`, a quoted one). `.git`,
// `.gitignore` and `my-git-repo` are not: the character before must be a separator, a quote or a path
// separator, and the one after a separator or a quote (R8 FIXBACK 2 MEDIUM-1: the class had no `/` or
// `\`, so every path-qualified git in a shell string evaded).
const shellMentionsGit = (s) => /(^|[\s;&|(`$"'/\\])git(\.exe|\.cmd|\.bat)?(?=[\s;&|)`"']|$)/i.test(s);
const GIT_BASENAME = /^git(\.exe|\.cmd|\.bat)?$/i;

// The expression is EXACTLY one call to gitEnv(...), nothing before or after it.
function isWholeGitEnvCall(expr) {
  if (!/^gitEnv\(/.test(expr)) return false;
  return findMatchingClose(expr, expr.indexOf('(')) === expr.length - 1;
}

// `const NAME = gitEnv(...)` in this file: is NAME exactly that call, and is it left alone afterwards?
// Returns null when the alias is sound, or the reason it is not.
function aliasVerdict(name, fileText) {
  const decl = new RegExp(String.raw`\bconst\s+${escapeRegex(name)}\s*=\s*gitEnv\(`).exec(fileText);
  if (!decl) return 'is not declared `const ' + name + ' = gitEnv(...)` in this file';
  const open = decl.index + decl[0].length - 1;
  const close = findMatchingClose(fileText, open);
  if (close === -1 || !/^\s*(?:;|\n|,|$)/.test(fileText.slice(close + 1))) return 'is assigned from more than the bare gitEnv(...) call';
  const mutation = mutationOf(name, fileText);
  if (mutation) return 'is mutated after it is assigned (line ' + lineOf(fileText, mutation.index) + ')';
  return null;
}

// The first statement that changes NAME after its declaration: a property write, an index write, Object.assign/defineProperty on it, a delete; for a
// key list (array = true) also the array methods that grow or rewrite it. A write to `process.env.X` is a write to someone else's object, so a name
// preceded by a dot never counts (08c: a local `env` and `process.env.TZ = 'UTC'` in one file are two things).
function mutationOf(name, fileText, array = false) {
  const n = escapeRegex(name);
  const forms = [
    String.raw`(?<![.\w$])${n}\s*\.\s*[\w$]+\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`(?<![.\w$])${n}\s*\[[^\]\n]*\]\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(\s*${n}\b`,
    String.raw`\bdelete\s+${n}\b`,
  ];
  if (array) forms.push(String.raw`(?<![.\w$])${n}\s*\.\s*(?:push|unshift|splice|fill|copyWithin)\s*\(`);
  return new RegExp(forms.join('|')).exec(fileText);
}

// The index of the bracket that closes the one at openIdx, skipping string literals; -1 when the text is unbalanced (fail closed).
function closeOf(text, openIdx) {
  const pair = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return -1;
      i = j;
    } else if (pair[c]) stack.push(pair[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// 08c UNIT 1 (main's ruling UMB-456 (2), rule (a)) -- the ALLOWLIST env, the second shape a git child's env may take.
// An env is an allowlist when it is a POSITIVE list of named keys, never a copy of the ambient environment with things taken out:
//   - one object literal (inline in the call, or `const NAME = { ... };` declared exactly once in the file and never changed after);
//   - no spread but `...Object.fromEntries(KEYS[.filter((k) => process.env[k] !== undefined)].map((k) => [k, process.env[k]]))`, the one idiom the
//     canon's release-notes.mjs uses, where KEYS is a `const` array of string literals declared once and never changed; any other spread is refused,
//     and so is a computed key, a computed index into a value, a template interpolation, and any read of process.env that is not `process.env.NAME`;
//   - GIT_CONFIG_NOSYSTEM set to 1 (git reads the system config file whatever else the env holds, so the list must switch it off);
//   - no GIT_ name anywhere in the object or in KEYS except the three harmless ones in SAFE_GIT_KEYS. The check is a POSITIVE list, never "delete the
//     bad ones": GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and a GIT_ variable git invents tomorrow are all refused the same way, in any letter case.
//     The three, by what each does to git: GIT_CONFIG_NOSYSTEM skips the system config file, GIT_TERMINAL_PROMPT=0 forbids a credential prompt,
//     GIT_CEILING_DIRECTORIES only NARROWS where git looks for a repository. None of them points git at a repository, which is the hazard of CWK-133.
// This is a reading of TEXT. What it does not see, named: a value that is a call returning part of the environment (`pick()`), a name bound to
// process.env elsewhere and read as a dotted member (`e.GIT_X` is caught by the name; `e.PATH` is a plain named read and passes), and a helper that
// takes the finished object and changes it (`tweak(env)`); only direct mutation of the declared name is seen.
const SAFE_GIT_KEYS = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_CEILING_DIRECTORIES']);
const isSafeGitName = (k) => !/^git_/i.test(k) || SAFE_GIT_KEYS.has(k.toUpperCase());
const blankStrings = (s) => s.replace(STRING_RE, (m) => m[0] + ' '.repeat(m.length - 2) + m[m.length - 1]);
// KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]), whitespace-normalised; the filter is optional.
const ALLOW_CHAIN_RE = /^([A-Za-z_$][\w$]*)(?:\.filter\(\(?([A-Za-z_$][\w$]*)\)? => process\.env\[\2\] !== undefined\))?\.map\(\(?([A-Za-z_$][\w$]*)\)? => \[\3, process\.env\[\3\]\]\)$/;

function topLevelParts(masked) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push([from, i]); from = i + 1; }
  }
  parts.push([from, masked.length]);
  return parts;
}

// null when NAME is a const array of string literals, declared once, never changed, naming no GIT_ variable but the harmless three; else the reason.
function keyListVerdict(name, fileText) {
  const esc = escapeRegex(name);
  const decls = fileText.match(new RegExp(String.raw`\b(?:const|let|var)\s+${esc}\b`, 'g')) || [];
  if (decls.length !== 1) return `the key list ${name} is declared ${decls.length} times in this file, and it must be exactly once`;
  const d = new RegExp(String.raw`\bconst\s+${esc}\s*=\s*\[`).exec(fileText);
  if (!d) return `the key list ${name} is not declared \`const ${name} = [...]\``;
  const open = d.index + d[0].length - 1;
  const close = closeOf(fileText, open);
  if (close === -1) return `the key list ${name} is not a balanced array literal`;
  const body = fileText.slice(open + 1, close);
  if (body.includes('${') || !/^[\s,]*$/.test(blankStrings(body).replace(/(['"`]) *\1/g, ''))) return `the key list ${name} holds more than plain string literals`;
  for (const s of body.match(STRING_RE) || []) {
    if (!isSafeGitName(s.slice(1, -1))) return `the key list ${name} names ${s.slice(1, -1)}, which is not one of the harmless GIT_ names (${[...SAFE_GIT_KEYS].join(', ')})`;
  }
  const changed = mutationOf(name, fileText, true);
  if (changed) return `the key list ${name} is changed after it is declared (line ${lineOf(fileText, changed.index)})`;
  return null;
}

// null when `rest` (the text after `...`) is Object.fromEntries(<the canon idiom over a sound key list>), else the reason.
function spreadVerdict(rest, fileText) {
  const f = /^Object\s*\.\s*fromEntries\s*\(/.exec(rest);
  if (!f) return `spreads ${rest.slice(0, 30)}, which is not a list of named keys: the only spread read is ...Object.fromEntries(KEYS.filter(...).map(...))`;
  const open = f[0].length - 1;
  const chain = rest.slice(open + 1, -1).replace(/\s+/g, ' ').trim();
  const m = ALLOW_CHAIN_RE.exec(chain);
  if (!m) return `its Object.fromEntries(${chain.slice(0, 50)}) is not the canon idiom KEYS[.filter((k) => process.env[k] !== undefined)].map((k) => [k, process.env[k]])`;
  return keyListVerdict(m[1], fileText);
}

// null when one property's VALUE reads the environment only by a named key and indexes nothing by a computed key, else the reason.
function valueVerdict(value, masked) {
  for (const m of masked.matchAll(/\bprocess\b/g)) {
    const tail = masked.slice(m.index + m[0].length);
    if (/^\s*\.\s*env\b/.test(tail) && !/^\s*\.\s*env\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`])/.test(tail)) return 'reads process.env other than by a named key (process.env.NAME or process.env["NAME"])';
    if (/^\s*\[/.test(tail)) return 'reaches process by a computed key';
  }
  for (const m of masked.matchAll(/[\w$)\]]\s*\[/g)) {
    if (!/^\s*['"`]/.test(value.slice(m.index + m[0].length))) return 'indexes a value by a computed key, which could name any variable of the environment';
  }
  return null;
}

// null when `obj` is a sound allowlist env object literal, else the reason it is not.
function allowlistObjectVerdict(obj, fileText) {
  const text = obj.trim();
  if (text[0] !== '{' || closeOf(text, 0) !== text.length - 1) return 'is not exactly one object literal';
  if (text.includes('${')) return 'holds a template interpolation, which cannot be read as a list of keys';
  for (const m of text.matchAll(/\bgit_[\w$]*/gi)) {
    if (!isSafeGitName(m[0])) return `names ${m[0]}, which is not one of the harmless GIT_ names (${[...SAFE_GIT_KEYS].join(', ')})`;
  }
  const masked = blankStrings(text);
  let noSystem = false;
  for (const [a, b] of topLevelParts(masked.slice(1, -1))) {
    const part = text.slice(1 + a, 1 + b).trim();
    const pm = masked.slice(1 + a, 1 + b).trim();
    if (!part) continue; // a trailing comma
    if (pm.startsWith('...')) {
      const bad = spreadVerdict(part.slice(3).trim(), fileText);
      if (bad) return bad;
      continue;
    }
    const k = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(?::|$)/.exec(part);
    if (!k) return `has a property the census cannot read (${part.slice(0, 40)})`;
    const key = k[1] ?? k[2] ?? k[3];
    const value = part.slice(k[0].length).trim();
    if (key.toUpperCase() === 'GIT_CONFIG_NOSYSTEM') {
      if (!/^(?:'1'|"1"|1)$/.test(value)) return `sets GIT_CONFIG_NOSYSTEM to ${value || '(nothing)'}, and it must be 1`;
      noSystem = true;
    }
    const bad = valueVerdict(value, pm.slice(pm.length - value.length));
    if (bad) return bad;
  }
  if (!noSystem) return 'does not set GIT_CONFIG_NOSYSTEM to 1 (git reads the system config file whatever the env holds, so the list must switch it off)';
  return null;
}

// null when NAME is a sound allowlist env in this file; else { reason, attempted } with attempted = the declaration IS an object literal.
function allowlistAliasVerdict(name, fileText) {
  const esc = escapeRegex(name);
  const d = new RegExp(String.raw`\bconst\s+${esc}\s*=\s*\{`).exec(fileText);
  if (!d) return { reason: `is not declared \`const ${name} = { ... }\` in this file`, attempted: false };
  const decls = fileText.match(new RegExp(String.raw`\b(?:const|let|var)\s+${esc}\b`, 'g')) || [];
  if (decls.length !== 1) return { reason: `is declared ${decls.length} times in this file, so the census cannot tell which one the spawn reads`, attempted: true };
  const open = d.index + d[0].length - 1;
  const close = closeOf(fileText, open);
  if (close === -1 || !/^\s*(?:;|\n|$)/.test(fileText.slice(close + 1))) return { reason: 'is assigned from more than the bare object literal', attempted: true };
  const bad = allowlistObjectVerdict(fileText.slice(open, close + 1), fileText);
  if (bad) return { reason: bad, attempted: true };
  const changed = mutationOf(name, fileText);
  if (changed) return { reason: `is mutated after it is assigned (line ${lineOf(fileText, changed.index)})`, attempted: true };
  return null;
}


// 05a FIXBACK 1 (LOW-1): is there a SHORTHAND property `env` in an object literal of the call: `{ env }`, `{ env, a }`, `{ a, env }`, on one line or several? It means `env: env`. The character
// before it must be `{`, or a `,` whose nearest enclosing bracket is a `{`: a positional `f(a, env)` or an array element `[a, env]` is not a property.
function hasShorthandEnv(callText) {
  const re = /([{,])\s*env\s*(?=[,}])/g;
  let m;
  while ((m = re.exec(callText))) {
    if (m[1] === '{') return true;
    let depth = 0;
    for (let i = m.index - 1; i >= 0; i--) {
      const c = callText[i];
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') { if (depth === 0) { if (c === '{') return true; break; } depth--; }
    }
  }
  return false;
}

// null = the env is gitEnv() alone; { allowlist: true, expr } = a sound allowlist object (08c); otherwise { why, expr }.
function envVerdict(callText, fileText) {
  const m = /\benv\s*:/.exec(callText);
  if (!m && !hasShorthandEnv(callText)) return { why: "carries no 'env:' -- every git child must take env: gitEnv(...) (CWK-133)", expr: null };
  const expr = m ? readExpr(callText, m.index + m[0].length, callText.length).trim() : 'env';
  let allowWhy = '';
  if (expr.startsWith('{')) {
    const bad = allowlistObjectVerdict(expr, fileText);
    if (!bad) return { allowlist: true, expr };
    allowWhy = `; as an allowlist env it fails: ${bad}`;
  }
  if (/\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/.test(expr)) {
    return { why: `env: ${expr} mentions process.env -- a git child inherits a hook's absolute GIT_DIR that way; take env from gitEnv(...) alone (CWK-136)`, expr };
  }
  if (isWholeGitEnvCall(expr)) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const bad = aliasVerdict(expr, fileText);
    if (!bad) return null;
    const al = allowlistAliasVerdict(expr, fileText);
    if (!al) return { allowlist: true, expr };
    return { why: `env: ${expr} ${bad}${al.attempted ? `; as an allowlist env it fails: ${al.reason}` : ''} -- take env from gitEnv(...) alone (CWK-136)`, expr };
  }
  return { why: `env: ${expr || '(empty)'} is not produced by gitEnv() alone -- the whole expression must be a call to it, or a const assigned from exactly that call (CWK-136)${allowWhy}`, expr };
}

// R19 (CodeRabbit PR #19 thread 15): does a template literal's BODY carry an interpolation, a dollar-brace no backslash escapes? Such a
// command is computed at run time, so it is not a provable literal (the header's promise: a spawn whose command is neither a string literal
// nor process.execPath is REFUSED). A template with none, an escaped dollar-brace or a lone dollar sign is plain text and stays a literal.
function interpolates(body) {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; } // a backslash escapes the next character
    if (body[i] === '$' && body[i + 1] === '{') return true;
  }
  return false;
}

// The git blob id of `text`, as `git hash-object` prints it for a file holding exactly these bytes.
export function blobId(text) {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + body.length + String.fromCharCode(0)), body])).digest('hex');
}

export function censusGitSpawns(files, { exemptions = GIT_ENV_EXEMPTIONS } = {}) {
  const findings = [];
  const gitSpawns = [];
  const exempt = [];
  const allowlist = [];
  const matched = new Map(); // exemption -> how many spawns it has been spent on
  let nodeChildren = 0;
  for (const { label, text } of files) {
    if (text === null || text === undefined) {
      findings.push(`${label} could not be read -- the census cannot vouch for a file it never saw`);
      continue;
    }
    const b = bindingsOf(text);
    let m;
    while ((m = b.re.exec(text))) {
      if (isInComment(text, m.index)) continue;
      const fn = m.groups.qfn || m.groups.ifn || b.locals.get(m.groups.loc);
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingClose(text, openIdx);
      const line = lineOf(text, m.index);
      if (closeIdx === -1) {
        findings.push(`${label}:${line} unbalanced parens reading a ${fn}(...) call -- the census cannot vouch for it`);
        continue;
      }
      const callText = text.slice(openIdx, closeIdx + 1);
      // rawFirst is the argument WITH its surrounding whitespace, so `end` is where it really stops: a space after
      // the paren or a newline (the normal multi-line format) must not shift every read past it (R8 FIXBACK 3).
      const rawFirst = readExpr(callText, 1, callText.length);
      const first = rawFirst.trim();
      const end = 1 + rawFirst.length;
      if (first === 'process.execPath') { nodeChildren++; continue; }
      const lit = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1$/.exec(first);
      if (!lit || (lit[1] === '`' && interpolates(lit[2]))) {
        findings.push(`${label}:${line} ${fn}(...) command is not a string literal or process.execPath -- the census cannot prove it is not git; spell the command as a literal`);
        continue;
      }
      const cmd = lit[2];
      const rest = callText.slice(end);
      const base = cmd.split(/[\\/]/).pop();
      let isGit = false;
      if (SHELL_STRING_FNS.has(fn) || /\bshell\s*:(?!\s*false\b)/.test(rest)) { // (?!\s*false) not \s*(?!false): the latter backtracks off the space and reads `shell: false` as a shell
        // A command STRING run by a shell. With `shell:` set Node JOINS the arguments array into that
        // command line, so git named only in the arguments is git too (an array literal; a variable is named open).
        const second = readExpr(callText, end + 1, callText.length).trim();
        const argStrings = second.startsWith('[') ? (second.match(STRING_RE) || []) : [];
        isGit = shellMentionsGit(cmd) || argStrings.some((s) => shellMentionsGit(s.slice(1, -1)));
      } else if (GIT_BASENAME.test(base)) isGit = true; // git, however the binary is spelled
      else if (SHELLS.has(base.toLowerCase())) isGit = (rest.match(STRING_RE) || []).some((s) => shellMentionsGit(s.slice(1, -1))); // sh -c '... git ...'
      if (!isGit) continue;
      const entry = { label, line, fn };
      gitSpawns.push(entry);
      const v = envVerdict(callText, text);
      if (!v) continue;
      if (v.allowlist) {
        allowlist.push({ label, line, expr: normalise(v.expr) });
        continue;
      }
      const sameSpawn = (e) => e.label === label && (e.expr === null ? v.expr === null : v.expr !== null && normalise(e.expr) === normalise(v.expr));
      const pinOk = (e) => e.blob === undefined || blobId(text) === e.blob;
      const ex = exemptions.find((e) => sameSpawn(e) && pinOk(e));
      if (!ex) {
        const pinned = exemptions.find((e) => sameSpawn(e) && !pinOk(e));
        if (pinned) {
          findings.push(`${label}:${line} ${fn}(git) ${v.why} -- the exemption for ${pinned.label} is pinned to blob ${pinned.blob}, and this file's blob id is ${blobId(text)}, not the pinned ${pinned.blob}: re-derive it from the template or drop the pin with its reason`);
          continue;
        }
      }
      if (ex) {
        const want = ex.count ?? 1;
        const n = (matched.get(ex) || 0) + 1;
        matched.set(ex, n);
        if (n <= want) {
          entry.exempt = true;
          exempt.push({ label, line, expr: v.expr === null ? null : normalise(v.expr), reason: ex.reason });
        } else {
          // R8 FIXBACK 2 LOW-1: the exemption is keyed to an EXPECTED COUNT, so a further spawn with the same
          // expression in the same file is a finding, not a silent widening of the exemption.
          findings.push(`${label}:${line} ${fn}(git) env: ${v.expr} matches the exemption for ${ex.label}, which allows ${want} spawn(s) -- this is spawn ${n}; a new spawn needs its own exemption or gitEnv(...) alone (CWK-136)`);
        }
        continue;
      }
      findings.push(`${label}:${line} ${fn}(git) ${v.why}`);
    }
  }
  // Stale: fewer spawns than the entry counts (none at all included). More than it counts is already a finding.
  const unusedExemptions = exemptions
    .map((e) => ({ label: e.label, expr: e.expr, want: e.count ?? 1, matched: matched.get(e) || 0 }))
    .filter((e) => e.matched < e.want);
  return { findings, gitSpawns, exempt, allowlist, unusedExemptions, nodeChildren };
}
