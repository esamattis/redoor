import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import type { TransferProgressEntry } from "@/api-client";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "node:net";
import {
    ProcessManager,
    waitForPort,
    waitForLogMessage,
    TempFileManager,
    waitForValue,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "raw-test-agent";

/**
 * Finds an available ephemeral port to avoid conflicts with other tests.
 */
async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

describe("Raw Download API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let apiClient: ApiClient;
    let serverPid: number;
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.cleanup();
    });

    beforeAll(async () => {
        const projectRoot = path.join(__dirname, "..");

        // Get a dynamic port to avoid conflicts
        serverPort = await getAvailablePort();
        apiClient = new ApiClient(`http://127.0.0.1:${serverPort}`);
        const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

        process.env.REDOOR_PORT = serverPort.toString();
        serverPid = processManager.spawn(SERVER_PATH, [], projectRoot);
        await waitForPort(serverPort);

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        // Start waiting for log message BEFORE spawning agent to avoid race condition
        const waitForAgentPromise = waitForLogMessage(
            serverProcess,
            /Agent registered: agent_id=/,
            10000,
        );

        processManager.spawn(AGENT_PATH, [wsUrl, AGENT_NAME], projectRoot);

        await waitForAgentPromise;

        const agents = await apiClient.listAgents();
        const connectedAgent = agents.find((a) => a.name === AGENT_NAME);
        if (!connectedAgent) {
            throw new Error(`Agent ${AGENT_NAME} was not registered`);
        }

        testAgent = connectedAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(() => {
        processManager.killAll();
    });

    it("should download small file via raw endpoint", async () => {
        const testContent = "Hello, World!\nThis is a test file.";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result).toString("utf-8");
        expect(downloadedContent).toBe(testContent);
    });

    it("should download large file via raw endpoint", async () => {
        const largeContent = "x".repeat(100 * 1024);
        const testFilePath = tempFiles.create(largeContent, { suffix: ".txt" });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result).toString("utf-8");
        expect(downloadedContent.length).toBe(largeContent.length);
        expect(downloadedContent).toBe(largeContent);
    });

    it("should handle binary file download", async () => {
        const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253]);
        const testFilePath = tempFiles.create(binaryContent, {
            suffix: ".bin",
        });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result);
        expect(Buffer.compare(downloadedContent, binaryContent)).toBe(0);
    });

    it("should return error for non-existent file", async () => {
        const nonExistentPath = "/tmp/non-existent-file-12345.txt";
        await expect(testAgent.raw(nonExistentPath)).rejects.toThrow();
    });

    it("should return error for non-existent agent", async () => {
        const fakeAgent = new Agent(apiClient.baseUrl, {
            id: "non-existent-agent-id",
            name: "fake",
        });
        // Server should return an error instead of hanging forever
        await expect(fakeAgent.raw("/tmp/somefile")).rejects.toThrow(
            /not found/i,
        );
    });

    it("should handle agent disconnect during download", async () => {
        // Create a large file that takes multiple chunks to transfer
        const largeContent = "x".repeat(32 * 1024 * 1024);
        const testFilePath = tempFiles.create(largeContent, {
            suffix: ".txt",
        });
        const fileSize = Buffer.byteLength(largeContent);

        const projectRoot = path.join(__dirname, "..");
        const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
        const ephemeralAgentName = "ephemeral-raw-agent";

        // Spawn a second agent that we can kill mid-transfer
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const waitForEphemeralAgent = waitForLogMessage(
            serverProcess,
            new RegExp(`Agent registered:.*agent_name=${ephemeralAgentName}`),
            10000,
        );

        const ephemeralAgentPid = processManager.spawn(
            AGENT_PATH,
            [wsUrl, ephemeralAgentName],
            projectRoot,
        );

        await waitForEphemeralAgent;

        const agents = await apiClient.listAgents();
        const ephemeralAgent = agents.find(
            (a) => a.name === ephemeralAgentName,
        );
        if (!ephemeralAgent) {
            throw new Error(`Agent ${ephemeralAgentName} was not registered`);
        }
        expect(ephemeralAgent).toBeDefined();

        const ephemeralAgentProcess =
            processManager.getProcess(ephemeralAgentPid);
        if (!ephemeralAgentProcess) {
            throw new Error("Ephemeral agent process not found");
        }

        // Waiting for the agent's download log ensures we interrupt an active transfer.
        const downloadPromise = fetch(ephemeralAgent.getRawUrl(testFilePath));

        await waitForLogMessage(
            ephemeralAgentProcess,
            /command=RawDownload/,
            10000,
        );

        const observedTransfer = await waitForValue({
            description: "download progress row",
            timeoutMs: 20000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === ephemeralAgent.id &&
                        transfer.path === testFilePath &&
                        transfer.direction === "download" &&
                        transfer.total_bytes === BigInt(fileSize),
                );
            },
        });

        // The download direction check proves the shared endpoint tracks download rows separately from uploads.
        expect(observedTransfer.direction).toBe("download");
        // The total size check confirms the server reuses the computed content length for progress.
        expect(observedTransfer.total_bytes).toBe(BigInt(fileSize));
        // A tracked row proves the router registered this transfer even if it completed before polling observed the active state.
        expect(["active", "completed", "errored"]).toContain(
            observedTransfer.state,
        );

        processManager.kill(ephemeralAgentPid);

        // The download should fail with an error or complete early if the disconnect races late,
        // but it must NOT hang forever.
        const result = await Promise.race([
            downloadPromise
                .then(async (response) => ({
                    ok: response.ok,
                    status: response.status,
                    body: await response.text(),
                }))
                .catch((e: Error) => ({ ok: false, error: e.message })),
            new Promise((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Download hung for 10s after agent disconnect",
                            ),
                        ),
                    10000,
                ),
            ),
        ]);

        const finishedTransfer = await waitForValue({
            description: "finished download progress row after disconnect",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === observedTransfer.request_id &&
                        (transfer.state === "errored" ||
                            transfer.state === "completed"),
                );
            },
        });

        // Reaching this assertion confirms router cleanup closed the request path instead of hanging the client.
        expect(result).toBeDefined();
        if (finishedTransfer.state === "errored") {
            // The errored state check ensures disconnect cleanup keeps the transfer row queryable when the transfer is interrupted.
            expect(finishedTransfer.transferred_bytes).toBeLessThan(
                finishedTransfer.total_bytes,
            );
            // The retained error text gives callers an explicit reason for the failed transfer.
            expect(finishedTransfer.error).toMatch(
                /disconnect|stream|closed|lost/i,
            );
        } else {
            // A completed state is valid when the disconnect races after the full response has already been delivered.
            expect(finishedTransfer.state).toBe("completed");
            // Full progress proves the transfer finished before the disconnect cleanup could interrupt it.
            expect(finishedTransfer.transferred_bytes).toBe(
                finishedTransfer.total_bytes,
            );
            // A null error confirms the late disconnect did not overwrite a successful completion.
            expect(finishedTransfer.error).toBeNull();
        }
    }, 30000);

    it("should return proper error for permission denied", async () => {
        const testFilePath = tempFiles.create("secret", { suffix: ".txt" });
        fs.chmodSync(testFilePath, 0o000);

        try {
            // The agent should propagate the actual OS error message
            await expect(testAgent.raw(testFilePath)).rejects.toThrow(
                /permission denied/i,
            );
        } finally {
            // Restore permissions so cleanup works
            fs.chmodSync(testFilePath, 0o644);
        }
    });

    it("should set correct Content-Disposition header", async () => {
        const testContent = "test content";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            download: true,
        });
        console.log(
            "Content-Disposition headers:",
            response.headers.get("Content-Disposition"),
        );
        expect(response.headers.get("Content-Disposition")).toMatch(
            /attachment/,
        );
        expect(response.headers.get("Content-Disposition")).toMatch(/\.txt/);
    });

    it("should indicate range support with Accept-Ranges header", async () => {
        const testContent = "test content for range check";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            method: "HEAD",
        });

        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    });

    it("should return 206 Partial Content for range request", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [0, 9],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-9/100");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe("0123456789");
    });

    it("should handle suffix range request (last N bytes)", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [null, 10],
        });

        expect(response.status).toBe(206);
        // Last 10 bytes should be "0123456789"
        expect(response.headers.get("Content-Range")).toBe("bytes 90-99/100");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe("0123456789");
    });

    it("should handle open-ended range request (from byte to end)", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [50, null],
        });

        expect(response.status).toBe(206);
        // From byte 50 to end (99) = 50 bytes
        expect(response.headers.get("Content-Range")).toBe("bytes 50-99/100");
        expect(response.headers.get("Content-Length")).toBe("50");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(50);
    });

    it("should return 416 for unsatisfiable range", async () => {
        // Create a small test file (10 bytes)
        const testContent = "0123456789";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [100, 200],
        });

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("should handle range request for binary file", async () => {
        // Create binary file with pattern 0x00-0xFF repeated
        const pattern = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const testContent = Buffer.concat([pattern, pattern, pattern, pattern]); // 1024 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".bin" });

        const response = await testAgent.download(testFilePath, {
            range: [100, 109],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe(
            "bytes 100-109/1024",
        );
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(10);

        // Verify the content matches expected bytes (wrapping around at 256)
        const expected = new Uint8Array([
            100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
        ]);
        const actual = new Uint8Array(data);
        for (let i = 0; i < 10; i++) {
            expect(actual[i]).toBe(expected[i]);
        }
    });

    it("should return 200 OK for full file without Range header", async () => {
        const testContent = "Full file content without range";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath);

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Range")).toBeNull();
        expect(response.headers.get("Content-Length")).toBe(
            testContent.length.toString(),
        );

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe(testContent);
    });

    it("should handle range at end of file", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [95, 99],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 95-99/100");
        expect(response.headers.get("Content-Length")).toBe("5");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(5);
    });

    it("should clamp range end to file size", async () => {
        // Create test file (50 bytes)
        const testContent = "x".repeat(50);
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [40, 100], // Request beyond file size
        });

        expect(response.status).toBe(206);
        // Should clamp to 40-49 (10 bytes)
        expect(response.headers.get("Content-Range")).toBe("bytes 40-49/50");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(10);
    });
});
