// ponytail: 860 lines at declaration -- the census reads source through one tokenizer (js-lex.mjs) and judges each env rule (binding, helper, allowlist literal, options object) against the same token arrays; splitting the rules from the spawn walk would force every rule to re-pass the shared token indexes.
// CWK-136 -- the git-spawn census. Does every `git` child this room spawns take its environment
// from gitEnv() (scripts/lib/git-env.mjs), or from an ALLOWLIST object (08c, 08d: see the paragraphs before SAFE_GIT_KEYS), and from nothing else?
//
// It proves SAFETY, not presence. CoalTipple's census (the exemplar) only tested that an `env:` key
// existed in the call, which passes `env: process.env` -- the exact hole CWK-133 closes: inside a
// linked worktree a git hook exports an absolute GIT_DIR, and a child that inherits it acts on the
// enclosing repository. Here a git spawn is refused when
//   (a) it carries no `env:` key at all, or has more than one, or spreads another object after it, or
//   (b) its `env:` mentions process.env AT ALL (a spread, a bare pass-through, a helper call beside it) -- except inside an ALLOWLIST
//       object, where process.env is read only by named key, or
//   (c) its `env:` is anything but gitEnv(...) ALONE (the WHOLE expression is a call to the room's helper, or a bare identifier declared
//       `const NAME = gitEnv(...)` in the same file, exactly that call and not mutated or copied afterwards), an ALLOWLIST literal (inline, by a
//       `const` identifier, or by a same-file helper that returns one), or an exemption row. An expression that merely CONTAINS `gitEnv(` -- a spread beside
//       an alias of process.env, Object.assign(gitEnv(), ...), `env || gitEnv(root)` -- is refused:
//       the helper's presence is not the property, the absence of everything else is.
// (R8 FIXBACK M1: rule (c) used to test only that `gitEnv(` appeared somewhere in the expression, so
// the gate printed "every one takes env from gitEnv() alone" while its own instrument did not
// produce that claim.)
//
// EXEMPTIONS are explicit, exact, COUNTED and PRINTED -- never a silent pass. GIT_ENV_EXEMPTIONS
// (below) names a file, the exact env expression, and the reason. Each entry carries the COUNT of spawns it covers: an exemption that matches fewer (none at all
// included) is reported as UNUSED and the gate fails on it, and a spawn beyond the count is a finding, so an
// entry can neither outlive its spawn nor widen to cover a new one (R8 FIXBACK 2 LOW-1).
//
// 08d: the census reads TOKENS, not text (scripts/lib/js-lex.mjs). What it sees:
//   - calls to the child_process functions a file binds: a destructured import or require (with `as`
//     / `:` renames), an alias by assignment (`const run = spawnSync`), a whole-module binding used
//     as `cp.spawnSync(` or `cp.default.spawnSync(`, and the inline `require('child_process').fn(`
//     and `(await import('child_process')).fn(` forms. A call is CODE when no comment, string, regex literal or template text covers it: a regex ending in //
//     on the line before a spawn no longer hides it (witness F41e).
//   - a git spawn however the binary is spelled (`git`, `git.exe`, `git.cmd`, an absolute path to
//     one, a plain template literal), and git through a shell: `sh -c '... git ...'`, an `execSync`/`exec` command string, or
//     any call with `shell:` set.
//   - a spawn whose command is neither a string literal nor process.execPath is REFUSED: it cannot
//     be proven not to be git.
//   - the identifier an `env:` property reads: where it is declared, whether the spawn is inside that scope, and every other place the name appears.
// A file the tokenizer cannot read whole (an unterminated string, a regex with no end, unbalanced brackets) is a FINDING, never a silent pass.
// What it does NOT see -- named-open, on purpose, not closed:
//   - a callee obtained any other way: returned from a function, a property of another object,
//     Reflect.apply, or a WRAPPER around git defined elsewhere and called by its own name (the
//     wrapper's own spawn is seen only if it binds child_process where it is defined).
//   - an env object changed through a path the tokens do not show under another name than its own (the name is allowed in one place only, so this is a closed hole for
//     a `const` env; it stays open for an object reached through a property or a returned value).
//   - a shell command that reaches git without the word appearing in the call (`sh script.sh`, a
//     command assembled at runtime from parts), or a `shell:` call whose arguments are a variable
//     rather than an array literal (its strings are not in the call text).
//   - a node child (process.execPath) is COUNTED and left alone: it is not a git spawn, and the
//     gates it runs strip their own git children.
//
// Pure: a list of { label, text } in, a report out, so it is unit-tested red-first without a clone.
// The enumeration is NOT walked here -- scripts/verify.mjs feeds it the same surfaces the pointer
// gate walks (see the wiring there).

import { createHash } from 'node:crypto';
import path from 'node:path';
import { lex, codeTokens, inNonCode, decodeString, decodeIdent } from './js-lex.mjs';

// BLOB-PINNED rows (CWK-174, R14): a row may carry `blob`, a git blob id (git hash-object <file>). It then applies ONLY while the
// file's text is exactly those bytes; any edit, or a template re-sync that changes them, spends nothing, reads as UNUSED and adds a
// finding naming the new id. This is for a byte-equal org carrier (the house secret scan's tests and the release overlay's test): the umbrella's parity check forbids
// editing it here, so the census cannot be satisfied by routing its spawns through gitEnv(), and the row must not outlive that content.
// A row whose `expr` is null covers a spawn that carries no env: key at all.
//
// 08c UNIT 1, the 05a NAMED DIVERGENCE is RELEASED: scripts/release-notes.test.mjs was HELD at blob d2f5b830 because the canon's a8f3ba69 was red on macOS
// (__CF_USER_TEXT_ENCODING) and on the coverage leg (NODE_V8_COVERAGE). The canon's 8cf7e5fd, re-synced here, names both keys in its CHILD_KEY_NAMES set (UMB-456 (1) i),
// so the copy is byte-equal again and the divergence is gone from this room. 08d: its two git helpers take sandboxEnv(cwd), a same-file helper that returns one allowlist literal, which the census now READS (no row).
//
// The deliberate exemptions. Exact file label + exact env expression (whitespace-normalised) + the EXPECTED
// COUNT of spawns it covers (default 1): a further match fails the gate, fewer than the count fails it as
// stale. The reason is printed by the gate: keep it free of parentheses.
export const GIT_ENV_EXEMPTIONS = [
  // CWK-174 (R14), moved at 05a, 08c and 08d: byte-equal org carriers. Each row below was decided at 08d from the census's own output on the NEW bytes, as 05a and 08c did. A file that defines its
  // OWN gitEnv helper is judged on the helper's body (witness F42, the NAME gitEnv is trusted only for the room's imported helper), and the three carriers below define one that strips the
  // GIT_ family from a copy of the environment (a filter, which the census does not read) instead of naming keys, so each is pinned by blob id.
  // 08d MEASURED, re-copy of the five canon files: scripts/release-notes.test.mjs at blob 7e779ef8 needs NO row any more (its two git helpers now read as clean on the new bytes, the
  // sandboxEnv(cwd) row and its two spawns are gone from the printed count); scripts/verify-release-shape.test.mjs at fa8a730d has no git spawn the census reads.
  // scripts/secret-gate.mjs is .github blob 856956a1: its gitEnv keeps GIT_INDEX_FILE (the index a commit is made from), a GIT_ name outside the three the allowlist rule accepts.
  {
    label: 'scripts/secret-gate.mjs',
    expr: 'gitEnv()',
    count: 2,
    blob: '856956a1cca6f716e5507f6c23ac90ed34cbbe5f',
    reason: 'a byte-equal org carrier at blob 856956a1 whose own gitEnv helper strips the GIT_ family from a copy of the environment and keeps GIT_INDEX_FILE and GIT_CEILING_DIRECTORIES, pinned by blob id and deleted when the canon imports the room helper',
  },
  // scripts/secret-gate.test.mjs is .github blob 71452210: three spawns at lines 40, 200 and 225. Its own gitEnv (line 28) is an object literal that names GIT_CONFIG_GLOBAL, outside the three
  // harmless GIT_ names; the line 40 spawn overlays a per-call extra on it.
  {
    label: 'scripts/secret-gate.test.mjs',
    expr: '{ ...gitEnv(), ...extra }',
    count: 1,
    blob: '71452210d6a6f793895bc502557fce7e1f3e890c',
    reason: 'a byte-equal org carrier at blob 71452210 from the published-code template whose env is its own GIT_-stripping helper plus a per-call overlay, pinned by blob id and deleted when the canon uses the room helper',
  },
  {
    label: 'scripts/secret-gate.test.mjs',
    expr: 'gitEnv()',
    count: 2,
    blob: '71452210d6a6f793895bc502557fce7e1f3e890c',
    reason: 'a byte-equal org carrier at blob 71452210 whose own gitEnv helper names GIT_CONFIG_GLOBAL beside GIT_CONFIG_NOSYSTEM, pinned by blob id and deleted when the canon imports the room helper',
  },
  // scripts/secret-scan.test.mjs is the Bankfire source, blob d0db994d. MEASURED: the old cleanEnv row is DELETED (the decoy-repository check now takes its env from gitStatus, which reads gitEnv),
  // and five spawns (lines 547, 548, 715, 820, 825) take the carrier's own gitEnv, an arrow that assigns its object to a witness variable (envSeen = {...}) and spreads a GIT_-stripping filter:
  // not a literal the census reads, so the file is pinned.
  {
    label: 'scripts/secret-scan.test.mjs',
    expr: 'gitEnv()',
    count: 5,
    blob: 'd0db994df855ccd647f3ded878a6867bb198e196',
    reason: 'a byte-equal org carrier at blob d0db994d from the Bankfire scanner source whose own gitEnv helper strips the GIT_ family from a copy of the environment and sets GIT_CONFIG_NOSYSTEM, pinned by blob id and deleted when the canon imports the room helper',
  },
  // The same file's one NON-LITERAL command (line 561): the 8.3 short-name probe runs the shell named by the ComSpec variable on a generated .cmd file in the sandbox, with the GIT_-stripped environment.
  // It is not git, but the census cannot prove a computed command is not git, so it is a command row: pinned by blob id, counted, printed.
  {
    label: 'scripts/secret-scan.test.mjs',
    command: "process.env.ComSpec || 'cmd.exe'",
    count: 1,
    blob: 'd0db994df855ccd647f3ded878a6867bb198e196',
    reason: 'a byte-equal org carrier at blob d0db994d whose 8.3 short-name probe runs the shell named by ComSpec on a generated script file in its sandbox and is not git, pinned by blob id and deleted when the canon spells the command as a literal',
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

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const normalise = (s) => s.replace(/\s+/g, ' ').trim();

// Does a command string, run by a shell, invoke git? `git` as a whole word, at a command position or
// reached by a path (`/usr/bin/git`, `C:/Program Files/Git/cmd/git.exe`, a quoted one). `.git`,
// `.gitignore` and `my-git-repo` are not: the character before must be a separator, a quote or a path
// separator, and the one after a separator or a quote (R8 FIXBACK 2 MEDIUM-1: the class had no `/` or
// `\`, so every path-qualified git in a shell string evaded).
const shellMentionsGit = (s) => /(^|[\s;&|(`$"'/\\])git(\.exe|\.cmd|\.bat)?(?=[\s;&|)`"']|$)/i.test(s);
const GIT_BASENAME = /^git(\.exe|\.cmd|\.bat)?$/i;

// The git blob id of `text`, as `git hash-object` prints it for a file holding exactly these bytes.
export function blobId(text) {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + body.length + String.fromCharCode(0)), body])).digest('hex');
}

// ---- 08c / 08d: the second safe shape, and the token reading that judges both shapes ---------------------------------------------------------------------------
//
// An env is also SAFE when it is an ALLOWLIST: a POSITIVE list of named keys, never a copy of the ambient environment with things taken out.
//   - one object literal (inline, in a same-file helper that returns it, or in a `const NAME = { ... };` declared once and never touched again);
//   - the only spread read is ...Object.fromEntries(KEYS[.filter((k) => process.env[k] !== undefined | k in process.env)].map((k) => [k, process.env[k]])), the canon
//     idiom, over KEYS = a `const` array of string literals, declared once and never changed or used for anything but that chain;
//   - no computed key, no method, no getter, a value that reads process.env only as process.env.NAME or process.env['NAME'] and never indexes a value by a computed key;
//   - GIT_CONFIG_NOSYSTEM set to the literal 1, exactly once, AFTER every spread (an ambient value must not be able to override it);
//   - every GIT_ name, in a key, in the key list (escapes decoded, any letter case) or anywhere in the literal's text, drawn from a CLOSED list of three that cannot
//     point git at a repository (SAFE_GIT_KEYS). A positive list, never "delete the bad ones": GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and a variable git invents
//     tomorrow are refused alike.
// The judge reads TOKENS (scripts/lib/js-lex.mjs), not text: a regex literal holding a quote, a template holding a backtick or a comment holding the NOSYSTEM literal
// can neither hide an entry nor fake one (08d, witnesses F28 and F41). F41 is met with a TOKENIZER, not a narrower grammar, because the canon's own sandboxEnv
// (release-notes.test.mjs at blob 7e779ef8) carries a regex literal in a value and must pass with no pin.
//
// A NAME is also tied to its declaration (08d, F31 to F40): the identifier an `env:` property reads must be declared once, in a scope the spawn sits inside, and
// be mentioned nowhere else except as the value of an `env` property inside a child_process call. A parameter, a second declaration, an alias (`const a = env`), a
// call that takes it (`fill(env)`, `Reflect.set(env, ...)`, `Object(env)`) or a method on it (`env.__defineGetter__(...)`) is a finding. The old direct-mutation scan
// stays beside it as the sharper message.
//
// And a NAME is no longer trusted: gitEnv/gitTestEnv are trusted only when the file IMPORTS it from the room's own scripts/lib/git-env.mjs, the specifier resolved from the importing file's path (F42; the 08d INSPECT LOW). A file that defines its own helper of that
// name is judged on the helper's body (an allowlist literal passes as a helper), otherwise it needs a blob-pinned row.
//
// What this still does not see, named: a callee or an env object reached by a path the tokens do not show (a value returned from a call, a property of another object,
// a mutation through a function the env is passed to under another spelling), and a hole in the tokenizer's regex-or-division guess (js-lex.mjs states it).
const SAFE_GIT_KEYS = new Set(['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_CEILING_DIRECTORIES']);
const isSafeGitName = (k) => !/^git_/i.test(k) || SAFE_GIT_KEYS.has(k.toUpperCase());
// 08c unit 2 (the 08d INSPECT LOW): the trusted helper is ONE file of THIS room, scripts/lib/git-env.mjs, and the import specifier is resolved against the importing file's own path.
// A basename test trusted a git-env.mjs of any tree, a bare 'git-env.mjs' and a URL; the room has no git-test-env.mjs, so gitTestEnv is not a trusted name here (canon carriers of
// other rooms that import it are judged as any local helper: by its body, or by a pinned row).
const TRUSTED_HELPER_NAMES = new Set(['gitEnv']);
const TRUSTED_HELPER_FILE = 'scripts/lib/git-env.mjs';
const isRoomHelperSpecifier = (label, spec) => {
  if (typeof spec !== 'string' || !(spec.startsWith('./') || spec.startsWith('../'))) return false;
  return path.posix.normalize(path.posix.join(path.posix.dirname(String(label).replace(/\\/g, '/')), spec)) === TRUSTED_HELPER_FILE;
};
const OPEN = { '(': ')', '[': ']', '{': '}' };

// Pair every bracket (and template hole) of the code tokens and record the innermost opener before each token; null when the brackets do not balance.
function indexTokens(ct) {
  const pair = new Array(ct.length).fill(-1);
  const encl = new Array(ct.length).fill(-1);
  const stack = [];
  for (let k = 0; k < ct.length; k++) {
    const t = ct[k];
    const closer = t.t === 'tpl-close' || (t.t === 'punct' && (t.v === ')' || t.v === ']' || t.v === '}'));
    if (closer) {
      const o = stack.pop();
      if (o === undefined) return null;
      const want = ct[o].t === 'tpl-open' ? 'tpl-close' : OPEN[ct[o].v];
      if (t.t === 'tpl-close' ? want !== 'tpl-close' : want !== t.v) return null;
      pair[o] = k;
      pair[k] = o;
      encl[k] = stack.length ? stack[stack.length - 1] : -1;
      continue;
    }
    encl[k] = stack.length ? stack[stack.length - 1] : -1;
    if (t.t === 'tpl-open' || (t.t === 'punct' && OPEN[t.v])) stack.push(k);
  }
  return stack.length ? null : { pair, encl };
}

const isOpener = (t) => t.t === 'tpl-open' || (t.t === 'punct' && OPEN[t.v] !== undefined);
const isP = (t, v) => t !== undefined && t.t === 'punct' && t.v === v;
const isId = (t, v) => t !== undefined && t.t === 'id' && (v === undefined || t.v === v);

// The top-level pieces of ct[from..to): [start, end) token ranges separated by commas that sit outside every bracket.
function splitTop(F, from, to) {
  const out = [];
  let s = from;
  for (let k = from; k < to; k++) {
    const t = F.ct[k];
    if (isOpener(t)) { k = F.idx.pair[k]; continue; }
    if (isP(t, ',')) { out.push([s, k]); s = k + 1; }
  }
  out.push([s, to]);
  return out;
}

const srcOf = (F, a, b) => (b > a ? F.text.slice(F.ct[a].s, F.ct[b - 1].e) : '');
const joined = (F, a, b) => F.ct.slice(a, b).map((t) => t.v).join(' ');
const lineAt = (F, k) => lineOf(F.text, F.ct[k].s);

// The text of the tokens a..b with comments blanked, for the raw GIT_ scan.
function textNoComments(F, a, b) {
  let s = F.text.slice(F.ct[a].s, F.ct[b - 1].e);
  const base = F.ct[a].s;
  for (const t of F.comments) {
    if (t.s >= base && t.e <= base + s.length) s = s.slice(0, t.s - base) + ' '.repeat(t.e - t.s) + s.slice(t.e - base);
  }
  return s;
}

// The first statement after the declaration that changes NAME: a property write, an index write, Object.assign/defineProperty on it, a delete; for a key list
// (array = true) also the array methods that grow or rewrite it. A write to process.env.X is a write to someone else's object, so a name preceded by a dot never counts.
function mutationOf(name, fileText, array = false) {
  const n = escapeRegex(name);
  const forms = [
    String.raw`(?<![.\w$])${n}\s*\.\s*[\w$]+\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`(?<![.\w$])${n}\s*\[[^\]\n]*\]\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(\s*${n}\b`,
    String.raw`\bdelete\s+${n}\b`,
  ];
  if (array) forms.push(String.raw`(?<![.\w$])${n}\s*\.\s*(?:push|unshift|splice|fill|copyWithin|sort|reverse|pop|shift)\s*\(`);
  return new RegExp(forms.join('|')).exec(fileText);
}

// Where (token indexes) is NAME declared with const/let/var, and where is it mentioned at all (a name after a dot is a property, not the binding)?
function declsOf(F, name) {
  const out = [];
  for (let k = 1; k < F.ct.length; k++) {
    const t = F.ct[k];
    if (t.t !== 'id' || decodeIdent(t.v) !== name) continue;
    const p = F.ct[k - 1];
    if (p.t === 'id' && (p.v === 'const' || p.v === 'let' || p.v === 'var' || p.v === 'function' || p.v === 'class')) out.push({ k, kind: p.v });
  }
  return out;
}

// Is the use at token `use` inside the scope of the declaration at token `decl`? The scope is the innermost `{` block around the declaration (the module when there is none).
function inScope(F, decl, use) {
  let o = F.idx.encl[decl];
  while (o !== -1 && !isP(F.ct[o], '{')) o = F.idx.encl[o];
  if (o === -1) return true;
  return use > o && use < F.idx.pair[o];
}

// Does the statement that ends at token `last` end there? A semicolon, a comma, the end of the file, or a line break NOT followed by a token that would continue the expression.
const CONTINUES = new Set(['.', '(', '[', '?', '?.', '+', '-', '*', '/', '%', '**', '||', '&&', '??', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '|', '&', '^', ',', '=>']);
function statementEnds(F, last) {
  const next = F.ct[last + 1];
  if (next === undefined) return true;
  if (isP(next, ';') || isP(next, ',')) return true;
  if (next.t === 'tpl') return false;
  const gap = F.text.slice(F.ct[last].e, next.s);
  if (!gap.includes('\n')) return isP(next, '}');
  return !(next.t === 'punct' && CONTINUES.has(next.v));
}

// ---- the judges -----------------------------------------------------------------------------------------------------------------------------------------------

const ok = (kind) => ({ ok: true, kind });
const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// verify.mjs loads the helper at run time from the room root: `import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'git-env.mjs')).href)`. That one idiom is read: the trailing
// literal segments must spell the room helper's path. Named limit: ROOT is an identifier the census cannot resolve, so it is taken to be the room root (verify.mjs's own `repo`).
function isRoomHelperJoin(F, a, b) {
  const ct = F.ct;
  let k = a;
  if (!(isId(ct[k], 'pathToFileURL') && isP(ct[k + 1], '('))) return false;
  const urlClose = F.idx.pair[k + 1];
  if (!(isP(ct[urlClose + 1], '.') && isId(ct[urlClose + 2], 'href') && urlClose + 3 === b)) return false;
  k += 2;
  if (isId(ct[k], 'path') && isP(ct[k + 1], '.')) k += 2;
  if (!(isId(ct[k], 'join') && isP(ct[k + 1], '('))) return false;
  if (F.idx.pair[k + 1] !== urlClose - 1) return false;
  const parts = splitTop(F, k + 2, urlClose - 1);
  if (parts.length < 2 || !(parts[0][1] === parts[0][0] + 1 && ct[parts[0][0]].t === 'id')) return false;
  const segs = [];
  for (const [ps, pe] of parts.slice(1)) {
    if (!(pe === ps + 1 && ct[ps].t === 'str')) return false;
    const v = decodeString(ct[ps].v);
    if (v === null) return false;
    segs.push(v);
  }
  return segs.join('/') === TRUSTED_HELPER_FILE;
}

// Is `name` bound to the room's own helper by an import? A static import, or a dynamic one whose call names it, of the file scripts/lib/git-env.mjs reached from THIS file's path.
function importedFromRoomHelper(F, name) {
  const ct = F.ct;
  for (let k = 0; k < ct.length; k++) {
    if (!isId(ct[k], 'import')) continue;
    if (isP(ct[k + 1], '{')) {
      const close = F.idx.pair[k + 1];
      const ids = ct.slice(k + 2, close).filter((t) => t.t === 'id').map((t) => t.v);
      const from = ct[close + 1];
      const spec = ct[close + 2];
      if (!(isId(from, 'from') && spec && spec.t === 'str')) continue;
      const names = ids.filter((v, i) => v !== 'as' && ids[i - 1] !== 'as');
      const renamed = ids.some((v, i) => ids[i + 1] === 'as' && v === name);
      if (names.includes(name) && !renamed && isRoomHelperSpecifier(F.label, decodeString(spec.v))) return true;
    } else if (isP(ct[k + 1], '(')) {
      const close = F.idx.pair[k + 1];
      const prev = ct[k - 1];
      const eq = ct[k - 2];
      const brace = ct[k - 3];
      if (!(isId(prev, 'await') && isP(eq, '=') && isP(brace, '}'))) continue;
      const open = F.idx.pair[k - 3];
      // 08d mutation finding: `{ other: gitEnv }` BINDS gitEnv to another export, so only the bare shorthand `{ gitEnv }` counts
      const shorthand = splitTop(F, open + 1, k - 3).some(([s, e]) => e === s + 1 && ct[s].t === 'id' && decodeIdent(ct[s].v) === name);
      if (!shorthand) continue;
      if (close === k + 3 && ct[k + 2].t === 'str' && isRoomHelperSpecifier(F.label, decodeString(ct[k + 2].v))) return true;
      if (isRoomHelperJoin(F, k + 2, close)) return true;
    }
  }
  return false;
}

// The occurrences of an identifier that are neither a property (after a dot) nor in the declaration list.
function mentions(F, name) {
  const out = [];
  for (let k = 0; k < F.ct.length; k++) {
    const t = F.ct[k];
    if (t.t !== 'id' || decodeIdent(t.v) !== name) continue;
    if (isP(F.ct[k - 1], '.') || isP(F.ct[k - 1], '?.')) continue;
    out.push(k);
  }
  return out;
}

// A same-file helper `const NAME = (params) => ({ ... })` or `function NAME(params) { return { ... }; }`: the literal's range, or a reason.
function helperLiteral(F, name) {
  const defs = [];
  for (let k = 0; k < F.ct.length; k++) {
    const t = F.ct[k];
    if (t.t !== 'id' || decodeIdent(t.v) !== name || isP(F.ct[k - 1], '.')) continue;
    const p = F.ct[k - 1];
    if (p && p.t === 'id' && (p.v === 'const' || p.v === 'let' || p.v === 'var' || p.v === 'function' || p.v === 'class')) defs.push({ k, kind: p.v });
  }
  if (defs.length === 0) return { reason: `${name} is not defined in this file, so the census cannot read what it returns` };
  if (defs.length > 1) return { reason: `${name} is declared ${defs.length} times in this file, so the census cannot tell which one the call reads` };
  const stray = mentions(F, name).filter((k) => k !== defs[0].k && !isP(F.ct[k + 1], '('));
  if (stray.length) return { reason: `${name} is mentioned other than as a call (line ${lineAt(F, stray[0])}), so a parameter or a reassignment may stand in for the helper` };
  const d = defs[0];
  let bodyStart;
  let bodyEnd;
  if (d.kind === 'function') {
    if (!isP(F.ct[d.k + 1], '(')) return { reason: `${name} is not a plain function declaration` };
    const pc = F.idx.pair[d.k + 1];
    if (!isP(F.ct[pc + 1], '{')) return { reason: `${name} has no block body` };
    bodyStart = pc + 1;
    bodyEnd = F.idx.pair[pc + 1];
  } else if (d.kind === 'const') {
    if (!isP(F.ct[d.k + 1], '=')) return { reason: `${name} is not assigned in its declaration` };
    let a = d.k + 2;
    if (isId(F.ct[a], 'async')) return { reason: `${name} is an async function, which the census does not read` };
    if (isP(F.ct[a], '(')) a = F.idx.pair[a] + 1;
    else if (F.ct[a] && F.ct[a].t === 'id') a += 1;
    else return { reason: `${name} is not an arrow function` };
    if (!isP(F.ct[a], '=>')) return { reason: `${name} is not an arrow function` };
    a += 1;
    if (isP(F.ct[a], '(') && isP(F.ct[a + 1], '{') && F.idx.pair[a + 1] === F.idx.pair[a] - 1) {
      const lit = [a + 1, F.idx.pair[a + 1]];
      if (!statementEnds(F, F.idx.pair[a])) return { reason: `${name}'s body has more after the object` };
      return { range: lit };
    }
    if (!isP(F.ct[a], '{')) return { reason: `${name}'s body is not one object literal` };
    bodyStart = a;
    bodyEnd = F.idx.pair[a];
  } else return { reason: `${name} is declared with ${d.kind}, which the census does not read as a helper` };
  // a block body: `return { ... } ;` and nothing else
  if (!isId(F.ct[bodyStart + 1], 'return') || !isP(F.ct[bodyStart + 2], '{')) return { reason: `${name}'s body is not a single return of one object literal` };
  const litClose = F.idx.pair[bodyStart + 2];
  let after = litClose + 1;
  if (isP(F.ct[after], ';')) after += 1;
  if (after !== bodyEnd) return { reason: `${name}'s body does more than return one object literal` };
  return { range: [bodyStart + 2, litClose] };
}

// ---- the allowlist literal ------------------------------------------------------------------------------------------------------------------------------------

// KEYS: a const array of string literals, declared once, never changed, used only as the head of a .filter(/.map( chain.
function keyListVerdict(F, name, useTok) {
  const decls = declsOf(F, name);
  if (decls.length !== 1) return no(`the key list ${name} is declared ${decls.length} times in this file, and it must be exactly once`);
  const d = decls[0];
  if (d.kind !== 'const') return no(`the key list ${name} is not declared with const`);
  if (!isP(F.ct[d.k + 1], '=') || !isP(F.ct[d.k + 2], '[')) return no(`the key list ${name} is not declared \`const ${name} = [...]\``);
  const open = d.k + 2;
  const close = F.idx.pair[open];
  for (let k = open + 1; k < close; k++) {
    const t = F.ct[k];
    if (isP(t, ',')) continue;
    if (t.t !== 'str') return no(`the key list ${name} holds more than plain string literals`);
    const v = decodeString(t.v);
    if (v === null) return no(`the key list ${name} holds a string the census cannot decode`);
    if (!isSafeGitName(v)) return no(`the key list ${name} names ${v}, which is not one of the harmless GIT_ names (${[...SAFE_GIT_KEYS].join(', ')})`);
  }
  if (!statementEnds(F, close)) return no(`the key list ${name} is declared with more after the array`);
  for (const k of mentions(F, name)) {
    if (k === d.k) continue;
    if (!(isP(F.ct[k + 1], '.') && F.ct[k + 2] && F.ct[k + 2].t === 'id' && (F.ct[k + 2].v === 'filter' || F.ct[k + 2].v === 'map') && isP(F.ct[k + 3], '('))) {
      return no(`the key list ${name} is used other than as the head of a .filter or .map chain (line ${lineAt(F, k)})`);
    }
  }
  const changed = mutationOf(name, F.text, true);
  if (changed) return no(`the key list ${name} is changed after it is declared (line ${lineOf(F.text, changed.index)})`);
  if (!inScope(F, d.k, useTok)) return no(`the key list ${name} is declared in a block the literal is not inside`);
  return ok('keylist');
}

// ARROW: `( k ) => BODY` or `k => BODY`; returns { param, bodyStart } or null.
function arrowAt(F, a, to) {
  let param;
  let k = a;
  if (isP(F.ct[k], '(') && F.ct[k + 1] && F.ct[k + 1].t === 'id' && isP(F.ct[k + 2], ')')) { param = F.ct[k + 1].v; k += 3; }
  else if (F.ct[k] && F.ct[k].t === 'id') { param = F.ct[k].v; k += 1; }
  else return null;
  if (!isP(F.ct[k], '=>') || k + 1 > to) return null;
  return { param, bodyStart: k + 1 };
}

// ...Object.fromEntries(KEYS[.filter(ARROW)].map(ARROW)): the one spread an allowlist may carry.
function spreadVerdict(F, a, b) {
  const j = joined(F, a, a + 4);
  if (j !== 'Object . fromEntries (' || F.idx.pair[a + 3] !== b - 1) {
    return no(`spreads ${srcOf(F, a, Math.min(b, a + 6)).slice(0, 30)}, which is not a list of named keys: the only spread read is ...Object.fromEntries(KEYS.filter(...).map(...))`);
  }
  let k = a + 4;
  const end = b - 1; // the closing paren of fromEntries
  const head = F.ct[k];
  if (!head || head.t !== 'id') return no('its Object.fromEntries( does not start from a named key list');
  const keysTok = k;
  k += 1;
  const chain = (name) => {
    if (!(isP(F.ct[k], '.') && isId(F.ct[k + 1], name) && isP(F.ct[k + 2], '('))) return null;
    const close = F.idx.pair[k + 2];
    const arrow = arrowAt(F, k + 3, close);
    if (!arrow) return null;
    const body = joined(F, arrow.bodyStart, close);
    const p = arrow.param;
    k = close + 1;
    return { p, body };
  };
  let f = null;
  if (isP(F.ct[k], '.') && isId(F.ct[k + 1], 'filter')) {
    f = chain('filter');
    if (!f || !(f.body === `process . env [ ${f.p} ] !== undefined` || f.body === `${f.p} in process . env`)) {
      return no('its .filter( is not the canon predicate process.env[k] !== undefined or k in process.env');
    }
  }
  const m = chain('map');
  if (!m || m.body !== `[ ${m.p} , process . env [ ${m.p} ] ]`) return no('its .map( is not the canon (k) => [k, process.env[k]]');
  if (k !== end) return no('its Object.fromEntries(...) chain has more after .map(...)');
  return keyListVerdict(F, F.ct[keysTok].v, keysTok);
}

// A value: process.env only by a named key, no computed index into a value.
function valueVerdict(F, a, b) {
  for (let k = a; k < b; k++) {
    const t = F.ct[k];
    if (t.t === 'id' && t.v === 'process') {
      if (isP(F.ct[k + 1], '.') && isId(F.ct[k + 2], 'env')) {
        const n = F.ct[k + 3];
        const named = (isP(n, '.') && F.ct[k + 4] && F.ct[k + 4].t === 'id') || (isP(n, '[') && F.ct[k + 4] && F.ct[k + 4].t === 'str' && isP(F.ct[k + 5], ']'));
        if (!named) return 'reads process.env other than by a named key (process.env.NAME or process.env["NAME"])';
      } else if (isP(F.ct[k + 1], '[')) return 'reaches process by a computed key';
    }
    if (isP(t, '[')) {
      const p = F.ct[k - 1];
      const isIndex = p && k > a && (p.t === 'id' || p.t === 'str' || p.t === 'num' || isP(p, ')') || isP(p, ']'));
      if (isIndex && !(F.ct[k + 1] && F.ct[k + 1].t === 'str' && isP(F.ct[k + 2], ']'))) return 'indexes a value by a computed key, which could name any variable of the environment';
    }
  }
  return null;
}

// The object literal ct[a..b] (a is its `{`, b its `}`) as an allowlist, or a reason.
function allowlistObject(F, a, b) {
  const span = textNoComments(F, a, b + 1);
  for (const m of span.matchAll(/\bgit_[\w$]*/gi)) {
    if (!isSafeGitName(m[0])) return no(`names ${m[0]}, which is not one of the harmless GIT_ names (${[...SAFE_GIT_KEYS].join(', ')})`);
  }
  let noSystem = -1;
  let noSystemCount = 0;
  let lastSpread = -1;
  const parts = splitTop(F, a + 1, b);
  for (let p = 0; p < parts.length; p++) {
    const [s, e] = parts[p];
    if (s >= e) continue; // a trailing comma
    const first = F.ct[s];
    if (isP(first, '...')) {
      const bad = spreadVerdict(F, s + 1, e);
      if (!bad.ok) return bad;
      lastSpread = p;
      continue;
    }
    if (isP(first, '[')) return no('has a computed key, which the census cannot read');
    let key;
    if (first.t === 'id') key = decodeIdent(first.v);
    else if (first.t === 'str') key = decodeString(first.v);
    else return no(`has a property the census cannot read (${srcOf(F, s, e).slice(0, 40)})`);
    if (key === null) return no('has a key the census cannot decode');
    if (key === '__proto__') return no('sets __proto__');
    if (!isSafeGitName(key)) return no(`names ${key}, which is not one of the harmless GIT_ names (${[...SAFE_GIT_KEYS].join(', ')})`);
    const shorthand = e === s + 1 && first.t === 'id';
    if (!shorthand && !isP(F.ct[s + 1], ':')) return no(`has a property the census cannot read (${srcOf(F, s, e).slice(0, 40)})`);
    const vs = shorthand ? e : s + 2;
    if (key.toUpperCase() === 'GIT_CONFIG_NOSYSTEM') {
      noSystemCount += 1;
      noSystem = p;
      const vt = F.ct[vs];
      const single = e === vs + 1 && vt && ((vt.t === 'str' && decodeString(vt.v) === '1') || (vt.t === 'num' && vt.v === '1'));
      if (!single) return no(`sets GIT_CONFIG_NOSYSTEM to ${srcOf(F, vs, e) || '(nothing)'}, and it must be the literal 1`);
    }
    const bad = valueVerdict(F, vs, e);
    if (bad) return no(bad);
  }
  if (noSystemCount === 0) return no('does not set GIT_CONFIG_NOSYSTEM to 1 (git reads the system config file whatever the env holds, so the list must switch it off)');
  if (noSystemCount > 1) return no('sets GIT_CONFIG_NOSYSTEM more than once, and the last one wins');
  if (noSystem < lastSpread) return no('sets GIT_CONFIG_NOSYSTEM before a spread, which can bring an ambient value that overrides it');
  return ok('allowlist');
}

// A whole-call env `NAME(...)` over ct[a..b): the room's imported helper, or a same-file helper that returns one allowlist literal.
function callVerdict(F, a, b) {
  const name = F.ct[a].v;
  if (TRUSTED_HELPER_NAMES.has(name) && importedFromRoomHelper(F, name) && declsOf(F, name).length === 0) {
    // the import is the only place the name may be bound: a parameter or a rebinding of it would be a different function
    const stray = mentions(F, name).filter((k) => {
      if (isP(F.ct[k + 1], '(')) return false;
      const o = F.idx.encl[k];
      const bindingList = o !== -1 && isP(F.ct[o], '{') && (isId(F.ct[F.idx.pair[o] + 1], 'from') || isP(F.ct[F.idx.pair[o] + 1], '='));
      return !bindingList;
    });
    if (!stray.length) return ok('gitEnv');
    return no(`${name} is mentioned other than as a call (line ${lineAt(F, stray[0])}), so a parameter or a rebinding may stand in for the room's helper`, { helper: true });
  }
  const h = helperLiteral(F, name);
  if (h.reason) {
    if (TRUSTED_HELPER_NAMES.has(name)) return no(`${name}() is a helper this file does not import from the room's git-env.mjs, and ${h.reason}; the census trusts the NAME ${name} only for the room's own helper (pin the file by blob id or import it)`, { helper: true });
    return no(h.reason, { helper: true });
  }
  const lit = allowlistObject(F, h.range[0], h.range[1]);
  if (!lit.ok) return no(`${name}() returns a literal that fails as an allowlist: ${lit.reason}`, { helper: true });
  return ok('helper');
}

// An identifier env over token k: its declaration, its mentions, its scope, and what it is assigned.
function aliasVerdict(F, name, spawnTok) {
  const decls = declsOf(F, name);
  if (decls.length === 0) return no(`is not declared \`const ${name} = gitEnv(...)\` in this file`, { alias: true });
  if (decls.length > 1) return no(`is declared ${decls.length} times in this file, so the census cannot tell which one the spawn reads`, { alias: true, attempted: true });
  const d = decls[0];
  const rhsFail = (reason, attempted) => no(`is not declared \`const ${name} = gitEnv(...)\` in this file`, { alias: true, attempted, note: reason });
  if (d.kind !== 'const') return no(`is declared with ${d.kind}, and only const cannot be reassigned`, { alias: true, attempted: true });
  if (!isP(F.ct[d.k + 1], '=')) return no(`is not assigned in its declaration`, { alias: true, attempted: true });
  const r0 = d.k + 2;
  const t0 = F.ct[r0];
  let verdict;
  let rhsEnd;
  if (isP(t0, '{')) {
    rhsEnd = F.idx.pair[r0];
    verdict = allowlistObject(F, r0, rhsEnd);
  } else if (t0 && t0.t === 'id' && isP(F.ct[r0 + 1], '(')) {
    rhsEnd = F.idx.pair[r0 + 1];
    verdict = callVerdict(F, r0, rhsEnd + 1);
  } else {
    return no(`is not declared \`const ${name} = gitEnv(...)\` in this file`, { alias: true });
  }
  if (!statementEnds(F, rhsEnd)) return no('is assigned from more than the bare expression', { alias: true, attempted: true });
  const changed = mutationOf(name, F.text);
  if (changed) return no(`is mutated after it is assigned (line ${lineOf(F.text, changed.index)})`, { alias: true, attempted: true });
  // every mention: the declaration, or the value of an `env` property inside a child_process call
  for (const k of mentions(F, name)) {
    if (k === d.k) continue;
    const prev = F.ct[k - 1];
    const next = F.ct[k + 1];
    const inObject = F.idx.encl[k] !== -1 && isP(F.ct[F.idx.encl[k]], '{');
    const isKey = inObject && isP(next, ':') && (isP(prev, '{') || isP(prev, ','));
    if (isKey) continue;
    const asValue = inObject && isP(prev, ':') && isId(F.ct[k - 2], 'env') || (inObject && isP(prev, ':') && F.ct[k - 2] && F.ct[k - 2].t === 'str' && decodeString(F.ct[k - 2].v) === 'env');
    const asShorthand = name === 'env' && inObject && (isP(prev, '{') || isP(prev, ',')) && (isP(next, ',') || isP(next, '}'));
    const inCall = F.callRanges.some(([lo, hi]) => k > lo && k < hi);
    if ((asValue || asShorthand) && inCall) continue;
    return no(`is used outside its declaration and a child_process env: property (line ${lineAt(F, k)}), so it may be copied, handed to a function or changed there`, { alias: true, attempted: true });
  }
  if (!inScope(F, d.k, spawnTok)) return no('is declared in a block the spawn is not inside, so the spawn reads a different binding', { alias: true, attempted: true });
  if (!verdict.ok) {
    if (verdict.helper) return no(`is not declared \`const ${name} = gitEnv(...)\` in this file`, { alias: true, attempted: true, note: verdict.reason });
    return rhsFail(verdict.reason, isP(t0, '{'));
  }
  return verdict;
}

// The verdict for the env expression at ct[a..b), inside the spawn that opens at token `spawnTok`.
function exprVerdict(F, a, b, spawnTok) {
  const t0 = F.ct[a];
  if (a >= b) return no('(empty)');
  if (isP(t0, '{') && F.idx.pair[a] === b - 1) return allowlistObject(F, a, b - 1);
  if (t0.t === 'id' && isP(F.ct[a + 1], '(') && F.idx.pair[a + 1] === b - 1) return callVerdict(F, a, b);
  if (t0.t === 'id' && b === a + 1) return aliasVerdict(F, t0.v, spawnTok);
  return no('');
}

const mentionsProcessEnv = (F, a, b) => {
  for (let k = a; k < b; k++) {
    if (!isId(F.ct[k], 'process')) continue;
    if (isP(F.ct[k + 1], '.') && isId(F.ct[k + 2], 'env')) return true;
    if (isP(F.ct[k + 1], '[') && F.ct[k + 2] && F.ct[k + 2].t === 'str' && decodeString(F.ct[k + 2].v) === 'env') return true;
  }
  return false;
};

// The env property of a spawn call, or the finding that says why there is not exactly one.
function envProps(F, open, close) {
  const found = [];
  for (let k = open + 1; k < close; k++) {
    const t = F.ct[k];
    if (isP(t, '[') && F.ct[k + 1] && F.ct[k + 1].t === 'str' && decodeString(F.ct[k + 1].v) === 'env' && isP(F.ct[k + 2], ']') && isP(F.ct[k + 3], ':')
      && (isP(F.ct[k - 1], '{') || isP(F.ct[k - 1], ',')) && F.idx.encl[k] !== -1 && isP(F.ct[F.idx.encl[k]], '{')) {
      found.push({ k, obj: F.idx.encl[k], start: k + 4, end: k + 5, shorthand: false, computed: true });
      continue;
    }
    const name = t.t === 'id' ? decodeIdent(t.v) : t.t === 'str' ? decodeString(t.v) : null;
    if (name !== 'env') continue;
    const o = F.idx.encl[k];
    if (o === -1 || !isP(F.ct[o], '{') || o < open) continue;
    const prev = F.ct[k - 1];
    const next = F.ct[k + 1];
    if (!(isP(prev, '{') || isP(prev, ','))) continue;
    if (isP(next, ':')) {
      let e = k + 2;
      const stop = F.idx.pair[o];
      while (e < stop) {
        if (isOpener(F.ct[e])) { e = F.idx.pair[e] + 1; continue; }
        if (isP(F.ct[e], ',')) break;
        e += 1;
      }
      found.push({ k, obj: o, start: k + 2, end: e, shorthand: false });
    } else if (t.t === 'id' && (isP(next, ',') || isP(next, '}'))) {
      found.push({ k, obj: o, start: k, end: k + 1, shorthand: true });
    }
  }
  return found;
}

// null = the env is safe by the room's own helper alone; { allowlist: true, kind, expr } = a sound allowlist; otherwise { why, expr }.
function envVerdict(F, open, close) {
  const props = envProps(F, open, close);
  if (props.length === 0) return { why: "carries no 'env:' -- every git child must take env: gitEnv(...) (CWK-133)", expr: null };
  const p = props[props.length - 1];
  const expr = p.shorthand ? 'env' : srcOf(F, p.start, p.end).trim();
  if (props.length > 1) return { why: `has ${props.length} env properties, and the last one wins -- the census will not guess which`, expr };
  if (p.computed) return { why: `sets env through a computed key, which the census cannot read -- spell it env: (CWK-136)`, expr };
  // the env: property must sit in the spawn's OWN options object, not in an object a helper call will merge with another
  if (F.idx.encl[p.obj] !== open) return { why: `the env: property is inside an object that is not an argument of the spawn itself (a call or an array wraps it), so another argument can override it -- take env from gitEnv(...) alone (CWK-136)`, expr };
  // nothing else in that object may be, or look like, a second env: a getter, a computed key, the name again
  for (let k = p.obj + 1; k < F.idx.pair[p.obj]; k++) {
    if (isOpener(F.ct[k])) {
      if (isP(F.ct[k], '[') && (isP(F.ct[k - 1], '{') || isP(F.ct[k - 1], ','))) return { why: `the options object has a computed key, which can be env -- take env from gitEnv(...) alone (CWK-136)`, expr };
      k = F.idx.pair[k];
      continue;
    }
    const t = F.ct[k];
    const name = t.t === 'id' ? decodeIdent(t.v) : t.t === 'str' ? decodeString(t.v) : null;
    if (name === 'env' && k !== p.k && !(k >= p.start && k < p.end) && !isP(F.ct[k - 1], '.')) return { why: `the options object mentions env more than once (line ${lineAt(F, k)}) -- the census will not guess which one wins`, expr };
  }
  // a spread AFTER the env property can bring its own env: and override this one
  const stop = F.idx.pair[p.obj];
  for (let k = p.end; k < stop; k++) {
    if (isOpener(F.ct[k])) { k = F.idx.pair[k]; continue; }
    if (isP(F.ct[k], '...')) return { why: `the options object spreads another object after env:, and that object can carry its own env: -- take env from gitEnv(...) alone (CWK-136)`, expr };
  }
  const v = p.shorthand ? aliasVerdict(F, 'env', open) : exprVerdict(F, p.start, p.end, open);
  if (v.ok) return v.kind === 'gitEnv' ? null : { allowlist: true, kind: v.kind, expr };
  const note = v.alias ? (v.note || '') : (v.reason || '');
  const allowNote = note ? `; as an allowlist env it fails: ${note}` : '';
  if (v.alias) return { why: `env: ${expr} ${v.reason}${allowNote} -- take env from gitEnv(...) alone (CWK-136)`, expr };
  if (mentionsProcessEnv(F, p.start, p.end)) {
    return { why: `env: ${expr} mentions process.env -- a git child inherits a hook's absolute GIT_DIR that way; take env from gitEnv(...) alone (CWK-136)${allowNote}`, expr };
  }
  return { why: `env: ${expr || '(empty)'} is not produced by gitEnv() alone -- the whole expression must be a call to it, or a const assigned from exactly that call (CWK-136)${allowNote}`, expr };
}

// ---- the census -----------------------------------------------------------------------------------------------------------------------------------------------

function fileContext(label, text) {
  const lx = lex(text);
  if (lx.error) return { error: `${label}:${lineOf(text, lx.at)} could not be tokenized (${lx.error}) -- the census cannot vouch for a file it cannot read whole` };
  const ct = codeTokens(lx.tokens);
  const idx = indexTokens(ct);
  if (!idx) return { error: `${label} has brackets that do not balance -- the census cannot vouch for a file it cannot read whole` };
  return { label, text, tokens: lx.tokens, comments: lx.tokens.filter((t) => t.t === 'comment'), ct, idx, callRanges: [] };
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
    const hits = [...text.matchAll(b.re)];
    if (!hits.length) continue;
    const F = fileContext(label, text);
    if (F.error) { findings.push(F.error); continue; }
    // every child_process call that is code (not text in a comment, a string, a regex or a template), with its parens as token indexes
    const calls = [];
    for (const m of hits) {
      if (inNonCode(F.tokens, m.index)) continue;
      const openChar = m.index + m[0].length - 1;
      const open = F.ct.findIndex((t) => t.s === openChar);
      const close = open === -1 ? -1 : F.idx.pair[open];
      calls.push({ m, open, close });
      if (open !== -1 && close !== -1) F.callRanges.push([open, close]);
    }
    for (const { m, open, close } of calls) {
      const fn = m.groups.qfn || m.groups.ifn || b.locals.get(m.groups.loc);
      const line = lineOf(text, m.index);
      if (open === -1 || close === -1) {
        findings.push(`${label}:${line} unbalanced parens reading a ${fn}(...) call -- the census cannot vouch for it`);
        continue;
      }
      const args = splitTop(F, open + 1, close);
      const [fs0, fe0] = args[0];
      const firstSrc = srcOf(F, fs0, fe0).replace(/\s+/g, '');
      if (firstSrc === 'process.execPath') { nodeChildren++; continue; }
      const ft = F.ct[fs0];
      // a string is read twice, as written and with its escapes resolved: 'g\x69t' is git, and so is a Windows path whose backslashes were never doubled
      const variants = (t) => {
        if (t.t === 'str') { const d = decodeString(t.v); return d === null ? [t.v.slice(1, -1)] : [...new Set([t.v.slice(1, -1), d])]; }
        if (t.t === 'tpl' && t.v.startsWith('`') && t.v.endsWith('`') && t.v.length >= 2 && !t.v.endsWith('${')) return [t.v.slice(1, -1)];
        return null;
      };
      const cmds = fe0 === fs0 + 1 ? variants(ft) : null;
      if (cmds === null) {
        // 08d: a COMMAND row (command: the first argument's source) pins ONE non-literal command in one byte-equal carrier, by blob id and count -- never a blanket pass for a file
        const cmdSrc = normalise(srcOf(F, fs0, fe0));
        const sameCmd = (e) => e.command !== undefined && e.label === label && normalise(e.command) === cmdSrc;
        const exC = exemptions.find((e) => sameCmd(e) && (e.blob === undefined || blobId(text) === e.blob));
        if (exC) {
          const n = (matched.get(exC) || 0) + 1;
          matched.set(exC, n);
          const entry = { label, line, fn, exempt: true };
          gitSpawns.push(entry);
          if (n <= (exC.count ?? 1)) { exempt.push({ label, line, expr: `command ${cmdSrc}`, reason: exC.reason }); continue; }
          findings.push(`${label}:${line} ${fn}(...) command ${cmdSrc} matches the exemption for ${exC.label}, which allows ${exC.count ?? 1} spawn(s) -- this is spawn ${n}; a new spawn needs its own exemption`);
          continue;
        }
        const pinnedC = exemptions.find((e) => sameCmd(e));
        if (pinnedC) {
          findings.push(`${label}:${line} ${fn}(...) command ${cmdSrc} is exempt only at blob ${pinnedC.blob}, and this file's blob id is ${blobId(text)}: re-derive the row from the template or drop the pin with its reason`);
          continue;
        }
        findings.push(`${label}:${line} ${fn}(...) command is not a string literal or process.execPath -- the census cannot prove it is not git; spell the command as a literal`);
        continue;
      }
      const restStart = fe0 < close ? fe0 : close;
      const strs = (from, to) => {
        const out = [];
        for (let k = from; k < to; k++) {
          const vs = variants(F.ct[k]);
          if (vs) out.push(...vs);
        }
        return out;
      };
      const restSrc = srcOf(F, restStart, close);
      let isGit = false;
      if (SHELL_STRING_FNS.has(fn) || /\bshell\s*:(?!\s*false\b)/.test(restSrc)) { // (?!\s*false) not \s*(?!false): the latter backtracks off the space and reads `shell: false` as a shell
        // A command STRING run by a shell. With `shell:` set Node JOINS the arguments array into that command line, so git named only in the arguments is git too
        // (an array literal; a variable is named open).
        const second = args[1];
        const argStrings = second && isP(F.ct[second[0]], '[') ? strs(second[0], second[1]) : [];
        isGit = cmds.some((c) => shellMentionsGit(c)) || argStrings.some((x) => shellMentionsGit(x));
      } else if (cmds.some((c) => GIT_BASENAME.test(c.split(/[\\/]/).pop()))) isGit = true; // git, however the binary is spelled
      else if (cmds.some((c) => SHELLS.has(c.split(/[\\/]/).pop().toLowerCase()))) isGit = strs(restStart, close).some((x) => shellMentionsGit(x)); // sh -c '... git ...'
      if (!isGit) continue;
      const entry = { label, line, fn };
      gitSpawns.push(entry);
      const v = envVerdict(F, open, close);
      if (!v) continue;
      if (v.allowlist) {
        allowlist.push({ label, line, expr: normalise(v.expr), kind: v.kind });
        continue;
      }
      const sameSpawn = (e) => e.command === undefined && e.label === label && (e.expr === null ? v.expr === null : v.expr !== null && normalise(e.expr) === normalise(v.expr));
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
    .map((e) => ({ label: e.label, expr: e.command !== undefined ? `command ${e.command}` : e.expr, want: e.count ?? 1, matched: matched.get(e) || 0 }))
    .filter((e) => e.matched < e.want);
  return { findings, gitSpawns, exempt, allowlist, unusedExemptions, nodeChildren };
}
