import fs from "node:fs/promises";
import { ApiClient } from "#ui/api-client";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { TEST_USERNAME, TEST_PASSWORD, waitForValue } from "./test-utils";
import { createMcpTestClient } from './mcp-client';
import type { JsonObject } from './mcp-client';

/** Grants and paths shared by transfer regressions on the existing live fixture. */
type McpTransferRegressionFixture = {
    endpoint: string;
    baseUrl: string;
    token: () => string;
    sourceDevice: string;
    destinationDevice: string;
    sourceRoot: string;
    destinationRoot: string;
    metadataPath: string;
};

/** Shares the live MCP fixture so regressions exercise the same server and grants as the main workflows. */
export function registerMcpTransferRegressionTests(
    options: McpTransferRegressionFixture,
): void {
    registerMoveIdentityRegressionTest(options);
    it("shares concurrent transfer admissions and rejects reuse across copy and move", async () => {
        const client = createMcpTestClient({
            endpoint: options.endpoint,
            token: options.token(),
        });

        const sourcePath = join(
            options.sourceRoot,
            "concurrent-copy-source.txt",
        );

        const destinationPath = join(
            options.destinationRoot,
            "concurrent-copy-destination.txt",
        );

        writeFileSync(sourcePath, "one transfer only");

        const arguments_: JsonObject = {
            source: { device_id: options.sourceDevice, path: sourcePath },
            destination: {
                device_id: options.destinationDevice,
                path: destinationPath,
            },
            on_existing: "error",
            idempotency_key: "concurrent-transfer",
        };

        const responses = await Promise.all(
            Array.from({ length: 8 }, () =>
                client.callTool<JsonObject & { operation_id: string }>(
                    "copy_path",
                    arguments_,
                ),
            ),
        );

        const operationId =
            responses[0]?.result.structuredContent?.operation_id;

        if (operationId === undefined)
            throw new Error("Transfer admission missing");
        // Concurrent retries must share one admitted operation, including while metadata is being fetched.
        expect(
            responses.map(
                (response) => response.result.structuredContent?.operation_id,
            ),
        ).toEqual(Array.from({ length: 8 }, () => operationId));
        // Copy and move have different side effects even when their arguments match exactly.
        await expect(client.callTool("move_path", arguments_)).rejects.toThrow(
            "different arguments",
        );
        // Completion must reach durable storage even if no client ever asks for operation progress.
        await expect
            .poll(() => {
                const metadata = z
                    .object({
                        records: z.array(
                            z.object({ id: z.string(), state: z.string() }),
                        ),
                    })
                    .parse(JSON.parse(readFileSync(options.metadataPath, "utf8")));

                return metadata.records.find(
                    (record) => record.id === operationId,
                )?.state;
            })
            .toBe("completed");
        // The admitted copy must still complete and publish the original bytes.
        expect(
            (await client.waitForOperation(operationId)).result
                .structuredContent?.state,
        ).toBe("completed");
        expect(readFileSync(destinationPath, "utf8")).toBe("one transfer only");

        const canceled = await client.callTool("cancel_operation", {
            operation_id: operationId,
        });

        // A terminal record cannot route cancellation to any live router work.
        expect(canceled.result.structuredContent).toMatchObject({
            cancellation_accepted: false,
            termination_acknowledged: true,
        });
    });

    it("shares a failed keyed admission without repeating remote work", async () => {
        const client = createMcpTestClient({
            endpoint: options.endpoint,
            token: options.token(),
        });

        const arguments_: JsonObject = {
            source: {
                device_id: options.sourceDevice,
                path: join(options.sourceRoot, "missing-retry-source"),
            },
            destination: {
                device_id: options.destinationDevice,
                path: join(options.destinationRoot, "failed-retry-destination"),
            },
            on_existing: "error",
            idempotency_key: "failed-concurrent-transfer",
        };

        const responses = await Promise.all(
            Array.from({ length: 4 }, () =>
                client.callTool<JsonObject & { operation_id: string }>(
                    "copy_path",
                    arguments_,
                ),
            ),
        );

        const operationId =
            responses[0]?.result.structuredContent?.operation_id;

        if (operationId === undefined)
            throw new Error("Failed admission missing");
        // Even failed remote starts belong to the same durable keyed admission.
        expect(
            responses.map(
                (response) => response.result.structuredContent?.operation_id,
            ),
        ).toEqual(Array.from({ length: 4 }, () => operationId));
        expect(
            (await client.getOperation(operationId)).result.structuredContent,
        ).toMatchObject({
            state: "failed",
            termination: { reason: "admission_failed" },
        });
    });

    it("replaces inline files only with an explicit valid conflict policy", async () => {
        const client = createMcpTestClient({
            endpoint: options.endpoint,
            token: options.token(),
        });

        const path = join(options.sourceRoot, "replacement-upload.txt");
        writeFileSync(path, "old bytes");

        await client.callTool("write_file", {
            device_id: options.sourceDevice,
            path,
            content: "replacement bytes",
            on_existing: "replace",
        });

        // The explicit replacement policy overwrites the existing bytes.
        expect(readFileSync(path, "utf8")).toBe("replacement bytes");
        // Bad conflict policies are rejected before anything is written.
        await expect(
            client.callTool("write_file", {
                device_id: options.sourceDevice,
                path,
                content: "must not be written",
                on_existing: "invalid",
            }),
        ).rejects.toThrow("on_existing");
        expect(readFileSync(path, "utf8")).toBe("replacement bytes");
    });
}

/** Waits until the source is opened so this test isolates the destructive cleanup boundary. */
function registerMoveIdentityRegressionTest(
    options: McpTransferRegressionFixture,
): void {
    it("retains a changed move source when post-copy cleanup cannot be proven safe", async () => {
        const client = createMcpTestClient({
            endpoint: options.endpoint,
            token: options.token(),
        });

        const sourcePath = join(options.sourceRoot, "cleanup-source.bin");

        const retainedOriginal = join(
            options.sourceRoot,
            "cleanup-source-original.bin",
        );

        const destinationPath = join(
            options.destinationRoot,
            "cleanup-destination.bin",
        );

        onTestFinished(() => {
            rmSync(sourcePath, { force: true });
            rmSync(retainedOriginal, { force: true });
            rmSync(destinationPath, { force: true });
        });
        const file = await fs.open(sourcePath, "w");
        await file.truncate(512 * 1024 * 1024);
        await file.close();
        const api = new ApiClient(options.baseUrl);
        await api.login(TEST_USERNAME, TEST_PASSWORD);

        const move = await client.callTool<
            JsonObject & { operation_id: string }
        >("move_path", {
            source: { device_id: options.sourceDevice, path: sourcePath },
            destination: {
                device_id: options.destinationDevice,
                path: destinationPath,
            },
            on_existing: "error",
        });

        const operationId = move.result.structuredContent?.operation_id;

        if (operationId === undefined)
            throw new Error("Guarded move operation missing");
        await waitForValue({
            description: "source has opened before replacement",
            intervalMs: 1,
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.dest?.path === destinationPath &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0,
                ),
        });
        // Replacing after the open isolates post-publication deletion from the new resume identity check.
        renameSync(sourcePath, retainedOriginal);
        writeFileSync(sourcePath, "replacement must survive");
        const completed = await client.waitForOperation(operationId);
        // Identity-guarded cleanup reports a partial result instead of deleting a replacement path.
        const termination = z
            .object({
                state: z.literal("failed"),
                termination: z.object({ error: z.string() }),
            })
            .parse(completed.result.structuredContent);
        expect(termination.termination.error).toContain("changed");
        expect(
            (
                await client.callTool("read_file", {
                    device_id: options.sourceDevice,
                    path: sourcePath,
                    encoding: "text",
                })
            ).result.structuredContent?.content,
        ).toBe("replacement must survive");
        // Destination publication remains visible even though destructive source cleanup failed.
        expect(
            (
                await client.callTool("stat_path", {
                    device_id: options.destinationDevice,
                    path: destinationPath,
                })
            ).result.structuredContent,
        ).toMatchObject({ is_file: true });
    });
}
