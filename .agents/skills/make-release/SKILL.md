---
name: make-release
description: Use when the user asks to release, publish, or bump a patch, minor, or major version.
---

# Make a Release

Create a non-interactive Git tag release from a clean, fully synced `main`.

## Resolve The Bump

Accept only `patch`, `minor`, or `major`. If the user did not name one, ask and stop until they answer. Do not invent a bump type.

## Preconditions

1. Run every shell command through `mise exec --`.
2. Do not switch branches, commit, stash, pull, or push to make the tree releasable. The release script enforces a clean `main` that matches `origin/main`.
3. If the working tree is dirty or the branch is not synced `main`, stop and report what the user must do first.

## Release

Run from the repository root with a timeout of at least 180 seconds:

```bash
mise exec -- node scripts/release.mts <patch|minor|major>
```

Do not pass a raw version number. Do not add confirmation flags. Do not delete or recreate existing tags.

## Afterward

Report the printed tag (for example `v0.1.16`). The `Build and maybe release` GitHub Actions workflow creates the GitHub release from that tag. Do not create a GitHub release by hand.

Do not run `pn test` solely because a release was requested.
