import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient, Agent, type TransferProgressEntry } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForLogMessage,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "smart-move-test-agent";

describe("Smart Move API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let sourceAgent: Agent;
    let destinationAgent: Agent;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-move-source-cwd" }),
        });
        apiClient = setup.apiClient;
        sourceAgent = setup.testAgent;

        const serverProcess = processManager.getProcess(setup.serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }
        const destinationName = "smart-move-destination-agent";
        const connected = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${destinationName},`,
            ),
            10000,
        );
        processManager.spawnAgent({
            wsAddress: `ws://127.0.0.1:${setup.serverPort}/ws`,
            name: destinationName,
            cwd: tempFiles.tempDirectory({ suffix: "-move-destination-cwd" }),
        });
        await connected;
        destinationAgent = await waitForValue({
            description: "smart move destination agent",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) => agent.name === destinationName,
                ),
        });
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
        processManager.killAll();
    });

    /** Polls the public row because move work continues after the REST response returns. */
    async function waitForMove(moveRequestId: number) {
        return waitForValue({
            description: `completed move ${moveRequestId}`,
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === moveRequestId &&
                        transfer.state === "completed",
                ),
        });
    }

    it("moves a file on one agent and exposes one logical move", async () => {
        const sourcePath = tempFiles.create("same-agent move", {
            suffix: ".txt",
        });
        const destPath = tempFiles.tempFile({ suffix: ".txt" });
        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
        );
        const move = await waitForMove(response.move_request_id);

        // A distinct direction lets transfer history identify move semantics rather than copy.
        expect(move.direction).toBe("move");
        // Reading the destination verifies the move published the complete file.
        expect(Buffer.from(await sourceAgent.raw(destPath)).toString()).toBe(
            "same-agent move",
        );
        // A completed move must not leave the original path behind.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
        const related = (
            await apiClient.getTransferProgress()
        ).transfers.filter(
            (transfer) =>
                transfer.source?.path === sourcePath ||
                transfer.dest?.path === destPath,
        );
        // Internal copy/delete commands must remain hidden behind one public move row.
        expect(related).toHaveLength(1);
    });

    it("moves a nested directory on one agent", async () => {
        const sourcePath = tempFiles.tempFile({ suffix: "-move-dir" });
        const destPath = tempFiles.tempFile({ suffix: "-moved-dir" });
        await fs.mkdir(path.join(sourcePath, "nested"), { recursive: true });
        await fs.writeFile(
            path.join(sourcePath, "nested", "value.txt"),
            "nested move",
        );

        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
        );
        await waitForMove(response.move_request_id);

        // Nested content proves directory moves preserve their full tree.
        expect(
            await fs.readFile(
                path.join(destPath, "nested", "value.txt"),
                "utf8",
            ),
        ).toBe("nested move");
        // Directory completion includes removal of the original tree.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("streams a file across agents before deleting the source", async () => {
        const content = "cross-agent move".repeat(4096);
        const sourcePath = tempFiles.create(content, { suffix: ".bin" });
        const destPath = tempFiles.tempFile({ suffix: ".bin" });

        const response = await sourceAgent.moveTo(
            { agent: destinationAgent.id, path: destPath },
            sourcePath,
        );
        const move = await waitForMove(response.move_request_id);

        // Destination endpoint identity confirms the cross-agent route was retained publicly.
        expect(move.dest?.agent).toBe(destinationAgent.id);
        // Destination bytes must be complete before the move can report completion.
        expect(
            Buffer.from(await destinationAgent.raw(destPath)).toString(),
        ).toBe(content);
        // Source deletion after successful streaming distinguishes move from copy.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("streams a directory across agents before deleting the source tree", async () => {
        const sourcePath = tempFiles.tempFile({ suffix: "-remote-source-dir" });
        const destPath = tempFiles.tempFile({ suffix: "-remote-dest-dir" });
        await fs.mkdir(path.join(sourcePath, "child"), { recursive: true });
        await fs.writeFile(
            path.join(sourcePath, "child", "remote.txt"),
            "remote dir",
        );

        const response = await sourceAgent.moveTo(
            { agent: destinationAgent.id, path: destPath },
            sourcePath,
        );
        await waitForMove(response.move_request_id);

        // Nested destination content proves tar-backed directory transport completed successfully.
        expect(
            await fs.readFile(
                path.join(destPath, "child", "remote.txt"),
                "utf8",
            ),
        ).toBe("remote dir");
        // Cross-agent directory deletion must happen only after extraction succeeds.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("overrides an existing file and removes the source", async () => {
        const sourcePath = tempFiles.create("replacement", { suffix: ".txt" });
        const destPath = tempFiles.create("old value", { suffix: ".txt" });

        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
            { on_existing: "override" },
        );
        await waitForMove(response.move_request_id);

        // Override must publish the source bytes instead of retaining old destination content.
        expect(await fs.readFile(destPath, "utf8")).toBe("replacement");
        // Successful override is still a move and therefore removes the original.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("merges directories before removing the source tree", async () => {
        const sourcePath = tempFiles.tempFile({ suffix: "-merge-source" });
        const destPath = tempFiles.tempFile({ suffix: "-merge-dest" });
        await fs.mkdir(sourcePath, { recursive: true });
        await fs.mkdir(destPath, { recursive: true });
        await fs.writeFile(path.join(sourcePath, "shared.txt"), "new shared");
        await fs.writeFile(
            path.join(sourcePath, "source-only.txt"),
            "source only",
        );
        await fs.writeFile(path.join(destPath, "shared.txt"), "old shared");
        await fs.writeFile(path.join(destPath, "dest-only.txt"), "dest only");

        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
            { on_existing: "merge" },
        );
        await waitForMove(response.move_request_id);

        // Merge replaces conflicting entries with source content.
        expect(
            await fs.readFile(path.join(destPath, "shared.txt"), "utf8"),
        ).toBe("new shared");
        // Merge preserves entries that existed only at the destination.
        expect(
            await fs.readFile(path.join(destPath, "dest-only.txt"), "utf8"),
        ).toBe("dest only");
        // Merge also publishes source-only entries.
        expect(
            await fs.readFile(path.join(destPath, "source-only.txt"), "utf8"),
        ).toBe("source only");
        // The fallback remains a move only after all merged content is published.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("preserves the source when existing mode rejects the destination", async () => {
        const sourcePath = tempFiles.create("source remains", {
            suffix: ".txt",
        });
        const destPath = tempFiles.create("destination remains", {
            suffix: ".txt",
        });
        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
            { on_existing: "error" },
        );
        const errored = await waitForValue({
            description: "errored conflicting move",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.request_id === response.move_request_id &&
                        transfer.state === "errored",
                ),
        });

        // Surfacing the conflict on the logical row gives asynchronous callers the failure.
        expect(errored.error).toContain("Destination already exists");
        // Failed publication must never trigger source deletion.
        expect(await fs.readFile(sourcePath, "utf8")).toBe("source remains");
        // Error mode must preserve the pre-existing destination too.
        expect(await fs.readFile(destPath, "utf8")).toBe("destination remains");
    });

    it("preserves both paths when a cross-agent destination already exists", async () => {
        const sourcePath = tempFiles.create("remote source remains", {
            suffix: ".txt",
        });
        const destPath = tempFiles.create("remote destination remains", {
            suffix: ".txt",
        });
        const response = await sourceAgent.moveTo(
            { agent: destinationAgent.id, path: destPath },
            sourcePath,
            { on_existing: "error" },
        );
        await waitForValue({
            description: "errored cross-agent conflicting move",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.request_id === response.move_request_id &&
                        transfer.state === "errored",
                ),
        });

        // Destination rejection occurs before source production and therefore cannot authorize deletion.
        expect(await fs.readFile(sourcePath, "utf8")).toBe(
            "remote source remains",
        );
        // Error mode must preserve content already present on the destination agent.
        expect(await fs.readFile(destPath, "utf8")).toBe(
            "remote destination remains",
        );
    });

    it("preserves the source when cross-agent destination setup fails", async () => {
        const sourcePath = tempFiles.create("source after failed setup", {
            suffix: ".txt",
        });
        const missingParent = tempFiles.tempFile({ suffix: "-missing-parent" });
        const destPath = path.join(missingParent, "destination.txt");
        const response = await sourceAgent.moveTo(
            { agent: destinationAgent.id, path: destPath },
            sourcePath,
        );
        const errored = await waitForValue({
            description: "errored cross-agent destination setup",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.request_id === response.move_request_id &&
                        transfer.state === "errored",
                ),
        });

        // A destination-side setup error must terminate the logical move visibly.
        expect(errored.error).toBeTruthy();
        // Failed destination publication must leave the source untouched.
        expect(await fs.readFile(sourcePath, "utf8")).toBe(
            "source after failed setup",
        );
        // Failed setup must not create a partial destination tree.
        await expect(fs.stat(destPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rejects identical endpoints before starting work", async () => {
        const sourcePath = tempFiles.create("same endpoint", {
            suffix: ".txt",
        });

        // Identical source and destination cannot represent a useful move.
        await expect(
            sourceAgent.moveTo(
                { agent: sourceAgent.id, path: sourcePath },
                sourcePath,
            ),
        ).rejects.toMatchObject({ status: 400 });
        // Validation must leave the source untouched.
        expect(await fs.readFile(sourcePath, "utf8")).toBe("same endpoint");
    });
});
