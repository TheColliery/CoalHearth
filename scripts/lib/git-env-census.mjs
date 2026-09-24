// CWK-136 -- the git-spawn census. Does every `git` child this room spawns take its environment
// from gitEnv() (scripts/lib/git-env.mjs), and only from it?
//
// It proves SAFETY, not presence. CoalTipple's census (the exemplar) only tested that an `env:` key
// existed in the call, which passes `env: process.env` -- the exact hole CWK-133 closes: inside a
// linked worktree a git hook exports an absolute GIT_DIR, and a child that inherits it acts on the
// enclosing repository. Here a git spawn is refused when
//   (a) it carries no `env:` key at all, or
//   (b) its `env:` text mentions process.env AT ALL -- a spread, a bare pass-through, or a helper
//       call beside it (`{ ...gitEnv(), ...process.env }` re-adds every GIT_* key by ordering), or
//   (c) its `env:` is not produced by gitEnv(): a call to it, or an identifier assigned from it in
//       the same file (`const NAME = gitEnv(...)`).
// (b) is stricter than "process.env without the helper" on purpose; the helper is the ONLY place
// process.env is read for a git child.
//
// It is TEXTUAL, not a parser, and its bounds are named rather than hidden:
//   - it reads WHICH names a file binds from child_process (a destructured import or require, an
//     `as` alias, or a whole-module binding used as `cp.spawnSync(`) and considers only calls to
//     THOSE names. A file that never binds child_process is skipped whole, so prose such as a
//     parenthesised plural in a message string can never read as a call. A call form it cannot see
//     is not covered: a wrapper function around git, or a callee fetched some other way. It DOES
//     refuse the common unsafe unknown: a spawn whose first argument is neither a string literal
//     nor process.execPath, since it cannot be proven not to be git.
//   - a `//` comment or a `*` block-comment line is skipped; a call inside a multi-line block
//     comment that does not start its lines with `*`, or inside a string, would be misread.
//   - a node child (process.execPath) is COUNTED and left alone: it is not a git spawn, and the
//     gates it runs strip their own git children.
//
// Pure: a list of { label, text } in, a report out, so it is unit-tested red-first without a clone.
// The enumeration is NOT walked here -- scripts/verify.mjs feeds it the same surfaces the pointer
// gate walks (see the wiring there).
const FNS = ['spawnSync', 'execFileSync', 'spawn', 'execFile', 'execSync', 'exec'];
const SHELL_STRING_FNS = new Set(['execSync', 'exec']);
const STRING_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const CP_MOD = String.raw`['"](?:node:)?child_process['"]`;
const DESTRUCTURED_RE = new RegExp(String.raw`\{([^}]*)\}\s*(?:=\s*(?:await\s+import|require)\(\s*|from\s*)` + CP_MOD, 'g');
const NS_IMPORT_RE = new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*` + CP_MOD, 'g');
const NS_REQUIRE_RE = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+import|require)\(\s*` + CP_MOD, 'g');
const escapeDollar = (x) => x.replace(/\$/g, '\\$');

// Which names does this file bind from child_process? locals: local name -> the real function
// (`{ spawnSync as run }` maps run -> spawnSync); spaces: whole-module bindings, used as
// `cp.spawnSync(`. Returns { locals, re } where re finds the calls, or null when the file binds
// nothing (then there is nothing to census). Named groups: qfn = the function of a qualified call,
// loc = the local name of a bare call.
function bindingsOf(text) {
  const locals = new Map();
  for (const m of text.matchAll(DESTRUCTURED_RE)) {
    for (const part of m[1].split(',')) {
      const [canon, local] = part.trim().split(/\s+as\s+|\s*:\s*/);
      if (FNS.includes(canon)) locals.set((local || canon).trim(), canon);
    }
  }
  const spaces = new Set();
  for (const m of text.matchAll(NS_IMPORT_RE)) spaces.add(m[1]);
  for (const m of text.matchAll(NS_REQUIRE_RE)) spaces.add(m[1]);
  const alts = [];
  if (spaces.size) alts.push(`(?<ns>${[...spaces].map(escapeDollar).join('|')})\\.(?<qfn>${FNS.join('|')})`);
  if (locals.size) alts.push(`(?<loc>${[...locals.keys()].map(escapeDollar).join('|')})`);
  if (!alts.length) return null;
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

function envVerdict(callText, fileText) {
  const m = /\benv\s*:/.exec(callText);
  if (!m) return "carries no 'env:' -- every git child must take env: gitEnv(...) (CWK-133)";
  const expr = readExpr(callText, m.index + m[0].length, callText.length).trim();
  if (/\bprocess\.env\b/.test(expr)) {
    return `env: ${expr} mentions process.env -- a git child inherits a hook's absolute GIT_DIR that way; take env from gitEnv(...) alone (CWK-136)`;
  }
  if (/\bgitEnv\(/.test(expr)) return null;
  if (/^[A-Za-z_$][\w$]*$/.test(expr) && new RegExp(String.raw`(?:const|let|var)\s+${escapeDollar(expr)}\s*=\s*gitEnv\(`).test(fileText)) return null;
  return `env: ${expr || '(empty)'} is not produced by gitEnv() -- assign it from gitEnv(...) in this file or call it in place (CWK-136)`;
}

export function censusGitSpawns(files) {
  const findings = [];
  const gitSpawns = [];
  let nodeChildren = 0;
  for (const { label, text } of files) {
    if (text === null || text === undefined) {
      findings.push(`${label} could not be read -- the census cannot vouch for a file it never saw`);
      continue;
    }
    const b = bindingsOf(text);
    if (!b) continue;
    let m;
    while ((m = b.re.exec(text))) {
      if (isInComment(text, m.index)) continue;
      const fn = m.groups.qfn || b.locals.get(m.groups.loc);
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
      const isGit = SHELL_STRING_FNS.has(fn) ? /^\s*git(\.exe)?(\s|$)/i.test(lit[2]) : /^git(\.exe)?$/i.test(lit[2]);
      if (!isGit) continue;
      gitSpawns.push({ label, line, fn });
      const why = envVerdict(callText, text);
      if (why) findings.push(`${label}:${line} ${fn}(git) ${why}`);
    }
  }
  return { findings, gitSpawns, nodeChildren };
}
