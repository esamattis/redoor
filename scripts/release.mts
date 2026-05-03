#!/usr/bin/env node
import { $, question } from "zx";
import * as semver from "semver";

// Check for uncommitted changes or untracked files
const statusOutput = await $`git status --porcelain`.nothrow();
if (statusOutput.stdout.trim() !== "") {
    console.error(
        "Error: There are uncommitted changes or untracked files. Please commit or stash them before releasing.",
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

// If the tag already exists, delete it locally and from remote before recreating
const localTagOutput = await $`git tag -l ${newTag}`.nothrow();
if (localTagOutput.stdout.trim() === newTag) {
    console.log(`Deleting existing local tag ${newTag}...`);
    await $`git tag -d ${newTag}`;
}

const remoteTagOutput =
    await $`git ls-remote --tags origin ${newTag}`.nothrow();
if (remoteTagOutput.stdout.trim().includes(`refs/tags/${newTag}`)) {
    console.log(`Deleting existing remote tag ${newTag}...`);
    await $`git push origin --delete ${newTag}`;
}

if (latestTag && semver.lt(newVersion, latestTag.replace(/^v/, ""))) {
    console.error(
        `New version ${newVersion} must be greater than latest tag ${latestTag}`,
    );
    process.exit(1);
}

await $`git tag -a ${newTag} -m "Release ${newTag}"`;
await $`git push origin`;
await $`git push origin ${newTag}`;
console.log(`Released ${newTag}`);
