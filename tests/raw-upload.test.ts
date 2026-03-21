import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "node:net";
import {
    ProcessManager,
    waitForPort,
    waitForLogMessage,
    TempFileManager,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "raw-upload-test-agent";

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

describe("Raw Upload API", () => {
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

        // Get a dynamic port to avoid conflicts.
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

        // Start waiting for log message BEFORE spawning agent to avoid race condition.
        const waitForAgentPromise = waitForLogMessage(
            serverProcess,
            /Agent registered: agent_id=/,
            10000,
        );

        processManager.spawn(AGENT_PATH, [wsUrl, AGENT_NAME], projectRoot);

        await waitForAgentPromise;

        const agents = await apiClient.listAgents();
        const connectedAgent = agents.find(
            (agent) => agent.name === AGENT_NAME,
        );
        if (!connectedAgent) {
            throw new Error(`Agent ${AGENT_NAME} was not registered`);
        }

        testAgent = connectedAgent;
    }, 30000);

    afterAll(() => {
        processManager.killAll();
    });

    it("should upload small file via raw endpoint", async () => {
        const uploadContent = "Hello upload!\nThis content came from PUT.";
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        const uploadFile = new File([uploadContent], "upload.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        ).toString("utf-8");

        // Reading the file back verifies the uploaded bytes were persisted as-is.
        expect(downloadedContent).toBe(uploadContent);
    });

    it("should upload binary file via raw endpoint", async () => {
        const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253, 128, 64]);
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".bin" });

        const uploadFile = new File([binaryContent], "upload.bin", {
            type: "application/octet-stream",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        );

        // Byte-for-byte comparison confirms the upload preserved binary payloads exactly.
        expect(Buffer.compare(downloadedContent, binaryContent)).toBe(0);
    });

    it("should replace existing file contents on upload", async () => {
        const originalContent = "old content";
        const replacementContent = "new content from upload";
        const uploadedFilePath = tempFiles.create(originalContent, {
            suffix: ".txt",
        });

        const uploadFile = new File([replacementContent], "replacement.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        ).toString("utf-8");

        // Reading the file back confirms previous contents were fully replaced.
        expect(downloadedContent).toBe(replacementContent);
    });

    it("should upload empty file via raw endpoint", async () => {
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        const uploadFile = new File([""], "empty.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        );

        // Zero-length content verifies the upload path handles the terminal empty-body case.
        expect(downloadedContent.length).toBe(0);
    });

    it("should return error for upload to non-existent agent", async () => {
        const fakeAgent = new Agent(apiClient.baseUrl, {
            id: "non-existent-agent-id",
            name: "fake",
        });
        const uploadFile = new File(["content"], "content.txt", {
            type: "text/plain",
        });

        // Missing agents should fail fast instead of hanging the upload request.
        await expect(
            fakeAgent.upload("/tmp/fake-upload.txt", uploadFile),
        ).rejects.toThrow();
    });

    it("should return error for permission denied upload", async () => {
        const protectedDir = path.join(
            tempFiles.tempFile({ suffix: ".tmp" }),
            "..",
            `blocked-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        fs.mkdirSync(protectedDir, 0o555);

        const uploadedFilePath = path.join(protectedDir, "blocked.txt");
        const uploadUrl = testAgent.getRawUrl(uploadedFilePath);

        try {
            const uploadFile = new File(["secret"], "blocked.txt", {
                type: "text/plain",
            });

            // Depending on the OS and temp directory behavior, creating a file inside a
            // read-only directory may surface either a permission error or a not found style
            // error from the agent, but it must fail instead of succeeding.
            await expect(
                testAgent.upload(uploadedFilePath, uploadFile),
            ).rejects.toThrow();
        } finally {
            fs.chmodSync(protectedDir, 0o755);
            fs.rmdirSync(protectedDir);
        }
    });
});
