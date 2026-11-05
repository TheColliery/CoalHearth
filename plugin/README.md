# CoalHearth plugin

CoalHearth is a session warm-resume and handover journal for Claude Code. It records the state of your session as you work, so that when a session is cut off by a usage limit or a crash, the next session can start from a recovery block instead of a manual rebuild. It reduces the damage of a limit-hit. It does not prevent a limit-hit, and it does not guarantee recovery: the recovery block always tells the next session to verify its contents against git, because the journal can be stale or half-applied. It adds to what Claude Code already keeps (the session transcript and `--resume`) for two narrow cases: state captured before a compaction overwrites it, and the status of a subagent call that resolved. A subagent that died without resolving leaves no record. It is zero-dependency, makes no network calls, and needs no API key.

## Install

```bash
claude plugin marketplace add TheColliery/CoalHearth
claude plugin install coalhearth@coalhearth
```

A folder without a `.git` directory needs a project marker before the journal is written: run `git init`, or create a file `.coalhearth.json` containing `{}` at the project root. The journal is written only in a folder with that marker. The `{}` file is the deprecated root config, so the hooks print a legacy-path notice for it;

## What the hooks run, and when

`hooks/hooks.json` wires three events. Each runs one `node` script in the exec form, with the script path in `args`. None of the three sets a `matcher` or a `timeout`, so each fires on every occurrence of its event. Every hook is fail-silent: it swallows its own errors and exits 0.

| Event | Script | What it does |
|---|---|---|
| SessionStart | `bin/session-start.js` | Reads the journal. If the previous session was left in progress, it prints the recovery block on the session-start context channel and marks the journal `resumed`, so the same block is not repeated on every start. It also prints a one-line update nudge when a check is due, and removes an older update stamp left by an earlier version. |
| PostToolUse | `bin/post-tool-use.js` | Adds the step it observes to the journal: the goal and checklist when it can read them, the names of files touched by `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, and the spawn and status of a subagent call (`Agent`, `Task`, `Workflow`). It writes the journal and prints nothing. |
| UserPromptSubmit | `bin/user-prompt-submit.js` | Reads the journal. When a subagent's call has resolved since the last prompt and that status has not been shown, it prints one note with the subagent's description, its self-reported status and a 300-character outcome snippet, then marks it shown. Most prompts print nothing. |

The Antigravity adapters ship in the same folder, wired by the root `hooks.json`: `bin/ag-pre-invocation.js` runs the resume on the first `PreInvocation`, and `bin/ag-post-tool-use.js` journals each `PostToolUse`.

**What the hooks read.** The project's journal, the CoalHearth config, and the project's `task.md` and `AGENTS.md` (size-bounded).

**What the hooks write.** The journal and the temporary file it is written through, the lock file that serialises writes, a `.gitignore` in the journal folder, a `session_handoff.corrupt.json` copy of a journal that cannot be read, and the update stamp under `~/.claude/coal/coalhearth/`. On Antigravity, the adapter also writes a once-per-session marker file in the OS temporary folder. The journal folder is `<project>/.claude/coalhearth/` by default. The global `journal.outputDirectory` setting can move it, and the `.gitignore` is written in the default folder.

**What the hooks delete.** Files the hooks own, in these cases:

- the old update stamp `~/.claude/.coalhearth-update-check`, once the new stamp is written;
- the lock file, after every save, and a lock left behind by a holder that crashed;
- the temporary file, when a save fails;
- the corrupt journal, after its `session_handoff.corrupt.json` copy is written;
- `error.log` and `*.tmp` leftovers in the journal folder, when the disk is full;
- a `.claude/coalhearth` folder inside the working directory when a hook starts from a subdirectory of the project: its `.gitignore` and `session_handoff*` files are removed, then the folder itself if it is empty.

The resume-time orphan sweep, which would remove a leftover worker folder or probe file, removes nothing today. It acts only on names that a trusted registry in your user config home lists, and no part of CoalHearth writes that registry yet.

## What is fetched or sent

Nothing is sent, and the hooks make no network call. The update check is not a hook. It runs when you run `/coalhearth:update`, or when you accept the agent's offer of a check that is due (14 days by default). The agent then looks up the latest published tag of this repository, by whatever means it has, and offers the update. It installs nothing by itself. Set `update.updateMode` to `off` to turn the reminder off. Nothing is uploaded, and CoalHearth collects no telemetry.

## Data handling

- **What is stored:** the goal and checklist captured from `task.md`, the constraints (bullet text copied from `AGENTS.md`), the planned next steps, the session id and status, the names of files your session touched, the path of your own session transcript, which the hooks use only to check whether it still exists, never to read it, and, for a subagent call that has resolved, its type, its description, its residue path, its status and a 300-character outcome snippet.
- **Where:** the journal is `<project>/.claude/coalhearth/session_handoff.json`, with a `.gitignore` containing `*` beside it, so its contents stay out of your version control. The config is read from your Claude config folder and from the project's agent folder; the [repository README's Configure section](https://github.com/TheColliery/CoalHearth/blob/main/README.md#configure) lists the keys. The update stamp is `~/.claude/coal/coalhearth/update-check`.
- **How long:** the code sets no retention period. The journal is replaced at each save. Past about 4 MiB it drops its oldest recorded paths, then its oldest subagent records, and it counts what it dropped; if it still cannot fit, nothing new is written and the last good journal stays. It is not deleted on a schedule. Delete the folder above to remove it.
- **Who can read it:** anyone with access to your user account's files or the project folder; the code sets no further access control.
- **What leaves the machine:** nothing from the hooks. The update check reaches GitHub only when you run `/coalhearth:update`, or accept its offer when a check is due.

## Example uses

1. **A session cut off by a limit or a crash.** Start a new session in the same project. The recovery block appears in the session context, with the goal, the checklist, the files you touched and any subagent call that had resolved. Check it against `git status` before you continue.
2. **Checking what the journal holds.** Run `/coalhearth:stats`. It reads the journal and prints a table of its state and whether this session resumed. It changes no file.
3. **Checking for a newer version.** Run `/coalhearth:update`. It compares the latest published tag with the installed version and offers `claude plugin update coalhearth@coalhearth`. It applies nothing itself.
4. **A folder without git.** Create `.coalhearth.json` containing `{}` at the project root, or run `git init`, so the journal is written there.

## Commands

- `/coalhearth:stats`: a read-only report of the journal and of this session's resume.
- `/coalhearth:update`: a consent-gated check for a newer version, and the setting for how often the check runs.

## Report a problem

Open an issue at <https://github.com/TheColliery/CoalHearth/issues>. For a security problem, use GitHub's private vulnerability reporting, linked from [SECURITY.md](https://github.com/TheColliery/CoalHearth/blob/main/SECURITY.md), not a public issue. The data policy is in [PRIVACY.md](https://github.com/TheColliery/CoalHearth/blob/main/PRIVACY.md).

## Licence

CoalHearth is licensed under Apache-2.0.
