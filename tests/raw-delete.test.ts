import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import {
    ProcessManager,
    waitForPort,
    waitForLogMessage,
    TempFileManager,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "raw-delete-test-agent";

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

describe("Raw Delete API", () => {
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

    it("should delete existing file via raw endpoint", async () => {
        const deletedFilePath = tempFiles.create("delete me", {
            suffix: ".txt",
        });

        const response = await testAgent.deleteFile(deletedFilePath);

        // Returning the deleted path confirms the response identifies which file the agent removed.
        expect(response.path).toBe(deletedFilePath);
        // A missing file on disk proves the DELETE endpoint removed the file instead of only acknowledging the request.
        await expect(fs.access(deletedFilePath)).rejects.toThrow();
    });

    it("should return error for deleting non-existent file", async () => {
        const deletedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        // Rejecting here confirms missing files surface as API errors instead of silent success.
        await expect(testAgent.deleteFile(deletedFilePath)).rejects.toThrow();
    });
});
