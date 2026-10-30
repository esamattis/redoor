# Flaky tests

- 2026-10-30 `redoor-server` `ssh::provision::tests::local_build_cache_recomputes_only_after_a_change`
  (`crates/redoor-server/src/ssh/provision.rs:1226`): running the freshly written fake
  `redoor --version` failed with "Text file busy (os error 26)" during `pn test`; passed when
  rerun alone.
- 2026-10-30 `tests/real-ssh.test.ts` > TOML-managed SSH agents > starts, controls, and restarts an
  `[[agents]]` entry through redoor-ssh-test (`tests/real-ssh.test.ts:590`): the first
  connection's provisioning messages lacked "Connected" during `pn test`; passed when rerun alone.
- 2026-10-30 `ui/e2e/git-lists.spec.ts` > Git commit, branch and tag lists > loads more commits
  beyond the first page (`ui/e2e/git-lists.spec.ts:386`): after "load more" the commit history
  stayed at 100 items instead of 101 within the 5s timeout during `pn test`; passed when rerun.
- 2026-10-30 `ui/e2e/search-scope.spec.ts` > Search scope > changes the searched folder from
  breadcrumbs, results and a typed path (`ui/e2e/search-scope.spec.ts:79`): after toggling
  directories only, the dialog still showed "Searching…" with the previous file results for the
  whole 5s timeout during `pn test`, so the non-exact `Open path <folder>` locator also matched
  the file inside it; passed 8/8 when repeated alone and in the next full `pn test`.
