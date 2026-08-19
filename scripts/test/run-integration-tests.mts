#!/usr/bin/env node
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "zx";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Runs Vitest from an immutable executable so concurrent Cargo builds cannot replace it. */
async function runIntegrationTests(arguments_: string[]): Promise<void> {
    const stagingDirectory = await mkdtemp(
        join(tmpdir(), "redoor-integration-"),
    );
    const stagedBinary = join(stagingDirectory, "redoor");
    const filters = arguments_.length === 0 ? ["tests"] : arguments_;
    try {
        await copyFile(join(PROJECT_ROOT, "target/debug/redoor"), stagedBinary);
        await chmod(stagedBinary, 0o755);
        await $({
            cwd: PROJECT_ROOT,
            stdio: "inherit",
            env: { ...process.env, REDOOR_TEST_BINARY: stagedBinary },
        })`vitest run --config vitest.config.ts ${filters}`;
    } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
    }
}

await runIntegrationTests(process.argv.slice(2));
