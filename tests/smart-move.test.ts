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
        // Same-FS missing destinations must report the renameat2 path, not copy/delete.
        expect(move.atomic).toBe(true);
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

        const sourceInode = (await fs.lstat(sourcePath, { bigint: true })).ino;
        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
        );
        const move = await waitForMove(response.move_request_id);

        // Same-FS missing directory destinations must use renameat2, not copy/delete.
        expect(move.atomic).toBe(true);
        // Preserving the directory inode proves the tree was renamed rather than reconstructed.
        expect((await fs.lstat(destPath, { bigint: true })).ino).toBe(
            sourceInode,
        );
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
        // Streaming plus source deletion is not a renameat2 publication.
        expect(move.atomic).toBe(false);
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
        const sourceInode = (await fs.lstat(sourcePath, { bigint: true })).ino;

        const response = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: destPath },
            sourcePath,
            { on_existing: "override" },
        );
        const move = await waitForMove(response.move_request_id);

        // Same-filesystem overrides exchange the destination atomically before cleanup.
        expect(move.atomic).toBe(true);
        // Override must publish the source bytes instead of retaining old destination content.
        expect(await fs.readFile(destPath, "utf8")).toBe("replacement");
        // Preserving the source inode proves same-filesystem override used rename rather than copying.
        expect((await fs.lstat(destPath, { bigint: true })).ino).toBe(sourceInode);
        // Successful override is still a move and therefore removes the original.
        await expect(fs.stat(sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("atomically overrides existing directories, files, and symlinks", async () => {
        const directorySource = tempFiles.tempFile({
            suffix: "-override-directory-source",
        });
        const fileDestination = tempFiles.create("old file", {
            suffix: "-override-file-destination",
        });
        await fs.mkdir(directorySource);
        await fs.writeFile(path.join(directorySource, "source.txt"), "directory");
        const directoryInode = (
            await fs.lstat(directorySource, { bigint: true })
        ).ino;

        const directoryResponse = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: fileDestination },
            directorySource,
            { on_existing: "override" },
        );
        const directoryMove = await waitForMove(directoryResponse.move_request_id);

        // Directory-over-file must stay on the atomic exchange path.
        expect(directoryMove.atomic).toBe(true);
        // A directory must replace a file even though a plain POSIX replacement rename rejects that pair.
        expect(await fs.readFile(path.join(fileDestination, "source.txt"), "utf8")).toBe(
            "directory",
        );
        // The source directory inode at the destination demonstrates an atomic exchange, not reconstruction.
        expect((await fs.lstat(fileDestination, { bigint: true })).ino).toBe(
            directoryInode,
        );
        // Cleanup after exchange must remove the displaced file from the old source name.
        await expect(fs.lstat(directorySource)).rejects.toMatchObject({
            code: "ENOENT",
        });

        const fileSource = tempFiles.create("file over directory", {
            suffix: "-override-file-source",
        });
        const directoryDestination = tempFiles.tempFile({
            suffix: "-override-directory-destination",
        });
        await fs.mkdir(directoryDestination);
        await fs.writeFile(
            path.join(directoryDestination, "old.txt"),
            "old directory child",
        );
        const fileInode = (await fs.lstat(fileSource, { bigint: true })).ino;

        const fileResponse = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: directoryDestination },
            fileSource,
            { on_existing: "override" },
        );
        const fileMove = await waitForMove(fileResponse.move_request_id);

        // File-over-directory must stay on the atomic exchange path.
        expect(fileMove.atomic).toBe(true);
        // Override must remove the whole non-empty destination directory and publish the file.
        expect(await fs.readFile(directoryDestination, "utf8")).toBe(
            "file over directory",
        );
        // Keeping the file inode verifies the destination changed through atomic rename exchange.
        expect((await fs.lstat(directoryDestination, { bigint: true })).ino).toBe(
            fileInode,
        );
        // Recursive cleanup must remove the displaced non-empty directory at the source name.
        await expect(fs.lstat(fileSource)).rejects.toMatchObject({ code: "ENOENT" });

        const symlinkSource = tempFiles.create("file over symlink", {
            suffix: "-override-symlink-source",
        });
        const symlinkDestination = tempFiles.tempFile({
            suffix: "-override-symlink-destination",
        });
        const missingTarget = tempFiles.tempFile({
            suffix: "-override-missing-link-target",
        });
        await fs.symlink(missingTarget, symlinkDestination);
        const symlinkSourceInode = (
            await fs.lstat(symlinkSource, { bigint: true })
        ).ino;

        const symlinkResponse = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: symlinkDestination },
            symlinkSource,
            { on_existing: "override" },
        );
        const symlinkMove = await waitForMove(symlinkResponse.move_request_id);

        // File-over-symlink must stay on the atomic exchange path.
        expect(symlinkMove.atomic).toBe(true);
        // Dangling symlinks are existing directory entries and must be replaced rather than followed.
        expect(await fs.readFile(symlinkDestination, "utf8")).toBe(
            "file over symlink",
        );
        // The original source inode confirms the symlink replacement stayed on the atomic path.
        expect((await fs.lstat(symlinkDestination, { bigint: true })).ino).toBe(
            symlinkSourceInode,
        );
        // The exchanged symlink must be removed from the source path after publication.
        await expect(fs.lstat(symlinkSource)).rejects.toMatchObject({
            code: "ENOENT",
        });

        const directoryOverDirectorySource = tempFiles.tempFile({
            suffix: "-override-directory-over-directory-source",
        });
        const directoryOverDirectoryDestination = tempFiles.tempFile({
            suffix: "-override-directory-over-directory-destination",
        });
        await fs.mkdir(directoryOverDirectorySource);
        await fs.mkdir(directoryOverDirectoryDestination);
        await fs.writeFile(
            path.join(directoryOverDirectorySource, "new.txt"),
            "new directory",
        );
        await fs.writeFile(
            path.join(directoryOverDirectoryDestination, "old.txt"),
            "old directory",
        );
        const directoryOverDirectoryInode = (
            await fs.lstat(directoryOverDirectorySource, { bigint: true })
        ).ino;

        const directoryOverDirectoryResponse = await sourceAgent.moveTo(
            { agent: sourceAgent.id, path: directoryOverDirectoryDestination },
            directoryOverDirectorySource,
            { on_existing: "override" },
        );
        const directoryOverDirectoryMove = await waitForMove(
            directoryOverDirectoryResponse.move_request_id,
        );

        // Non-empty directory replacement cannot use a POSIX rename, so this must stay atomic.
        expect(directoryOverDirectoryMove.atomic).toBe(true);
        // The source tree must occupy the destination name after the exchange.
        expect(
            await fs.readFile(
                path.join(directoryOverDirectoryDestination, "new.txt"),
                "utf8",
            ),
        ).toBe("new directory");
        // Old destination children must not remain after the exchanged tree is published.
        await expect(
            fs.lstat(path.join(directoryOverDirectoryDestination, "old.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        // Keeping the source directory inode proves the destination was exchanged, not rebuilt.
        expect(
            (await fs.lstat(directoryOverDirectoryDestination, { bigint: true }))
                .ino,
        ).toBe(directoryOverDirectoryInode);
        // Cleanup after exchange must remove the displaced destination tree from the source name.
        await expect(fs.lstat(directoryOverDirectorySource)).rejects.toMatchObject({
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
