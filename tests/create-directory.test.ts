import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Agent } from "@/api-client";
import path from "node:path";
import fs from "node:fs/promises";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "create-directory-test-agent";

describe("Create Directory API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
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

        testAgent = setup.testAgent;
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
        processManager.killAll();
    });

    it("should create nested directories via REST endpoint", async () => {
        const createdDirectoryPath = path.join(
            tempFiles.tempDirectory({ suffix: "-mkdir-root" }),
            "nested",
            "child",
        );

        const response = await testAgent.createDirectory(createdDirectoryPath);

        // Returning the created path confirms the API response identifies the target directory.
        expect(response.path).toBe(createdDirectoryPath);

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);

        // A directory on disk proves the agent created all missing path segments recursively.
        expect(createdDirectoryStats.isDirectory()).toBe(true);
    });
});
