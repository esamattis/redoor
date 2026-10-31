#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { $ } from "zx";
import { z } from "zod";
import type { IntegrationLane } from "../../integration-test-lanes.ts";
import { stageTestBinary } from "./stage-test-binary.mts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const listedFilesSchema = z.array(
    z.object({ file: z.string(), projectName: z.enum(["parallel", "serial"]) }),
);

/**
 * Finds the lanes whose test files match the command line, so a filtered run such as
 * `pn integration-test tests/foo.test.ts` does not start an empty lane. Vitest itself
 * resolves the filters, so they keep their usual meaning.
 */
async function lanesToRun(arguments_: string[]): Promise<IntegrationLane[]> {
    if (arguments_.length === 0) {
        return ["parallel", "serial"];
    }

    const listing = await $({
        cwd: PROJECT_ROOT,
        quiet: true,
    })`vitest list --config vitest.config.ts --filesOnly --json --passWithNoTests ${arguments_}`;

    const files = listedFilesSchema.parse(JSON.parse(listing.stdout));

    return [...new Set(files.map((file) => file.projectName))];
}

/** Copies a lane's output line by line with its name, so two concurrent lanes stay readable. */
async function forwardLines(
    input: Readable,
    output: Writable,
    lane: IntegrationLane,
): Promise<void> {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        output.write(`[${lane}] ${line}\n`);
    }
}

/**
 * Runs one lane's Vitest project. A lone lane keeps the terminal for Vitest's live output;
 * concurrent lanes get their output prefixed instead, because two live reporters drawing on
 * one terminal would overwrite each other.
 */
async function runLane(options: {
    lane: IntegrationLane;
    arguments_: string[];
    env: NodeJS.ProcessEnv;
    prefixOutput: boolean;
}): Promise<number> {
    const lane = $({
        cwd: PROJECT_ROOT,
        env: options.prefixOutput
            ? // Piped output would otherwise lose its colors.
              { FORCE_COLOR: process.stdout.isTTY ? "1" : "0", ...options.env }
            : options.env,
        stdio: options.prefixOutput ? "pipe" : "inherit",
        quiet: true,
    })`vitest run --config vitest.config.ts --project ${options.lane} ${options.arguments_}`.nothrow();

    if (!options.prefixOutput) {
        return (await lane).exitCode ?? 1;
    }

    const forwarded = Promise.all([
        forwardLines(lane.stdout, process.stdout, options.lane),
        forwardLines(lane.stderr, process.stderr, options.lane),
    ]);

    const result = await lane;
    await forwarded;

    return result.exitCode ?? 1;
}

/**
 * Runs Vitest from an immutable executable so concurrent Cargo builds cannot replace it. The
 * serial SSH lane runs next to the parallel lane, so the suite takes about as long as the
 * slower lane instead of both lanes in turn.
 */
async function runIntegrationTests(arguments_: string[]): Promise<void> {
    const stagingDirectory = await mkdtemp(
        join(tmpdir(), "redoor-integration-"),
    );

    const stagedBinary = join(stagingDirectory, "redoor");

    try {
        const [lanes] = await Promise.all([
            lanesToRun(arguments_),
            stageTestBinary(stagedBinary),
        ]);

        const env = {
            ...process.env,
            REDOOR_TEST_BINARY: stagedBinary,
            // Servers upload the debug build to every fresh SSH app directory; the
            // stripped copy is a quarter of its size, which saves seconds per connect.
            REDOOR_TEST_DEBUG_BINARY: stagedBinary,
        };

        if (lanes.length === 0) {
            // Nothing matched; a plain run lets Vitest report that like it always does.
            await $({
                cwd: PROJECT_ROOT,
                stdio: "inherit",
                env,
            })`vitest run --config vitest.config.ts ${arguments_}`;

            return;
        }

        const exitCodes = await Promise.all(
            lanes.map((lane) =>
                runLane({
                    lane,
                    arguments_,
                    env,
                    prefixOutput: lanes.length > 1,
                }),
            ),
        );

        process.exitCode = exitCodes.find((code) => code !== 0) ?? 0;
    } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
    }
}

await runIntegrationTests(process.argv.slice(2));
