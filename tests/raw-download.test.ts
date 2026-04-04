import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    afterEach,
    onTestFinished,
} from "vitest";
import { ApiClient, Agent } from "@/api-client";
import type { TransferProgressEntry } from "@/api-client";

import fs from "node:fs";
import {
    ProcessManager,
    TempFileManager,
    getAvailablePort,
    waitForLogMessage,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";
import { Toxiproxy } from "toxiproxy-node-client";
const AGENT_NAME = "raw-test-agent";

describe("Raw Download API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
    let apiClient: ApiClient;
    let serverPid: number;
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

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
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

        const ephemeralAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: ephemeralAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-ephemeral-agent-cwd" }),
        });

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

        // Waiting for observable transfer progress ensures we interrupt a real in-flight download
        // without depending on a specific agent log line format.
        const downloadPromise = fetch(ephemeralAgent.getRawUrl(testFilePath));

        const observedTransfer = await waitForValue({
            description: "active or finished download progress row",
            timeoutMs: 20000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === ephemeralAgent.id &&
                        transfer.path === testFilePath &&
                        transfer.direction === "download" &&
                        transfer.total_bytes === fileSize &&
                        ((transfer.state === "active" &&
                            transfer.transferred_bytes > 0) ||
                            transfer.state === "completed" ||
                            transfer.state === "errored"),
                );
            },
        });

        // The download direction check proves the shared endpoint tracks download rows separately from uploads.
        expect(observedTransfer.direction).toBe("download");
        // The total size check confirms the server reuses the computed content length for progress.
        expect(observedTransfer.total_bytes).toBe(fileSize);
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

    it("should keep command requests responsive during a throttled download", async () => {
        const chunkSizeBytes = 1024 * 1024;
        const totalBytes = chunkSizeBytes * 8 + 123;
        const downloadContent = Buffer.alloc(totalBytes, "d");
        const sourcePath = tempFiles.create(downloadContent, {
            suffix: ".bin",
        });
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
        const proxyPort = await getAvailablePort();
        const proxy = await toxiproxy.createProxy({
            name: `raw-download-concurrent-command-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            listen: `127.0.0.1:${proxyPort}`,
            upstream: `127.0.0.1:${serverPort}`,
        });
        const proxiedAgentName = "raw-download-proxied-agent";
        const waitForProxiedAgent = waitForLogMessage(
            serverProcess,
            new RegExp(`Agent registered:.*agent_name=${proxiedAgentName}`),
            10000,
        );
        const proxiedAgentPid = processManager.spawnAgent({
            wsAddress: `ws://${proxy.listen}/ws`,
            name: proxiedAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-proxied-download-agent-cwd",
            }),
        });

        onTestFinished(async () => {
            processManager.kill(proxiedAgentPid);
            await proxy.remove().catch(() => undefined);
        });

        await waitForProxiedAgent;

        const agents = await apiClient.listAgents();
        const proxiedAgent = agents.find(
            (agent) => agent.name === proxiedAgentName,
        );
        if (!proxiedAgent) {
            throw new Error(`Agent ${proxiedAgentName} was not registered`);
        }

        await proxy.addToxic({
            name: "slow-download",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                rate: 512,
            },
        });

        const downloadPromise = proxiedAgent.raw(sourcePath);

        const activeTransfer = await waitForValue({
            description: "active download before issuing concurrent command",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === proxiedAgent.id &&
                        transfer.path === sourcePath &&
                        transfer.direction === "download" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                );
            },
        });

        const detailsPromise = proxiedAgent.getDetails();
        const firstCompletion = await Promise.race([
            detailsPromise.then((details) => ({
                winner: "details" as const,
                details,
            })),
            downloadPromise.then((bytes) => ({
                winner: "download" as const,
                bytes,
            })),
        ]);

        // Observing an active row first proves the command raced with a real in-flight download instead of running after completion.
        expect(activeTransfer.state).toBe("active");
        // Finishing the command before the payload proves control messages are not stuck behind the throttled download stream.
        expect(firstCompletion.winner).toBe("details");
        if (firstCompletion.winner !== "details") {
            throw new Error(
                "Download completed before getDetails responded during throttled transfer",
            );
        }
        // Returning the proxied agent name proves the responsive command still reached the intended agent during the download.
        expect(firstCompletion.details.name).toBe(proxiedAgent.name);

        const downloadedContent = Buffer.from(await downloadPromise);

        // Matching bytes prove the throttled download still completes successfully after the concurrent command.
        expect(Buffer.compare(downloadedContent, downloadContent)).toBe(0);
    }, 40000);

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
