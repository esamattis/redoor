import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "../src/api-client";
import path from "node:path";
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
