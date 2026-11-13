# Flaky tests

## ui/e2e/create-archive.spec.ts › Create archive › archives selected items into the viewed directory

- 2026-11-13: `tar -tzf` failed with `gzip: stdin: unexpected end of file` while listing `archive.tar.gz`, then passed on rerun. The poll lists the archive while it may still be written, and unlike the zip test it has no `.catch(() => [])`, so a partially written file fails the test instead of being polled again.
