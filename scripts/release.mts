#!/usr/bin/env node
import { $ } from "zx";
import * as semver from "semver";
import { readFile, writeFile } from "node:fs/promises";

type ReleaseBump = "patch" | "minor" | "major";

const changelogPath = "CHANGELOG.md";

/**
 * Fail early so a dirty tree cannot leak into the version bump commit. The changelog is
 * the one exception: the agent drafts the release notes in it right before releasing,
 * and they belong in the bump commit so the tag carries them.
 */
async function requireCleanWorkingTree(): Promise<void> {
    const statusOutput = await $`git status --porcelain`.nothrow();

    const dirtyPaths = statusOutput.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3))
        .filter((path) => path !== changelogPath);

    if (dirtyPaths.length > 0) {
        console.error(
            `Error: There are uncommitted changes or untracked files besides ${changelogPath}. Please commit or stash them before releasing.`,
        );
        process.exit(1);
    }
}

/**
 * CHANGELOG.md, whose "## Unreleased" section the release turns into the new version's
 * section. Every GitHub release links to its heading, so the heading must be exactly the
 * tag: GitHub then derives a predictable anchor from it (v2.0.0 -> #v200).
 */
class Changelog {
    static readonly unreleasedHeading = "## Unreleased";

    private content: string;

    private constructor(content: string) {
        this.content = content;
    }

    /** Reads the changelog, failing when it is missing because a release needs notes. */
    static async read(): Promise<Changelog> {
        const content = await readFile(changelogPath, "utf-8").catch(() => {
            console.error(`Error: ${changelogPath} is missing.`);
            process.exit(1);
        });

        return new Changelog(content);
    }

    /**
     * A release without notes would leave its GitHub link pointing at nothing, so refuse
     * one unless the agent has written a non-empty Unreleased section.
     */
    requireUnreleasedNotes(): void {
        const lines = this.content.split("\n");

        const start = lines.indexOf(Changelog.unreleasedHeading);

        if (start === -1) {
            console.error(
                `Error: ${changelogPath} has no "${Changelog.unreleasedHeading}" section. Write the release notes there first.`,
            );
            process.exit(1);
        }

        const nextHeading = lines.findIndex(
            (line, index) => index > start && line.startsWith("## "),
        );

        const body = lines
            .slice(start + 1, nextHeading === -1 ? undefined : nextHeading)
            .join("\n")
            .trim();

        if (body === "") {
            console.error(
                `Error: The "${Changelog.unreleasedHeading}" section in ${changelogPath} is empty.`,
            );
            process.exit(1);
        }
    }

    /** A second section for the same tag would make its GitHub anchor ambiguous. */
    requireNoSectionFor(tag: string): void {
        if (this.content.split("\n").includes(`## ${tag}`)) {
            console.error(
                `Error: ${changelogPath} already has a "## ${tag}" section.`,
            );
            process.exit(1);
        }
    }

    /** Renames the Unreleased section to the tag and dates it, then saves the file. */
    async release(tag: string): Promise<void> {
        const date = new Date().toISOString().slice(0, 10);

        this.content = this.content.replace(
            /^## Unreleased$/m,
            `## ${tag}

_${date}_`,
        );

        await writeFile(changelogPath, this.content);
    }
}

/** Releases must come from main so tags always point at the integration branch. */
async function requireMainBranch(): Promise<void> {
    const currentBranch = (
        await $`git rev-parse --abbrev-ref HEAD`
    ).stdout.trim();

    if (currentBranch !== "main") {
        console.error(
            `Error: You must be on the 'main' branch to release. Current branch: '${currentBranch}'.`,
        );
        process.exit(1);
    }
}

/** A rejected push is the remote saying this tip cannot become the release. */
async function requireSyncedWithOriginMain(): Promise<void> {
    const pushResult = await $`git push origin main`.nothrow();

    if (pushResult.exitCode !== 0) {
        console.error(
            "Error: Local main is not in sync with origin/main. Pull until `git push origin main` succeeds.",
        );
        process.exit(1);
    }

    // Treat origin as authoritative so stale local tags cannot affect the next version.
    await $`git fetch origin --tags --force --prune --prune-tags`;
}

/** Skills cannot answer prompts, so the bump type is a required CLI argument. */
function parseReleaseBump(argument: string | undefined): ReleaseBump {
    if (argument === "patch" || argument === "minor" || argument === "major") {
        return argument;
    }

    console.error("Usage: node scripts/release.mts <patch|minor|major>");
    process.exit(1);
}

/** Increment the latest published tag so the next version cannot collide with an existing release. */
function resolveNextVersion(latestTag: string, bump: ReleaseBump): string {
    const currentVersion = latestTag.replace(/^v/, "");

    if (!semver.valid(currentVersion)) {
        console.error(
            `Invalid latest tag ${latestTag}; expected a v-prefixed semver.`,
        );
        process.exit(1);
    }

    const newVersion = semver.inc(currentVersion, bump);

    if (newVersion === null) {
        console.error(
            `Could not increment ${currentVersion} as a ${bump} release.`,
        );
        process.exit(1);
    }

    return newVersion;
}

/** Refuse to rewrite a published tag; non-interactive releases must never be destructive. */
async function requireUnusedTag(newTag: string): Promise<void> {
    const localTagOutput = await $`git tag -l ${newTag}`.nothrow();

    const remoteTagOutput =
        await $`git ls-remote --tags origin ${newTag}`.nothrow();

    if (
        localTagOutput.stdout.trim() === newTag ||
        remoteTagOutput.stdout.trim().includes(`refs/tags/${newTag}`)
    ) {
        console.error(
            `Error: Tag ${newTag} already exists. Choose a newer bump or delete it manually.`,
        );
        process.exit(1);
    }
}

const bump = parseReleaseBump(process.argv[2]);

await requireCleanWorkingTree();

await requireMainBranch();

const changelog = await Changelog.read();

changelog.requireUnreleasedNotes();

await requireSyncedWithOriginMain();

const tagOutput = await $`git tag -l 'v*' | sort -V | tail -n 1`;

const latestTag = tagOutput.stdout.trim();

if (latestTag === "") {
    console.error(
        "Error: No release tags found. Cannot compute the next version.",
    );
    process.exit(1);
}

console.log(`Latest release tag: ${latestTag}`);

const newVersion = resolveNextVersion(latestTag, bump);

const newTag = `v${newVersion}`;

console.log(`Releasing ${newTag} (${bump})`);

await requireUnusedTag(newTag);

changelog.requireNoSectionFor(newTag);

const cargoTomlPath = "Cargo.toml";

const cargoTomlContent = await readFile(cargoTomlPath, "utf-8");

const updatedCargoToml = cargoTomlContent.replace(
    /^version = ".*"$/m,
    `version = "${newVersion}"`,
);

await writeFile(cargoTomlPath, updatedCargoToml);

console.log("Running cargo build to update Cargo.lock...");

await $`cargo build`;

// Date the notes only after the build succeeded, so a failed build leaves the
// Unreleased section in place for a retry.
await changelog.release(newTag);

await $`git add ${cargoTomlPath} Cargo.lock ${changelogPath}`;

const stagedOutput = await $`git diff --cached --name-only`.nothrow();

if (stagedOutput.stdout.trim() !== "") {
    await $`git commit -m "Bump version to ${newVersion}"`;
} else {
    console.log("No version changes to commit, skipping commit.");
}

await $`git tag -a ${newTag} -m "Release ${newTag}"`;

await $`git push origin HEAD`;

await $`git push origin ${newTag}`;

console.log(`Released ${newTag}`);
