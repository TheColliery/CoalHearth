// Finds a test that hands the shared temp folder itself to an engine as its root. The engine builds its output folder, and writes a
// self-ignore file, under the root it is given, so a test that passes os.tmpdir() leaves litter in the machine's temp folder.
// The root is the last argument of ResumeEngine(config, recovery, root) and HandoffJournal(config, root). LIMIT: one line per call; a
// root held in a variable bound to os.tmpdir() is not matched; a subfolder of the temp folder (path.join(os.tmpdir(), 'x')) is not the
// shared root and is not matched.
const BARE_TMPDIR_ROOT = /new\s+(?:ResumeEngine|HandoffJournal)\s*\([^\n]*?,\s*os\.tmpdir\(\)\s*\)/g;

export function findBareTmpdirEngines(text) {
  return [...text.matchAll(BARE_TMPDIR_ROOT)].map((m) => m[0]);
}
