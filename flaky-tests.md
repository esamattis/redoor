# Flaky tests

## `redoor-agent commands::git::commit_diff::tests::conflicting_changes_are_marked`

- 2026-11-19: failed in `pn test` and passed on rerun. The assertion at `crates/redoor-agent/src/commands/git/commit_diff.rs:1126` compares `git count-objects -v` output, and the loose object `size` differed (17 vs 5 KiB) with the same `count: 11`, so the KiB size seems to depend on the filesystem's block allocation rather than the test's behavior.

## `tests/request-lifecycle.test.ts` > cancels an abandoned 'FileSearch' on the agent

- 2026-11-19: timed out after 10 s in `pn test` and passed on rerun of the file alone. The cause is unknown; it ran under the full parallel integration lane.
