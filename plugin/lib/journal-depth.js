'use strict';

// The deepest a journal may nest when a reader parses it. A journal is a file the repository can supply, and a deeply nested one
// costs time to walk, and it multiplies in size when it is re-rendered with indentation. The hook writes journals three levels deep
// (the state object, its arrays, and the records inside them), so the bound sits well above that: a journal over it is refused at the
// read exactly as an unparseable one is.
const MAX_JOURNAL_DEPTH = 8;

// True when a parsed JSON value nests deeper than `limit`. A primitive is depth 0; a container is 1 plus its deepest child. The
// walk is iterative (no recursion, so no stack to overflow) and stops at the first container past the limit.
function exceedsDepth(value, limit = MAX_JOURNAL_DEPTH) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    const here = d + 1;
    if (here > limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, here]);
  }
  return false;
}

// The one parse every journal reader goes through. A journal nested past the bound throws, so the reader's existing unparseable
// branch takes it: the same result, and the same quarantine where a reader already quarantines an unparseable file.
function parseJournal(raw) {
  const data = JSON.parse(raw);
  if (exceedsDepth(data)) throw new RangeError('journal nesting exceeds MAX_JOURNAL_DEPTH');
  return data;
}

module.exports = { MAX_JOURNAL_DEPTH, exceedsDepth, parseJournal };
