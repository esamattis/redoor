import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "../src/api-client";
import path from "node:path";
import { ProcessManager, waitForPort, waitForLogMessage, TempFileManager } from "./test-utils";

const SERVER_PORT = 3000;
const SERVER_PATH = path.join(__dirname, "../../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../../target/debug/redoor-agent");
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const AGENT_NAME = "raw-test-agent";

describe("Raw Download API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    const apiClient = new ApiClient(`http://127.0.0.1:${SERVER_PORT}`);
    let serverPid: number;
    let testAgent: Agent;

    afterEach(() => {
        tempFiles.cleanup();
    });

    beforeAll(async () => {
        const projectRoot = path.join(__dirname, "../..");
        process.env.REDOOR_PORT = SERVER_PORT.toString();
        serverPid = processManager.spawn(SERVER_PATH, [], projectRoot);
        await waitForPort(SERVER_PORT);
        processManager.spawn(AGENT_PATH, [WS_URL, AGENT_NAME], projectRoot);

        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }
        await waitForLogMessage(
            serverProcess,
            /Agent registered: agent_id=/,
            10000,
        );

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
        const testFilePath = tempFiles.create(binaryContent, { suffix: ".bin" });

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
        expect(response.headers.get("Content-Disposition")).toMatch(
            /\.txt/,
        );
    });
});
