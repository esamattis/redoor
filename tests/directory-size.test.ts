import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "#ui/api-client";

import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "test-agent-directory-size";

describe("directory size", () => {
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

    it("calculates recursive regular-file content bytes", async () => {
        const root = tempFiles.tempDirectory({ suffix: "-size-root" });
        const nested = path.join(root, "nested");
        await mkdir(nested);
        await writeFile(path.join(root, "first.txt"), "12345");
        await writeFile(path.join(nested, "second.txt"), "1234567");

        const response = await testAgent.calculateDirectorySize(root);

        // Directory size represents stored file content and excludes directory and tar metadata.
        expect(response).toEqual({ path: root, size: 12, errors: [] });
    });

    it("ignores symlinks without double-counting their targets", async () => {
        const root = tempFiles.tempDirectory({ suffix: "-partial-size-root" });
        const file = path.join(root, "readable.txt");
        const link = path.join(root, "linked.txt");
        await writeFile(file, "12345");
        await symlink(file, link);

        const response = await testAgent.calculateDirectorySize(root);

        // The target is counted once through its regular path rather than again through the symlink.
        expect(response.size).toBe(5);
        // Symlinks are expected filesystem structure, not failures users need to resolve.
        expect(response.errors).toEqual([]);
    });

    it("rejects paths that are not directories", async () => {
        const file = tempFiles.create("file contents", { suffix: ".txt" });

        // The dedicated route must not silently reinterpret a file metadata size as a directory total.
        await expect(testAgent.calculateDirectorySize(file)).rejects.toThrow(
            "Path is not a directory",
        );
    });
});
