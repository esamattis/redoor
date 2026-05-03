#!/usr/bin/env node
import { $, question } from "zx";
import * as semver from "semver";

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

if (latestTag && semver.lte(newVersion, latestTag.replace(/^v/, ""))) {
    console.error(
        `New version ${newVersion} must be greater than latest tag ${latestTag}`,
    );
    process.exit(1);
}

const newTag = `v${newVersion}`;
await $`git tag ${newTag}`;
await $`git push origin ${newTag}`;
console.log(`Released ${newTag}`);
