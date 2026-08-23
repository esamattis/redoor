import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
} from "./test-utils";

describe.skipIf(process.platform !== "darwin")("macOS Trash API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let testAgent: Agent;
    let root: string;

    beforeAll(async () => {
        root = tempFiles.tempDirectory({ suffix: "-macos-trash-suite" });
        const setup = await startServerAndAgent({
            processManager,
            agentName: "macos-trash-test-agent",
            agentCwd: root,
        });
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("advertises native move support without inventory support", async () => {
        // macOS can accept delete-to-trash while the Redoor Trash route remains unavailable.
        expect(testAgent.supportsMoveToTrash).toBe(true);
        expect(testAgent.supportsTrash).toBe(false);
        await expect(testAgent.listTrash()).rejects.toMatchObject({
            status: 400,
        });
    });

    it("moves a file to native Trash and cleans the exact test item", async () => {
        const name = `redoor-trash-integration-${randomUUID()}`;
        const source = path.join(root, name);
        const destination = path.join(os.homedir(), ".Trash", name);
        await fs.rm(destination, { force: true });
        onTestFinished(async () => {
            await fs.rm(destination, { force: true });
        });
        await fs.writeFile(source, "native trash contents");

        const response = await testAgent.deleteFile(source, { trash: true });

        // The API remains compatible with permanent deletion and reports the original path.
        expect(response.path).toBe(source);
        await expect(fs.access(source)).rejects.toThrow();
        // Reading the UUID path proves Foundation moved this item before cleanup removes it.
        await expect(fs.readFile(destination, "utf8")).resolves.toBe(
            "native trash contents",
        );
    });
});
