---
name: fix-flaky-test
description: Use when a test fails and then passes on a rerun, or when asked to fix a flaky test.
---

# Fix a Flaky Test

A flake can be a real product bug (a late connect redirect and cancelled commit pagination both were), so do not dismiss one because the current change does not touch that code.

## Log it

Log every transient failure that passes on a rerun to `flaky-tests.md`.

## Fix it

1. Make it reproduce deterministically: hold a response, throttle the CPU, run a parallel upload loop, or use `--repeat-each`.
2. Fix the cause, following the `write-tests` skill.
3. Verify the fix with repeated runs.
