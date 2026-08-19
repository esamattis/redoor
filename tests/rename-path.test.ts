import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";
import { testPorts } from "#test-ports";

const AGENT_NAME = "rename-path-test-agent";

describe("Rename Path API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let testAgent: Agent;
    let agentCwd: string;

    beforeAll(async () => {
        agentCwd = tempFiles.tempDirectory({ suffix: "-agent-cwd" });
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd,
        });

        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("atomically renames files and directories through the agent", async () => {
        const sourceFile = path.join(agentCwd, "before.txt");
        const renamedFile = path.join(agentCwd, "after.txt");
        const sourceDirectory = path.join(agentCwd, "before-directory");
        const renamedDirectory = path.join(agentCwd, "after-directory");
        await fs.writeFile(sourceFile, "preserved content");
        await fs.mkdir(sourceDirectory);
        await fs.writeFile(path.join(sourceDirectory, "nested.txt"), "nested");

        const fileResponse = await testAgent.renamePath(
            agentCwd,
            "before.txt",
            "after.txt",
        );
        const directoryResponse = await testAgent.renamePath(
            agentCwd,
            "before-directory",
            "after-directory",
        );

        // Both response paths let clients replace stale routes without reconstructing the request.
        expect(fileResponse).toEqual({
            source_path: sourceFile,
            dest_path: renamedFile,
        });
        // Directory renames use the same command rather than falling back to streamed copying.
        expect(directoryResponse.dest_path).toBe(renamedDirectory);
        // Preserved content proves the file was moved rather than recreated as an empty file.
        await expect(fs.readFile(renamedFile, "utf8")).resolves.toBe(
            "preserved content",
        );
        // A nested child proves directory contents moved with the directory entry.
        await expect(
            fs.readFile(path.join(renamedDirectory, "nested.txt"), "utf8"),
        ).resolves.toBe("nested");
        // The old paths disappearing confirms the rename completed at the requested source names.
        await expect(fs.stat(sourceFile)).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(fs.stat(sourceDirectory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each([
        { dir: "relative", old: "before.txt", new: "after.txt" },
        { dir: "/tmp", old: "nested/before.txt", new: "after.txt" },
        { dir: "/tmp", old: "before.txt", new: "../after.txt" },
        { dir: "/tmp", old: ".", new: "after.txt" },
        { dir: "/tmp", old: "before.txt", new: ".." },
    ])("rejects rename paths that are not names in one absolute directory", async (request) => {
        const response = await fetch(
            `http://127.0.0.1:${testPorts.vitest}/api/v1/agents/${encodeURIComponent(testAgent.id)}/rename`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...testAgent.getAuthHeaders(),
                },
                body: JSON.stringify(request),
            },
        );

        // Invalid path shapes must be rejected before any filesystem command reaches the agent.
        expect(response.status).toBe(400);
    });
});
