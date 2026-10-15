// CWK2-027: every Claude Code hook entry is the EXEC form (`command: "node"` + one `args` path), never a shell string.
// A shell-form string carrying ${CLAUDE_PLUGIN_ROOT} runs through PowerShell on Windows without Git for Windows, where `${CLAUDE_PLUGIN_ROOT}` is a PowerShell variable that expands
// to nothing: node gets a missing script and the hook fails (CoalWash measured it, CWK2-020 item 1). Exec form has no shell (hooks-safety.md section 3: `command` must be a real
// executable on Windows, so `node`, never a shim).
// Named divergence: the Antigravity twin (hooks.json and plugin/hooks.json) KEEPS its shell-string commands. They carry no ${CLAUDE_PLUGIN_ROOT} placeholder (a path relative to the
// folder holding hooks.json, measured firing on agy 1.3.1 at 08b), so the failure class does not reach them, and AG's schema for an `args` field is unmeasured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
const WANT = {
  SessionStart: `${PLACEHOLDER}/bin/session-start.js`,
  PostToolUse: `${PLACEHOLDER}/bin/post-tool-use.js`,
  UserPromptSubmit: `${PLACEHOLDER}/bin/user-prompt-submit.js`,
};
const TREES = [['source', REPO], ['dist', path.join(REPO, 'plugin')]];

function entries(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    for (const g of groups) for (const h of g.hooks) out.push({ event, h });
  }
  return out;
}

for (const [label, root] of TREES) {
  test(`hooks.json (${label}): every entry is exec form, node + one args path to its script, no shell or onFailure`, () => {
    const all = entries(root);
    assert.deepEqual(all.map((e) => e.event).sort(), Object.keys(WANT).sort(), 'SessionStart, PostToolUse and UserPromptSubmit, one entry each');
    for (const { event, h } of all) {
      assert.equal(h.type, 'command', event);
      assert.equal(h.command, 'node', `${event}: command is the executable alone, never a shell string (got ${JSON.stringify(h.command)})`);
      assert.deepEqual(h.args, [WANT[event]], event);
      assert.ok(!('shell' in h), `${event}: no shell field`);
      assert.ok(!('onFailure' in h), `${event}: no onFailure (hooks-safety section 1: never block on a fail-silent hook)`);
      assert.ok(!String(h.command).includes(PLACEHOLDER), `${event}: no placeholder inside a command string`);
    }
  });
}

test('the Antigravity twin is the named divergence: its commands carry no ${CLAUDE_PLUGIN_ROOT} placeholder, so the shell-expansion failure class does not reach them', () => {
  for (const f of ['hooks.json', path.join('plugin', 'hooks.json')]) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!text.includes('CLAUDE_PLUGIN_ROOT'), `${f}: no placeholder`);
    assert.ok(/"command": "node bin\/ag-/.test(text), `${f}: relative bin/ command`);
  }
});

// hooks-safety.md section 4/7: PostToolUse is journal-only and prints NOTHING. SessionStart and UserPromptSubmit may print agent context: one JSON object that carries hookSpecificOutput,
// or plain text opening with the hook's own prefix ([CoalHearth] nudge, or the warm-resume block). Anything else (an error line, a stack frame) is a stray print and fails. Measured on
// 6657ca5 with the sandboxed env above: PostToolUse and the first UserPromptSubmit print '', SessionStart prints the '[CoalHearth] ' self-update line.
const CONTEXT_PREFIXES = ['[CoalHearth] ', '> [!IMPORTANT]'];
function assertSanctionedStdout(event, stdout) {
  if (event === 'PostToolUse') return assert.equal(stdout, '', 'PostToolUse is journal-only: any stdout is a stray print');
  if (stdout === '') return;
  if (stdout.trimStart().startsWith('{')) {
    const o = JSON.parse(stdout);
    return assert.ok(o && typeof o === 'object' && o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object', `${event}: JSON output must carry hookSpecificOutput`);
  }
  assert.ok(CONTEXT_PREFIXES.some((p) => stdout.startsWith(p)), `${event}: plain output must open with the hook's own prefix, got ${JSON.stringify(stdout.slice(0, 80))}`);
}

const PAYLOAD = {
  SessionStart: (cwd) => ({ hook_event_name: 'SessionStart', session_id: 't-exec', cwd, source: 'startup' }),
  PostToolUse: (cwd) => ({ hook_event_name: 'PostToolUse', session_id: 't-exec', cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'notes.txt') }, tool_response: {} }),
  UserPromptSubmit: (cwd) => ({ hook_event_name: 'UserPromptSubmit', session_id: 't-exec', cwd, prompt: 'hello' }),
};

for (const [label, root] of TREES) {
  for (const event of Object.keys(WANT)) {
    test(`${event} (${label}) runs the way exec form runs it: no shell, node + the substituted args, exit 0, silent stderr, sanctioned stdout only`, (t) => {
      const tmp = fs.realpathSync.native(os.tmpdir());
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'ch-execform-')));
      t.after(() => {
        assert.ok(dir.startsWith(tmp + path.sep), `refusing to remove ${dir}`);
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const home = path.join(dir, 'home');
      const proj = path.join(dir, 'proj');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
      const entry = entries(root).find((e) => e.event === event);
      assert.ok(entry && Array.isArray(entry.h.args), `the ${event} entry carries args (exec form)`);
      const args = entry.h.args.map((a) => a.split(PLACEHOLDER).join(root));
      const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '', CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: '', CLAUDE_PROJECT_DIR: proj };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(entry.h.command === 'node' ? process.execPath : entry.h.command, args,
        { cwd: proj, env, input: JSON.stringify(PAYLOAD[event](proj)), encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', windowsHide: true, shell: false });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stderr, '');
      assertSanctionedStdout(event, r.stdout);
    });
  }
}
