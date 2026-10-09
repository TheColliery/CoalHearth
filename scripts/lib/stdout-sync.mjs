// stdout-sync.mjs -- a preload (`node --import <this file>`, put on NODE_OPTIONS by suite-run.mjs) that makes a piped stdout and stderr BLOCKING, so a process that ends with
// process.exit() loses none of what it has written (08e RUNNER RED FIX; the CI run of 4744791).
//
// WHY: `node --test --test-force-exit` ends the test file's process with process.exit() as soon as its tests are done (lib/internal/test_runner/test.js: the root test, after
// the reporter streams unpipe). The file process reports its results to the runner over its stdout, a pipe. Node makes that pipe BLOCKING on Windows only (lib/net.js: "Make
// stdout and stderr blocking on Windows"); on POSIX the pipe is a non-blocking libuv handle, and whatever the kernel buffer (64 KiB on Linux) could not take yet is queued in
// user space, where process.exit() discards it. The runner then counts fewer tests than the file ran, silently: exit 0, no error. That is what the Linux and macOS CI legs of
// 4744791 showed (counts below their floors that differed from leg to leg, and the missing names were always the LAST ones of the file); Windows never showed it. The old runner
// judged the exit code and could not see it at all, which means a lost `not ok` event could read as green.
//
// WHAT: switch the two streams to blocking when they are pipes (a TTY and a file are synchronous already). On Windows this repeats what Node did; elsewhere it is the whole fix.
// Every node process of the run inherits it, the runner's own process included, so its report to the wave-run reader is covered too. Best effort: never throws, prints nothing.
//
// NAMED: wave-run.mjs (the canon) adds --test-force-exit to every file process and reads the TAP, so it carries the same exposure on POSIX; it is not edited here, and
// suite-run.mjs hands this preload to its children instead. A fix in the canon would be the same switch.
for (const stream of [process.stdout, process.stderr]) {
  try {
    if (stream && stream._type === 'pipe' && stream._handle && typeof stream._handle.setBlocking === 'function') stream._handle.setBlocking(true);
  } catch { /* best effort: a stream that refuses stays as it was */ }
}
