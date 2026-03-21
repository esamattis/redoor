import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient, Agent } from "@/api-client";
import path from "node:path";
import fs from "node:fs/promises";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const SERVER_PATH = path.join(__dirname, "../target/debug/redoor");
const AGENT_PATH = path.join(__dirname, "../target/debug/redoor-agent");
const AGENT_NAME = "raw-delete-test-agent";

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

        const setup = await startServerAndAgent({
            processManager,
            serverPath: SERVER_PATH,
            agentPath: AGENT_PATH,
            agentName: AGENT_NAME,
            projectRoot,
        });

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
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
