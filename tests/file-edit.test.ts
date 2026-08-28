import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ApiClient, Agent, encodeFilesystemPath } from "#ui/api-client";
import type { TransferProgressEntry } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "file-edit-test-agent";

describe("File Edit API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let testAgent: Agent;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager,
            agentName: AGENT_NAME,
            agentCwd: tempFiles.tempDirectory({ suffix: "-agent-cwd" }),
        });
        apiClient = setup.apiClient;
        testAgent = setup.testAgent;
    }, 30000);

    afterEach(() => {
        tempFiles.emptyDirs();
    });

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Builds the dedicated editor endpoint while preserving filesystem separators. */
    function editUrl(filePath: string): string {
        return `${apiClient.baseUrl}/api/v1/agents/${encodeURIComponent(testAgent.id)}/edit/${encodeFilesystemPath(filePath)}`;
    }

    /** Starts a controllable two-part edit body after immediately sending its first chunk. */
    function startHeldEdit(filePath: string, first: Buffer, second: Buffer) {
        let streamController:
            ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller;
                controller.enqueue(first);
            },
        });
        const requestOptions = {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(first.length + second.length),
                ...testAgent.getAuthHeaders(),
            },
            body,
            duplex: "half",
        };
        const response = fetch(editUrl(filePath), requestOptions);
        return {
            response,
            finish() {
                if (!streamController) {
                    throw new Error(
                        "Edit stream controller was not initialized",
                    );
                }
                streamController.enqueue(second);
                streamController.close();
            },
            abort(error: Error) {
                streamController?.error(error);
            },
        };
    }

    it("preserves inode, ownership, ordinary mode, and exact bytes", async () => {
        const filePath = tempFiles.create("old content", { suffix: ".txt" });
        fs.chmodSync(filePath, 0o751);
        if (process.getuid?.() === 0) {
            fs.chownSync(filePath, 12345, 12346);
        }
        const before = fs.statSync(filePath, { bigint: true });

        const result = await testAgent.editFile(
            filePath,
            new File(["replacement content is longer"], "edited.txt"),
        );
        const after = fs.statSync(filePath, { bigint: true });

        // The response must identify the selected absolute path and exact body length.
        expect(result).toEqual({
            path: filePath,
            bytes_written: Buffer.byteLength("replacement content is longer"),
        });
        // In-place rewriting must retain device and inode identity.
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
        // The agent must not alter target ownership while committing bytes.
        expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
        // Every ordinary rwx bit is a mandatory successful-edit guarantee.
        expect(Number(after.mode & 0o777n)).toBe(0o751);
        // The final file must contain only the submitted replacement bytes.
        expect(fs.readFileSync(filePath, "utf8")).toBe(
            "replacement content is longer",
        );
    });

    it("rewrites every name of a hard-linked inode", async () => {
        const filePath = tempFiles.create("hard-link old", { suffix: ".txt" });
        const peerPath = `${filePath}-peer`;
        fs.linkSync(filePath, peerPath);
        const before = fs.statSync(filePath, { bigint: true });

        await testAgent.editFile(
            filePath,
            new File(["hard-link new"], "edited.txt"),
        );
        const selectedAfter = fs.statSync(filePath, { bigint: true });
        const peerAfter = fs.statSync(peerPath, { bigint: true });

        // Both names must remain attached to the original inode.
        expect([selectedAfter.ino, peerAfter.ino]).toEqual([
            before.ino,
            before.ino,
        ]);
        // The hard-link count must survive rather than splitting the selected entry away.
        expect(selectedAfter.nlink).toBe(before.nlink);
        // The peer name must expose the newly committed bytes.
        expect(fs.readFileSync(peerPath, "utf8")).toBe("hard-link new");
    });

    it("follows absolute, relative, and chained symlinks without replacing them", async () => {
        const directory = tempFiles.tempDirectory({ suffix: "-symlinks" });
        const target = path.join(directory, "target.txt");
        const absolute = path.join(directory, "absolute.txt");
        const relative = path.join(directory, "relative.txt");
        const chain = path.join(directory, "chain.txt");
        fs.writeFileSync(target, "one");
        fs.symlinkSync(target, absolute);
        fs.symlinkSync("target.txt", relative);
        fs.symlinkSync("relative.txt", chain);
        const targetInode = fs.statSync(target, { bigint: true }).ino;

        await testAgent.editFile(absolute, new File(["two"], "absolute.txt"));
        await testAgent.editFile(chain, new File(["three"], "chain.txt"));

        // Absolute links must remain links with their original link text.
        expect([
            fs.lstatSync(absolute).isSymbolicLink(),
            fs.readlinkSync(absolute),
        ]).toEqual([true, target]);
        // Relative resolution must stay relative to the link's containing directory.
        expect([
            fs.lstatSync(relative).isSymbolicLink(),
            fs.readlinkSync(relative),
        ]).toEqual([true, "target.txt"]);
        // Every member of a multi-link chain must remain untouched.
        expect([
            fs.lstatSync(chain).isSymbolicLink(),
            fs.readlinkSync(chain),
        ]).toEqual([true, "relative.txt"]);
        // Following symlinks must still preserve the target inode.
        expect(fs.statSync(target, { bigint: true }).ino).toBe(targetInode);
        // The final chain edit must reach the regular-file target.
        expect(fs.readFileSync(target, "utf8")).toBe("three");
    });

    it("returns stable errors for dangling links, loops, directories, and missing paths", async () => {
        const directory = tempFiles.tempDirectory({ suffix: "-errors" });
        const dangling = path.join(directory, "dangling");
        const first = path.join(directory, "first");
        const second = path.join(directory, "second");
        fs.symlinkSync("missing", dangling);
        fs.symlinkSync("second", first);
        fs.symlinkSync("first", second);

        const danglingResponse = await fetch(editUrl(dangling), {
            method: "PUT",
            headers: testAgent.getAuthHeaders(),
            body: "new",
        });
        const loopResponse = await fetch(editUrl(first), {
            method: "PUT",
            headers: testAgent.getAuthHeaders(),
            body: "new",
        });
        const directoryResponse = await fetch(editUrl(directory), {
            method: "PUT",
            headers: testAgent.getAuthHeaders(),
            body: "new",
        });

        // A dangling target is absent and must fail before request bytes are accepted.
        expect(danglingResponse.status).toBe(404);
        // Kernel symlink-loop detection must map to an actionable bad request.
        expect(loopResponse.status).toBe(400);
        // Editing a directory must use the stable bad-request mapping.
        expect(directoryResponse.status).toBe(400);
        // Every failed setup must leave the original link entries unchanged.
        expect([fs.readlinkSync(dangling), fs.readlinkSync(first)]).toEqual([
            "missing",
            "second",
        ]);
    });

    it("keeps control commands responsive and reports Edit progress while staging", async () => {
        const filePath = tempFiles.create("old", { suffix: ".txt" });
        const first = Buffer.from("first-edit-part-");
        const second = Buffer.from("second-edit-part");
        const held = startHeldEdit(filePath, first, second);

        const activeTransfer = await waitForValue({
            description: "active edit progress row",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === filePath &&
                        transfer.direction === "edit" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes === first.length,
                );
            },
        });
        const detailsResult = await Promise.race([
            testAgent.getDetails().then((details) => ({ details })),
            new Promise<{ timedOut: true }>((resolve) => {
                setTimeout(() => resolve({ timedOut: true }), 3000);
            }),
        ]);

        // A held body must not monopolize the router's unrelated command handling.
        expect(detailsResult).not.toHaveProperty("timedOut");
        // Edit staging must be distinguishable from generic upload progress.
        expect(activeTransfer.direction).toBe("edit");
        // Cancellation remains safe while only staging bytes have arrived.
        expect(activeTransfer.cancelable).toBe(true);

        held.finish();
        const response = await held.response;
        // A complete staged body must commit successfully.
        expect(response.status).toBe(200);
        const completed = await waitForValue({
            description: "completed edit progress row",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "completed",
                );
            },
        });
        // Completion must publish the non-cancelable terminal state.
        expect(completed.cancelable).toBe(false);
        // The final bytes must concatenate both streamed request chunks exactly.
        expect(fs.readFileSync(filePath, "utf8")).toBe(
            Buffer.concat([first, second]).toString(),
        );
    });

    it("aborting before terminal input preserves the target inode and bytes", async () => {
        const filePath = tempFiles.create("original bytes", { suffix: ".txt" });
        fs.chmodSync(filePath, 0o640);
        const before = fs.statSync(filePath, { bigint: true });
        const first = Buffer.alloc(64 * 1024, "a");
        const held = startHeldEdit(
            filePath,
            first,
            Buffer.alloc(first.length, "b"),
        );

        const activeTransfer = await waitForValue({
            description: "active edit before abort",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === filePath &&
                        transfer.direction === "edit" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes === first.length,
                );
            },
        });
        held.abort(new Error("client aborted edit"));

        // A broken producer must reject instead of returning a false success response.
        await expect(held.response).rejects.toThrow();
        await waitForValue({
            description: "errored edit after abort",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "errored",
                );
            },
        });
        const after = fs.statSync(filePath, { bigint: true });
        // Pre-terminal cancellation must retain all original content.
        expect(fs.readFileSync(filePath, "utf8")).toBe("original bytes");
        // Inode, owner, group, and mode must remain untouched before commit.
        expect([after.ino, after.uid, after.gid, after.mode]).toEqual([
            before.ino,
            before.uid,
            before.gid,
            before.mode,
        ]);
    });

    it("returns conflict when a symlink changes during staging", async () => {
        const directory = tempFiles.tempDirectory({ suffix: "-race" });
        const firstTarget = path.join(directory, "first.txt");
        const secondTarget = path.join(directory, "second.txt");
        const selected = path.join(directory, "selected.txt");
        fs.writeFileSync(firstTarget, "first old");
        fs.writeFileSync(secondTarget, "second old");
        fs.symlinkSync("first.txt", selected);
        const held = startHeldEdit(
            selected,
            Buffer.from("replacement "),
            Buffer.from("bytes"),
        );

        await waitForValue({
            description: "edit pinned before symlink swap",
            predicate: async () => {
                const progress = await apiClient.getTransferProgress();
                return progress.transfers.some(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === selected &&
                        transfer.direction === "edit" &&
                        transfer.transferred_bytes > 0,
                )
                    ? true
                    : undefined;
            },
        });
        fs.unlinkSync(selected);
        fs.symlinkSync("second.txt", selected);
        held.finish();
        const response = await held.response;

        // The final identity check must reject a changed pathname with HTTP conflict.
        expect(response.status).toBe(409);
        // The originally pinned target must remain unchanged because conflict precedes truncate.
        expect(fs.readFileSync(firstTarget, "utf8")).toBe("first old");
        // The replacement symlink target must never receive staged bytes.
        expect(fs.readFileSync(secondTarget, "utf8")).toBe("second old");
        // The raced symlink itself must remain the caller's replacement entry.
        expect(fs.readlinkSync(selected)).toBe("second.txt");
    });
});
