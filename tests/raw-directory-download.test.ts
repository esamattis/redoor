import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { TransferProgressEntry } from "#ui/api-client";
import { Agent } from "#ui/api-client";

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    ProcessManager,
    TempFileManager,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";

const execFileAsync = promisify(execFile);
const AGENT_NAME = "raw-directory-download-agent";

/** Lists tar(.gz) member paths with system tar so tests stay free of a Node tar dependency. */
async function listTarMembers(archivePath: string): Promise<string[]> {
    const { stdout } = await execFileAsync("tar", ["-tzf", archivePath]);
    return stdout
        .split("\n")
        .map((entry) => entry.replace(/\/$/, ""))
        .filter((entry) => entry.length > 0);
}

describe("Raw Directory Archive Download API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: Awaited<ReturnType<typeof startServerAndAgent>>["apiClient"];
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });

        apiClient = setup.apiClient;
        testAgent = setup.testAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
        processManager.killAll();
    });

    it("should stream a directory as a tar archive via the raw endpoint", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-dir-archive" });
        await fs.mkdir(path.join(sourceRoot, "nested", "deeper"), {
            recursive: true,
        });
        await fs.mkdir(path.join(sourceRoot, "empty"), { recursive: true });
        await fs.writeFile(
            path.join(sourceRoot, "top.txt"),
            "directory archive root file",
            "utf-8",
        );
        await fs.writeFile(
            path.join(sourceRoot, "nested", "deeper", "child.txt"),
            "directory archive nested file",
            "utf-8",
        );

        const response = await testAgent.download(sourceRoot, {
            download: true,
        });
        // Directory GETs are presented as gzipped tar attachments for browser save-as.
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toMatch(
            /application\/gzip/,
        );
        expect(response.headers.get("Content-Disposition")).toMatch(
            /attachment; filename=".*\.tar\.gz"/,
        );
        // Unknown archive length must not claim a Content-Length that could truncate the body.
        expect(response.headers.get("Content-Length")).toBeNull();

        const archiveBytes = Buffer.from(await response.arrayBuffer());
        // A non-empty body proves the agent tar worker produced stream chunks that the server gzipped.
        expect(archiveBytes.byteLength).toBeGreaterThan(0);
        // Gzip magic bytes confirm REST-edge compression rather than plain tar.
        expect(archiveBytes[0]).toBe(0x1f);
        expect(archiveBytes[1]).toBe(0x8b);

        const archivePath = tempFiles.create(archiveBytes, {
            suffix: ".tar.gz",
        });
        const members = await listTarMembers(archivePath);
        const directoryName = path.basename(sourceRoot);
        // The downloaded directory is the single archive root so extraction preserves its name.
        expect(members).toEqual(
            expect.arrayContaining([
                directoryName,
                `${directoryName}/top.txt`,
                `${directoryName}/nested`,
                `${directoryName}/nested/deeper`,
                `${directoryName}/nested/deeper/child.txt`,
                `${directoryName}/empty`,
            ]),
        );

        const extractRoot = tempFiles.tempDirectory({
            suffix: "-dir-archive-extract",
        });
        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractRoot]);
        // Round-tripping through tar.gz proves nested payload bytes stayed intact.
        expect(
            await fs.readFile(
                path.join(extractRoot, directoryName, "top.txt"),
                "utf-8",
            ),
        ).toBe("directory archive root file");
        expect(
            await fs.readFile(
                path.join(
                    extractRoot,
                    directoryName,
                    "nested",
                    "deeper",
                    "child.txt",
                ),
                "utf-8",
            ),
        ).toBe("directory archive nested file");
        // Empty directory extraction proves directory-only members survive the stream.
        expect(
            (
                await fs.stat(path.join(extractRoot, directoryName, "empty"))
            ).isDirectory(),
        ).toBe(true);

        const completedTransfer = await waitForValue({
            description: "completed directory archive download transfer",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === sourceRoot &&
                        transfer.direction === "download" &&
                        transfer.state === "completed",
                );
            },
        });
        // Download direction keeps archive pulls on the same progress surface as file downloads.
        expect(completedTransfer.direction).toBe("download");
        // Progress tracks plain agent tar bytes before REST gzip, so it can exceed the body size.
        expect(completedTransfer.total_bytes).toBeGreaterThan(0);
        expect(completedTransfer.transferred_bytes).toBe(
            completedTransfer.total_bytes,
        );
    });

    it("should stream an empty directory archive", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-empty-dir-archive" });
        await fs.mkdir(sourceRoot, { recursive: true });

        const response = await testAgent.download(sourceRoot, {
            download: true,
        });
        // Empty directories still produce a valid gzipped tar stream rather than a JSON error.
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toMatch(
            /application\/gzip/,
        );

        const archiveBytes = Buffer.from(await response.arrayBuffer());
        const archivePath = tempFiles.create(archiveBytes, {
            suffix: ".tar.gz",
        });
        const members = await listTarMembers(archivePath);
        // Empty downloads still contain their root so extraction creates the requested directory.
        expect(members).toEqual([path.basename(sourceRoot)]);
    });

    it("should reject range requests for directory archives", async () => {
        const sourceRoot = tempFiles.tempFile({ suffix: "-range-dir-archive" });
        await fs.mkdir(sourceRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "file.txt"), "range-denied");

        const response = await fetch(
            testAgent.getRawUrl(sourceRoot, { download: true }),
            {
                headers: {
                    ...testAgent.getAuthHeaders(),
                    Range: "bytes=0-10",
                },
            },
        );
        // Range is unsupported because tar length is unknown before streaming finishes.
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        expect(body).toEqual(
            expect.objectContaining({
                error: expect.stringMatching(/range/i),
            }),
        );
    });

    it("should return an error when the directory path is missing", async () => {
        await expect(
            testAgent.download("/tmp/missing-directory-archive-path-12345", {
                download: true,
            }),
        ).rejects.toThrow();
    });
});
