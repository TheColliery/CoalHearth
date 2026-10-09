// JSONC comment stripper — ported verbatim from CoalTipple's scripts/lib/jsonc.mjs
// (the CM #12 string-vs-comment fix: a value ending in a literal backslash, e.g.
// "C:\\", must terminate its string correctly instead of leaking escape state into
// the next token). Shared by verify.mjs and any future config loader.

export function stripJsonc(content) {
  return content.replace(/"(?:\\.|[^"\\])*"|\/\/.*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
}

// Prototype-pollution guard (ECC ts-security / OWASP Node.js): a poisoned project
// .coalhearth.json (e.g. shipped by an untrusted cloned repo) with a `__proto__` /
// `constructor` / `prototype` key would flow into `merged[group] = ...` — a [[Set]] with
// a `__proto__` key pollutes Object.prototype. Drop those keys at parse (the reviver runs
// over the tree before anything uses it). stripJsonc stays exported for verify.mjs.
const PROTO_GUARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function parseJsonc(content) {
  return JSON.parse(stripJsonc(content), (k, v) => (PROTO_GUARD_KEYS.has(k) ? undefined : v));
}
