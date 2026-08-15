---
name: fix-android-build
description: Use when the GitHub Actions Android job "Build and maybe release / build (ubuntu-latest, aarch64-linux-android, redoor-aarch64-android) (push)" fails and the user wants it diagnosed, fixed, committed, pushed, and monitored until it passes.
---

# Fix Android Build

Diagnose and repair the Android build on `main`, then keep iterating until the replacement GitHub Actions job passes. Do not stop after making a plausible local fix.

## Inspect The Failure

1. Run every shell command through `mise exec --`.
2. Inspect the worktree before changing or staging files. Preserve unrelated user changes.
3. Find recent runs with `gh run list --workflow "Build and maybe release" --limit 10`.
4. Inspect the newest relevant run with `gh run view <run-id> --json jobs,headSha,displayTitle,url`.
5. Locate the exact job named `build (ubuntu-latest, aarch64-linux-android, redoor-aarch64-android)` and fetch its failed log with `gh run view <run-id> --job <job-id> --log-failed`.
6. Diagnose from the first actionable compiler or linker error, not from the workflow's final exit-code line. Check multiple failed runs when necessary to distinguish a persistent regression from a transient failure.

## Implement And Verify

- Make the smallest correct fix that preserves non-Android behavior.
- Treat Android as `target_os = "android"`, not Linux, when writing Cargo target predicates or Rust `cfg` attributes.
- Keep unsupported platform dependencies out of the Android dependency graph rather than patching third-party source in CI.
- Use async Tokio APIs in application code and keep large-file operations streaming.
- Run `mise exec -- pn test` with a timeout of at least 300 seconds after changes.
- When useful, validate dependency selection with `cargo tree --target aarch64-linux-android` or `cargo metadata --filter-platform aarch64-linux-android`.

## Commit And Push

1. Inspect `git status`, `git diff`, and `git log --oneline -10` before committing. Append `| cat` to Git commands as required by this repository.
2. Stage only files related to the Android fix and this skill. Never stage or overwrite unrelated worktree changes.
3. Create a non-empty commit with an imperative title and a body explaining why the Android build failed and why the fix is appropriate.
4. Push the current branch without force. Existing local commits may be pushed with it; do not rewrite them.

## Monitor And Iterate

1. Find the push run whose `headSha` equals the pushed commit.
2. Watch it with `gh run watch <run-id> --exit-status`. The matrix may fail fast and cancel unrelated jobs when Android fails.
3. Confirm the exact Android job conclusion with `gh run view <run-id> --json jobs,url`; do not infer success only from local checks.
4. If Android fails, fetch that job's failed log, implement the next root-cause fix, run the relevant local verification, commit, push, and watch again.
5. Finish only after the exact Android job reports `success`. Report the successful run URL and all commits created.

If GitHub authentication, push permissions, or an external service blocks progress, report the concrete command failure rather than claiming the build is fixed.
