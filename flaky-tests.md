# Flaky tests

- 2026-10-30 `ui/e2e/git-lists.spec.ts` > Git commit, branch and tag lists > loads more commits
  beyond the first page (`ui/e2e/git-lists.spec.ts:386`): after "load more" the commit history
  stayed at 100 items instead of 101 within the 5s timeout during `pn test`; passed when rerun.
  Recurred during the wterm 0.5.7 upgrade at line 439: unrelated filesystem events canceled
  the next-page request and refetched page zero. Fixed by excluding commit-pinned immutable
  history from agent-wide invalidation, with a deterministic pagination regression test.