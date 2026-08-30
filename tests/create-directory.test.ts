import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Agent } from "#ui/api-client";
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

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("should create nested directories via REST endpoint", async () => {
        const createdDirectoryPath = path.join(
            tempFiles.tempDirectory({ suffix: "-mkdir-root" }),
            "nested",
            "child",
        );

        const mkdirUrl = testAgent
            .getRawUrl(createdDirectoryPath)
            .replace("/raw/", "/mkdir/");
        const rawResponse = await fetch(mkdirUrl, {
            method: "POST",
            headers: testAgent.getAuthHeaders(),
        });
        // Resource creation uses 201 so callers can distinguish it from command-style success.
        expect(rawResponse.status).toBe(201);
        const response: { path: string } = await rawResponse.json();

        // Returning the created path confirms the API response identifies the target directory.
        expect(response.path).toBe(createdDirectoryPath);

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);

        // A directory on disk proves the agent created all missing path segments recursively.
        expect(createdDirectoryStats.isDirectory()).toBe(true);
    });

    it("should apply explicit numeric ownership", async () => {
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid === undefined || gid === undefined) {
            throw new Error("Unix ownership APIs are required for this test");
        }
        const createdDirectoryPath = path.join(
            tempFiles.tempDirectory({ suffix: "-mkdir-owner" }),
            "owned",
        );

        await testAgent.createDirectory(createdDirectoryPath, {
            owner: String(uid),
            group: String(gid),
        });

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);
        // Matching numeric IDs prove the API forwarded and applied both explicit dimensions.
        expect(createdDirectoryStats.uid).toBe(uid);
        expect(createdDirectoryStats.gid).toBe(gid);
    });

    it("should inherit directory ownership from its parent", async () => {
        const parentPath = tempFiles.tempDirectory({
            suffix: "-mkdir-inherit",
        });
        const createdDirectoryPath = path.join(parentPath, "inherited");
        const parentStats = await fs.stat(parentPath);

        await testAgent.createDirectory(createdDirectoryPath, {
            inherit_owner: true,
            inherit_group: true,
        });

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);
        // Independent inheritance flags must copy the immediate parent's owner and group.
        expect(createdDirectoryStats.uid).toBe(parentStats.uid);
        expect(createdDirectoryStats.gid).toBe(parentStats.gid);
    });

    it("should reject conflicting owner options before creating a directory", async () => {
        const createdDirectoryPath = path.join(
            tempFiles.tempDirectory({ suffix: "-mkdir-conflict" }),
            "not-created",
        );

        await expect(
            testAgent.createDirectory(createdDirectoryPath, {
                owner: "0",
                inherit_owner: true,
            }),
        ).rejects.toThrow("Cannot specify both owner and inherit_owner=true");
        // Absence on disk proves validation happened before the command reached filesystem mutation.
        await expect(fs.access(createdDirectoryPath)).rejects.toThrow();
    });

    it("should report an unknown owner without creating a directory", async () => {
        const createdDirectoryPath = path.join(
            tempFiles.tempDirectory({ suffix: "-mkdir-unknown-owner" }),
            "not-created",
        );
        const owner = `redoor-missing-${process.pid}-${Date.now()}`;

        await expect(
            testAgent.createDirectory(createdDirectoryPath, { owner }),
        ).rejects.toThrow(`Owner '${owner}' does not exist on the agent`);
        // Name resolution must complete before recursive directory creation starts.
        await expect(fs.access(createdDirectoryPath)).rejects.toThrow();
    });
});
