// CWK-136 -- the git-spawn census. Does every `git` child this room spawns take its environment
// from gitEnv() (scripts/lib/git-env.mjs), and only from it?
//
// It proves SAFETY, not presence. CoalTipple's census (the exemplar) only tested that an `env:` key
// existed in the call, which passes `env: process.env` -- the exact hole CWK-133 closes: inside a
// linked worktree a git hook exports an absolute GIT_DIR, and a child that inherits it acts on the
// enclosing repository. Here a git spawn is refused when
//   (a) it carries no `env:` key at all, or
//   (b) its `env:` text mentions process.env AT ALL (a spread, a bare pass-through, a helper call
//       beside it), or
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

// The deliberate exemptions. Exact file label + exact env expression (whitespace-normalised) + the EXPECTED
// COUNT of spawns it covers (default 1): a further match fails the gate, fewer than the count fails it as
// stale. The reason is printed by the gate: keep it free of parentheses.
export const GIT_ENV_EXEMPTIONS = [
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
const escapeDollar = (x) => x.replace(/\$/g, '\\$');

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
    const ns = [...spaces].map(escapeDollar).join('|');
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
  if (spaces.size) alts.push(`(?<ns>${[...spaces].map(escapeDollar).join('|')})\\.(?:default\\.)?(?<qfn>${FNS.join('|')})`);
  if (locals.size) alts.push(`(?<loc>${[...locals.keys()].map(escapeDollar).join('|')})`);
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
  const decl = new RegExp(String.raw`\bconst\s+${escapeDollar(name)}\s*=\s*gitEnv\(`).exec(fileText);
  if (!decl) return 'is not declared `const ' + name + ' = gitEnv(...)` in this file';
  const open = decl.index + decl[0].length - 1;
  const close = findMatchingClose(fileText, open);
  if (close === -1 || !/^\s*(?:;|\n|,|$)/.test(fileText.slice(close + 1))) return 'is assigned from more than the bare gitEnv(...) call';
  const n = escapeDollar(name);
  const mutation = new RegExp([
    String.raw`\b${n}\s*\.\s*[\w$]+\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`\b${n}\s*\[[^\]\n]*\]\s*(?:\|\|=|&&=|\?\?=|\+=|-=|=(?!=))`,
    String.raw`\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(\s*${n}\b`,
    String.raw`\bdelete\s+${n}\b`,
  ].join('|')).exec(fileText);
  if (mutation) return 'is mutated after it is assigned (line ' + lineOf(fileText, mutation.index) + ')';
  return null;
}

// null = the env is gitEnv() alone; otherwise { why, expr }.
function envVerdict(callText, fileText) {
  const m = /\benv\s*:/.exec(callText);
  if (!m) return { why: "carries no 'env:' -- every git child must take env: gitEnv(...) (CWK-133)", expr: null };
  const expr = readExpr(callText, m.index + m[0].length, callText.length).trim();
  if (/\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/.test(expr)) {
    return { why: `env: ${expr} mentions process.env -- a git child inherits a hook's absolute GIT_DIR that way; take env from gitEnv(...) alone (CWK-136)`, expr };
  }
  if (isWholeGitEnvCall(expr)) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const bad = aliasVerdict(expr, fileText);
    return bad ? { why: `env: ${expr} ${bad} -- take env from gitEnv(...) alone (CWK-136)`, expr } : null;
  }
  return { why: `env: ${expr || '(empty)'} is not produced by gitEnv() alone -- the whole expression must be a call to it, or a const assigned from exactly that call (CWK-136)`, expr };
}

export function censusGitSpawns(files, { exemptions = GIT_ENV_EXEMPTIONS } = {}) {
  const findings = [];
  const gitSpawns = [];
  const exempt = [];
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
      const first = readExpr(callText, 1, callText.length).trim();
      if (first === 'process.execPath') { nodeChildren++; continue; }
      const lit = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1$/.exec(first);
      if (!lit) {
        findings.push(`${label}:${line} ${fn}(...) command is not a string literal or process.execPath -- the census cannot prove it is not git; spell the command as a literal`);
        continue;
      }
      const cmd = lit[2];
      const rest = callText.slice(1 + first.length);
      const base = cmd.split(/[\\/]/).pop();
      let isGit = false;
      if (SHELL_STRING_FNS.has(fn) || /\bshell\s*:(?!\s*false\b)/.test(rest)) { // (?!\s*false) not \s*(?!false): the latter backtracks off the space and reads `shell: false` as a shell
        // A command STRING run by a shell. With `shell:` set Node JOINS the arguments array into that
        // command line, so git named only in the arguments is git too (an array literal; a variable is named open).
        const second = readExpr(callText, 2 + first.length, callText.length).trim();
        const argStrings = second.startsWith('[') ? (second.match(STRING_RE) || []) : [];
        isGit = shellMentionsGit(cmd) || argStrings.some((s) => shellMentionsGit(s.slice(1, -1)));
      } else if (GIT_BASENAME.test(base)) isGit = true; // git, however the binary is spelled
      else if (SHELLS.has(base.toLowerCase())) isGit = (rest.match(STRING_RE) || []).some((s) => shellMentionsGit(s.slice(1, -1))); // sh -c '... git ...'
      if (!isGit) continue;
      const entry = { label, line, fn };
      gitSpawns.push(entry);
      const v = envVerdict(callText, text);
      if (!v) continue;
      const ex = exemptions.find((e) => e.label === label && v.expr !== null && normalise(e.expr) === normalise(v.expr));
      if (ex) {
        const want = ex.count ?? 1;
        const n = (matched.get(ex) || 0) + 1;
        matched.set(ex, n);
        if (n <= want) {
          entry.exempt = true;
          exempt.push({ label, line, expr: normalise(v.expr), reason: ex.reason });
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
  return { findings, gitSpawns, exempt, unusedExemptions, nodeChildren };
}
