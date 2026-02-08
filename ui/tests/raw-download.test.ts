import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "../src/api-client";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "node:net";
import {
    ProcessManager,
    waitForPort,
    waitForLogMessage,
    TempFileManager,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../../target/debug/redoor-agent");
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
        const projectRoot = path.join(__dirname, "../..");

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
        testAgent = agents.find((a) => a.name === AGENT_NAME)!;
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
        const largeContent = "x".repeat(1024 * 1024); // 1MB, spans ~16 chunks at 64KB each
        const testFilePath = tempFiles.create(largeContent, {
            suffix: ".txt",
        });

        const projectRoot = path.join(__dirname, "../..");
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
        )!;
        expect(ephemeralAgent).toBeDefined();

        // Start the download in the background
        const downloadPromise = ephemeralAgent.raw(testFilePath);

        // Give a moment for download to start, then kill the agent
        await new Promise((resolve) => setTimeout(resolve, 50));
        processManager.kill(ephemeralAgentPid);

        // The download should fail with an error or complete (if data was already sent),
        // but it must NOT hang forever
        const result = await Promise.race([
            downloadPromise
                .then((data) => ({ ok: true, data }))
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

        // The download should have either completed (got data before kill)
        // or failed with an error — but it must NOT hang
        expect(result).toBeDefined();
    }, 15000);

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

        const url = `${apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(testAgent.id)}/raw/${encodeURIComponent(testFilePath)}?download=1`;
        const response = await fetch(url);
        console.log(
            "Content-Disposition headers:",
            response.headers.get("Content-Disposition"),
        );
        expect(response.headers.get("Content-Disposition")).toMatch(
            /attachment/,
        );
        expect(response.headers.get("Content-Disposition")).toMatch(/\.txt/);
    });
});
