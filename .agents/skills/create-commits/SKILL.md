---
name: create-commits
description: Use whenever creating Git commits, whether the user asks for them or a workflow ends in a commit.
---

# Create Commits

Create focused Git commits for the work completed in the current conversation. No need to run tests or any checks before creating commits.

## Select Changes

1. Inspect the working tree and diff before staging anything.
2. By default, include only changes made as part of the current conversation.
3. Do not stage pre-existing user changes, unrelated generated files, or other untracked files unless the user explicitly asks for them.
4. If a file contains both thread-related and unrelated edits, stage only the relevant hunks. If that cannot be done safely, stop and explain what prevents a safe commit.
5. Never discard, overwrite, or revert unrelated work to make the commit easier.

Run shell commands through `mise exec -- …`.

## Decide Commit Boundaries

- Create one commit when all selected changes serve the same purpose.
- Create multiple commits when the changes are completely different in purpose or can be understood and reverted independently.
- Keep implementation and its directly related tests, generated bindings, configuration, and documentation together unless there is a clear reason to separate them.
- Order multiple commits so each commit is coherent and the sequence is easy to review.

## Write Commit Messages

Each commit message must contain:

1. A short, imperative title that summarizes the purpose of the change.
2. A body that explains why the change was made, such as the bug it fixes, the user-visible problem it addresses, or the engineering constraint it satisfies.

The body must not merely restate the literal file or code changes. Prefer rationale and impact over implementation inventory.

## Flag Breaking Changes

Prefix the title with `BREAKING: ` only when upgrading needs manual work beyond installing the new release, so the release changelog lists exactly the upgrades that need attention. Only these count:

- Agents must be upgraded too, because a wire protocol change means older agents cannot talk to the new server, or the new agent cannot talk to an older server.
- A config file must be changed by hand to keep things working, such as a removed key, a key whose meaning changed, or a feature that now needs to be turned on in the config.
- A state or data file on disk must be migrated, because the new release no longer reads it as it is.

Other behavior changes are not breaking, even when a default changes or a search, listing or tool returns different results, because nothing has to be done to keep the app working. REST API changes are never breaking: the REST API is private to the UI, which ships in the same binary.

The body of a breaking commit must say what users must do to upgrade.

For example: `BREAKING: Make PAM login opt-in`.
