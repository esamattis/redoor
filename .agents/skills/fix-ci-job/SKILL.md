---
name: fix-ci-job
description: Use when the user asks to fix a GitHub Actions workflow, job, or CI build. Resolve the named or implied job first.
---

# Fix a CI Job

Diagnose and repair the GitHub Actions workflow or jobs the user named, then keep iterating until a replacement run of those jobs passes. Do not stop after making a plausible local fix.

## Resolve The Target

The user may name a platform, a check, a workflow, a matrix cell, paste a GitHub job title, or share a run URL. Do not assume a specific job.

1. Run every shell command through `mise exec --`.
2. Inspect the worktree before changing or staging files. Preserve unrelated user changes.
3. If the user pasted a run or job URL, start from that run with `gh run view <run-id> --json jobs,headSha,displayTitle,url,workflowName`.
4. Otherwise list workflows from `.github/workflows/*.yml` and `gh workflow list`, and map the user's words to a workflow `name` plus the matching job set. Use filename, workflow `name`, job id, `runs-on`, matrix values, the current PR, and recent failed run titles.
5. A request can mean one matrix cell or every failing job in a workflow. Prefer the failed jobs that match the request. Ask only when the target remains ambiguous after inspecting recent runs.
6. Record the workflow name and each target job name as returned by `gh`, including matrix values. Expect event suffixes such as `(push)` in the GitHub UI but not necessarily in the `gh` job name.
7. If a newer run of the same workflow on this branch already shows those jobs as `success`, report that run URL and stop unless the user still wants a code change.

## Inspect The Failure

1. Find recent runs with `gh run list --workflow "<workflow name>" --limit 10`.
2. Inspect the newest relevant failed run with `gh run view <run-id> --json jobs,headSha,displayTitle,url`.
3. Fetch each target job's failed log with `gh run view <run-id> --job <job-id> --log-failed`.
4. Diagnose from the first actionable compiler, test, or linker error, not from the workflow's final exit-code line. Check multiple failed runs when necessary to distinguish a persistent regression from a transient failure.

## Implement And Verify

- Make the smallest correct fix that preserves unrelated platforms and jobs.
- If a target cannot be reproduced locally, do not fake that build or test; use the GitHub Actions job as the verification environment.
- Before creating a commit, run `mise exec -- pn test` with a timeout of at least 300 seconds and require it to pass. Skip this only when the user explicitly grants an exception for the current run; do not carry that exception into future uses of this skill.

## Commit And Push

1. Inspect `git status`, `git diff`, and `git log --oneline -10` before committing. Append `| cat` to Git commands as required by this repository.
2. Stage only files related to this CI fix. Do not stage skill, agent, or other unrelated worktree changes unless the user asked for those edits.
3. Create a non-empty commit with an imperative title and a body explaining why the job failed and why the fix is appropriate.
4. Push the current branch without force. Existing local commits may be pushed with it; do not rewrite them.

## Monitor And Iterate

1. Read the full pushed commit SHA with `git rev-parse HEAD`. Try `gh run list --workflow "<workflow name>" --commit <full-sha>`, then fall back to listing the workflow on the current branch and select the run whose `headSha` exactly matches.
2. Watch it with `gh run watch <run-id> --exit-status`. A matrix may fail fast and cancel unrelated jobs when a target job fails.
3. Confirm each target job conclusion with `gh run view <run-id> --json jobs,url`; do not infer success only from local checks.
4. If a target job fails, fetch its failed log, implement the next root-cause fix, run the relevant local verification, commit, push, and watch again.
5. Finish only after every target job reports `success`. Report the successful run URL and all commits created.

If GitHub authentication, push permissions, or an external service blocks progress, report the concrete command failure rather than claiming the job is fixed.
