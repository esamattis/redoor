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
2. Do not switch branches, commit, stash, pull, or push to make the tree releasable. The release script pushes `main` first and aborts if that push fails.
3. If the working tree has changes other than `CHANGELOG.md`, or `git push origin main` would fail, stop and report what the user must do first.

## Write The Changelog

Every release needs notes in `CHANGELOG.md`; the script refuses to release without them, and the GitHub release only links to the version's section there.

1. Find the latest tag with `mise exec -- git describe --tags --abbrev=0 --match 'v*'` and read every change since it with `mise exec -- git log --no-merges --format='%h %s%n%b' <latest-tag>..HEAD`. Open a commit with `git show` when its message does not make the user-facing effect clear.
2. Write the notes under a `## Unreleased` heading directly below the `# Changelog` title, above the newest release. If the section already exists, merge the new changes into it instead of replacing what is there.
3. Keep only what users and operators notice: features, fixes, config, CLI, API and upgrade steps. Leave out tests, CI, refactors, docs-only and agent-instruction changes.
4. Group bullets under `### Breaking changes`, `### Features` and `### Fixes`, in that order, and omit empty groups. Every commit whose title starts with `BREAKING: ` must appear under `### Breaking changes`, but also look for unflagged breaking changes in the other commits. Only agent upgrades and config or state file migrations count as breaking, as defined in the `create-commits` skill; behavior changes are listed as features or fixes. Merge commits that make up one change into one bullet. Write each bullet from the user's point of view and say what they must do for every breaking change.
5. Do not write the version or date yourself, and do not commit `CHANGELOG.md`. The script renames `## Unreleased` to `## v<version>` with the date and commits it together with the version bump.

## Release

Run from the repository root with a timeout of at least 180 seconds:

```bash
mise exec -- node scripts/release.mts <patch|minor|major>
```

Do not pass a raw version number. Do not add confirmation flags. Do not delete or recreate existing tags.

## Afterward

Report the printed tag (for example `v0.1.16`) and the changelog section you wrote. The `Build and maybe release` GitHub Actions workflow creates the GitHub release from that tag, with a link to the tag's `CHANGELOG.md` heading. Do not create a GitHub release by hand.

If the script fails before it commits, the `## Unreleased` section stays in place; fix the cause and run it again.

Do not run `pn test` solely because a release was requested.
