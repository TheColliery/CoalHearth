# Fixture: planted link-check defects

CW-017 -- planted for `scripts/lib/link-check.test.mjs`. Excluded from the real workflow
walk (`.github/workflows/link-check.yml`'s `git ls-files ... | grep -v '^scripts/fixtures/'`)
and from `scripts/verify.mjs`'s pointer-drift/config-key surfaces -- neither gate walks
`scripts/fixtures/*.md` content, so this file exists only for the engine's own tests.

A broken relative link: [nowhere](./does-not-exist.md)

A broken same-file anchor: [see nothing](#no-such-heading)

## A Real Heading
