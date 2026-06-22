#!/usr/bin/env node
import { $, question } from "zx";
import * as semver from "semver";
import { readFile, writeFile } from "node:fs/promises";

const statusOutput = await $`git status --porcelain`.nothrow();
if (statusOutput.stdout.trim() !== "") {
    console.error(
        "Error: There are uncommitted changes or untracked files. Please commit or stash them before releasing.",
    );
    process.exit(1);
}

const currentBranch = (await $`git rev-parse --abbrev-ref HEAD`).stdout.trim();
if (currentBranch !== "main") {
    console.error(
        `Error: You must be on the 'main' branch to release. Current branch: '${currentBranch}'.`,
    );
    process.exit(1);
}

// Find the latest git tag prefixed with "v"
const tagOutput = await $`git tag -l 'v*' | sort -V | tail -n 1`;
const latestTag = tagOutput.stdout.trim();

if (latestTag) {
    console.log(`Latest release tag: ${latestTag}`);
} else {
    console.log("No release tags found.");
}

const newVersion = await question("Enter new version (without v prefix): ");

if (!semver.valid(newVersion)) {
    console.error(`Invalid semver: ${newVersion}`);
    process.exit(1);
}

const newTag = `v${newVersion}`;

if (latestTag && semver.lt(newVersion, latestTag.replace(/^v/, ""))) {
    console.error(
        `New version ${newVersion} must be greater than latest tag ${latestTag}`,
    );
    process.exit(1);
}

// Update version in Cargo.toml and commit the change
const cargoTomlPath = "Cargo.toml";
const cargoTomlContent = await readFile(cargoTomlPath, "utf-8");
const updatedCargoToml = cargoTomlContent.replace(
    /^version = ".*"$/m,
    `version = "${newVersion}"`,
);
await writeFile(cargoTomlPath, updatedCargoToml);

console.log("Running cargo build to update Cargo.lock...");
await $`cargo build`;
await $`git add ${cargoTomlPath} Cargo.lock`;

// Check if there are staged changes to commit. Re-running the script for an
// already-released version produces no diff, which would make git commit fail
// with "nothing to commit". Skip the commit in that case and just (re)tag.
const stagedOutput = await $`git diff --cached --name-only`.nothrow();
if (stagedOutput.stdout.trim() !== "") {
    await $`git commit -m "Bump version to ${newVersion}"`;
} else {
    console.log("No version changes to commit, skipping commit.");
}

// Check if the tag already exists locally or remotely
const localTagOutput = await $`git tag -l ${newTag}`.nothrow();
const localTagExists = localTagOutput.stdout.trim() === newTag;

const remoteTagOutput =
    await $`git ls-remote --tags origin ${newTag}`.nothrow();
const remoteTagExists = remoteTagOutput.stdout
    .trim()
    .includes(`refs/tags/${newTag}`);

if (localTagExists || remoteTagExists) {
    console.log("");
    console.log(
        "╔══════════════════════════════════════════════════════════════════╗",
    );
    console.log(
        "║                     ⚠️  DESTRUCTIVE WARNING  ⚠️                  ║",
    );
    console.log(
        "╠══════════════════════════════════════════════════════════════════╣",
    );
    if (localTagExists) {
        console.log(
            `║  Local tag '${newTag}' already exists and will be deleted.       ║`,
        );
    }
    if (remoteTagExists) {
        console.log(
            `║  Remote tag '${newTag}' already exists and will be deleted.      ║`,
        );
    }
    console.log(
        "╚══════════════════════════════════════════════════════════════════╝",
    );
    console.log("");

    const confirmation = await question(
        "Are you sure you want to delete and recreate this tag? (yes/no): ",
    );

    if (confirmation.toLowerCase() !== "yes") {
        console.log("Release aborted.");
        process.exit(1);
    }
}

if (localTagExists) {
    console.log(`Deleting existing local tag ${newTag}...`);
    await $`git tag -d ${newTag}`;
}

if (remoteTagExists) {
    console.log(`Deleting existing remote tag ${newTag}...`);
    await $`git push origin --delete ${newTag}`;
}

await $`git tag -a ${newTag} -m "Release ${newTag}"`;
await $`git push origin HEAD`;
await $`git push origin ${newTag}`;
console.log(`Released ${newTag}`);
