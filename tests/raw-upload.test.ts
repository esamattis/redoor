import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    afterEach,
    onTestFinished,
} from "vitest";
import { ApiClient, Agent } from "#ui/api-client";
import type { TransferProgressEntry } from "#ui/api-client";
import path from "node:path";
import fs from "node:fs";

import {
    ProcessManager,
    TempFileManager,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "raw-upload-test-agent";

describe("Raw Upload API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let serverPid: number;
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

        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("should upload small file via raw endpoint", async () => {
        const uploadContent = "Hello upload!\nThis content came from PUT.";
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        const uploadFile = new File([uploadContent], "upload.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        ).toString("utf-8");

        // Reading the file back verifies the uploaded bytes were persisted as-is.
        expect(downloadedContent).toBe(uploadContent);
    });

    it("should apply explicit numeric ownership to a new upload", async () => {
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid === undefined || gid === undefined) {
            throw new Error("Unix ownership APIs are required for this test");
        }
        const uploadedFilePath = tempFiles.tempFile({ suffix: "-owned.txt" });

        await testAgent.upload(
            uploadedFilePath,
            new File(["owned"], "owned.txt"),
            { owner: String(uid), group: String(gid) },
        );

        const uploadedStats = fs.statSync(uploadedFilePath);
        // Matching numeric IDs prove ownership was applied to the staged inode before publication.
        expect(uploadedStats.uid).toBe(uid);
        expect(uploadedStats.gid).toBe(gid);
    });

    it("should inherit new upload ownership from its parent", async () => {
        const parentPath = tempFiles.tempDirectory({ suffix: "-upload-inherit" });
        const uploadedFilePath = path.join(parentPath, "inherited.txt");
        const parentStats = fs.statSync(parentPath);

        await testAgent.upload(
            uploadedFilePath,
            new File(["inherited"], "inherited.txt"),
            { inherit_owner: true, inherit_group: true },
        );

        const uploadedStats = fs.statSync(uploadedFilePath);
        // Both inherited IDs must come from the immediate destination directory.
        expect(uploadedStats.uid).toBe(parentStats.uid);
        expect(uploadedStats.gid).toBe(parentStats.gid);
    });

    it("should reject conflicting group options before starting an upload", async () => {
        const uploadedFilePath = tempFiles.tempFile({ suffix: "-conflict.txt" });

        await expect(
            testAgent.upload(
                uploadedFilePath,
                new File(["not uploaded"], "conflict.txt"),
                { group: "0", inherit_group: true },
            ),
        ).rejects.toThrow("Cannot specify both group and inherit_group=true");
        // No destination proves REST validation rejected the request before upload setup.
        expect(fs.existsSync(uploadedFilePath)).toBe(false);
    });

    it("should upload binary file via raw endpoint", async () => {
        const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253, 128, 64]);
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".bin" });

        const uploadFile = new File([binaryContent], "upload.bin", {
            type: "application/octet-stream",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        );

        // Byte-for-byte comparison confirms the upload preserved binary payloads exactly.
        expect(Buffer.compare(downloadedContent, binaryContent)).toBe(0);
    });

    it("should replace existing file contents on upload", async () => {
        const originalContent = "old content";
        const replacementContent = "new content from upload";
        const uploadedFilePath = tempFiles.create(originalContent, {
            suffix: ".txt",
        });

        const uploadFile = new File([replacementContent], "replacement.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        ).toString("utf-8");

        // Reading the file back confirms previous contents were fully replaced.
        expect(downloadedContent).toBe(replacementContent);
    });

    it("should preserve existing permissions when replacing a file", async () => {
        const uploadedFilePath = tempFiles.create("old executable", {
            suffix: ".bin",
        });
        fs.chmodSync(uploadedFilePath, 0o751);
        onTestFinished(() => fs.chmodSync(uploadedFilePath, 0o600));

        await testAgent.upload(
            uploadedFilePath,
            new File(["new executable"], "replacement.bin"),
        );

        // Replacement must update bytes while preserving the destination inode's prior role.
        expect(fs.readFileSync(uploadedFilePath, "utf8")).toBe(
            "new executable",
        );
        // Atomic replacement must retain the executable bit and every prior mode bit.
        expect(fs.statSync(uploadedFilePath).mode & 0o777).toBe(0o751);
    });

    it("should replace a valid symlink without inspecting or mutating its target", async () => {
        const directory = tempFiles.tempDirectory({ suffix: "-valid-symlink" });
        const targetPath = path.join(directory, "target.txt");
        const linkPath = path.join(directory, "link.txt");
        const controlPath = path.join(directory, "control.txt");
        fs.writeFileSync(targetPath, "target content");
        fs.chmodSync(targetPath, 0o701);
        fs.symlinkSync("target.txt", linkPath);

        await testAgent.upload(
            controlPath,
            new File(["control"], "control.txt"),
        );
        const newFileMode = fs.statSync(controlPath).mode & 0o777;
        await testAgent.upload(linkPath, new File(["replacement"], "link.txt"));

        // Upload publication must replace the symlink entry with a regular file.
        expect(fs.lstatSync(linkPath).isFile()).toBe(true);
        // Symlink replacement must use normal new-file mode rather than target metadata.
        expect(fs.statSync(linkPath).mode & 0o777).toBe(newFileMode);
        // The target bytes must remain untouched when only the link entry was selected.
        expect(fs.readFileSync(targetPath, "utf8")).toBe("target content");
        // The target mode must likewise remain untouched by replacement permission handling.
        expect(fs.statSync(targetPath).mode & 0o777).toBe(0o701);
    });

    it("should replace a dangling symlink without creating its target", async () => {
        const directory = tempFiles.tempDirectory({
            suffix: "-dangling-symlink",
        });
        const missingTarget = path.join(directory, "missing.txt");
        const linkPath = path.join(directory, "link.txt");
        fs.symlinkSync("missing.txt", linkPath);

        await testAgent.upload(linkPath, new File(["replacement"], "link.txt"));

        // A dangling link entry must become the uploaded regular file.
        expect(fs.lstatSync(linkPath).isFile()).toBe(true);
        // No-follow metadata and publication must not create the absent target.
        expect(fs.existsSync(missingTarget)).toBe(false);
        // The selected pathname must contain the replacement payload.
        expect(fs.readFileSync(linkPath, "utf8")).toBe("replacement");
    });

    it("should replace a symlink whose target metadata is inaccessible", async () => {
        const directory = tempFiles.tempDirectory({
            suffix: "-inaccessible-symlink",
        });
        const targetDirectory = path.join(directory, "private");
        const targetPath = path.join(targetDirectory, "target.txt");
        const linkPath = path.join(directory, "link.txt");
        const controlPath = path.join(directory, "control.txt");
        fs.mkdirSync(targetDirectory);
        fs.writeFileSync(targetPath, "private target");
        fs.chmodSync(targetPath, 0o701);
        fs.symlinkSync("private/target.txt", linkPath);
        await testAgent.upload(
            controlPath,
            new File(["control"], "control.txt"),
        );
        const newFileMode = fs.statSync(controlPath).mode & 0o777;
        fs.chmodSync(targetDirectory, 0o000);
        onTestFinished(() => fs.chmodSync(targetDirectory, 0o700));

        await testAgent.upload(linkPath, new File(["replacement"], "link.txt"));
        fs.chmodSync(targetDirectory, 0o700);

        // Publication must require access only to the selected link entry and its parent.
        expect(fs.lstatSync(linkPath).isFile()).toBe(true);
        // A non-root agent would fail here if permission capture followed the inaccessible target.
        expect(fs.readFileSync(linkPath, "utf8")).toBe("replacement");
        // Root must also avoid inheriting the target mode when it can bypass directory permissions.
        expect(fs.statSync(linkPath).mode & 0o777).toBe(newFileMode);
        // Replacing the link entry must leave its inaccessible target bytes untouched.
        expect(fs.readFileSync(targetPath, "utf8")).toBe("private target");
        // No-follow replacement must not chmod the inaccessible target either.
        expect(fs.statSync(targetPath).mode & 0o777).toBe(0o701);
    });

    it("should replace only the selected hard-link directory entry", async () => {
        const selectedPath = tempFiles.create("shared old", { suffix: ".txt" });
        const peerPath = `${selectedPath}-peer`;
        fs.chmodSync(selectedPath, 0o751);
        fs.linkSync(selectedPath, peerPath);
        const before = fs.statSync(peerPath, { bigint: true });

        await testAgent.upload(
            selectedPath,
            new File(["selected new"], "selected.txt"),
        );
        const selectedAfter = fs.statSync(selectedPath, { bigint: true });
        const peerAfter = fs.statSync(peerPath, { bigint: true });

        // Replacement must assign a new inode only to the selected pathname.
        expect(selectedAfter.ino).not.toBe(before.ino);
        // The peer must remain attached to the original inode.
        expect(peerAfter.ino).toBe(before.ino);
        // The peer bytes must remain unchanged by publication at another name.
        expect(fs.readFileSync(peerPath, "utf8")).toBe("shared old");
        // The prior inode's ownership and mode must remain untouched.
        expect([peerAfter.uid, peerAfter.gid, peerAfter.mode]).toEqual([
            before.uid,
            before.gid,
            before.mode,
        ]);
        // Regular-entry mode capture must still apply that old mode to the replacement inode.
        expect(Number(selectedAfter.mode & 0o777n)).toBe(0o751);
    });

    it("should upload empty file via raw endpoint", async () => {
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        const uploadFile = new File([""], "empty.txt", {
            type: "text/plain",
        });

        await testAgent.upload(uploadedFilePath, uploadFile);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        );

        // Zero-length content verifies the upload path handles the terminal empty-body case.
        expect(downloadedContent.length).toBe(0);
    });

    it("should report upload progress while streaming and after completion", async () => {
        const firstChunk = Buffer.from("first-upload-chunk-");
        const secondChunk = Buffer.from("second-upload-chunk");
        const totalBytes = firstChunk.length + secondChunk.length;
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".txt" });

        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const uploadBody = new ReadableStream<Uint8Array>({
            start(streamController) {
                controller = streamController;
                streamController.enqueue(firstChunk);
            },
        });

        const uploadOptions = {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": totalBytes.toString(),
                ...testAgent.getAuthHeaders(),
            },
            body: uploadBody,
            duplex: "half",
        };
        const uploadPromise = fetch(
            testAgent.getRawUrl(uploadedFilePath),
            uploadOptions,
        );

        const activeTransfer = await waitForValue({
            description: "active upload progress row",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === uploadedFilePath &&
                        transfer.direction === "upload" &&
                        transfer.state === "active" &&
                        transfer.total_bytes === totalBytes &&
                        transfer.transferred_bytes === firstChunk.length,
                );
            },
        });

        // Matching the agent and path confirms the progress row belongs to this upload.
        expect(activeTransfer.agent_id).toBe(testAgent.id);
        // The upload direction check proves the aggregated endpoint distinguishes transfer types.
        expect(activeTransfer.direction).toBe("upload");
        // The active state check verifies progress is queryable before the upload finishes.
        expect(activeTransfer.state).toBe("active");
        // The total size check ensures the server stored the exact declared upload length.
        expect(activeTransfer.total_bytes).toBe(totalBytes);
        // The transferred byte count check proves the router tracks forwarded chunks incrementally.
        expect(activeTransfer.transferred_bytes).toBe(firstChunk.length);

        if (!controller) {
            throw new Error("Upload stream controller was not initialized");
        }

        controller.enqueue(secondChunk);
        controller.close();

        const uploadResponse = await uploadPromise;

        // A successful HTTP response confirms the agent acknowledged the completed upload.
        expect(uploadResponse.ok).toBe(true);

        const completedTransfer = await waitForValue({
            description: "completed upload progress row",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // Reusing the same request id proves the finished row is the same tracked transfer.
        expect(completedTransfer.request_id).toBe(activeTransfer.request_id);
        // The completed state check ensures uploads stay visible after the agent flushes the file.
        expect(completedTransfer.state).toBe("completed");
        // Equal transferred and total bytes confirms completed uploads report exact 100% progress.
        expect(completedTransfer.transferred_bytes).toBe(totalBytes);
        // The total size stays stable so callers can trust the stored transfer metadata.
        expect(completedTransfer.total_bytes).toBe(totalBytes);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        ).toString("utf-8");

        // Reading the file back ties the completed progress row to a real persisted upload.
        expect(downloadedContent).toBe(
            Buffer.concat([firstChunk, secondChunk]).toString("utf-8"),
        );
    });

    it("should cancel upload cleanly when client aborts", async () => {
        const firstChunk = Buffer.alloc(64 * 1024, "a");
        const totalBytes = firstChunk.length * 2;
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".bin" });
        const controller = new AbortController();
        let streamController:
            ReadableStreamDefaultController<Uint8Array> | undefined;

        const uploadBody = new ReadableStream<Uint8Array>({
            start(bodyController) {
                streamController = bodyController;
                bodyController.enqueue(firstChunk);
            },
        });

        const uploadOptions = {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": totalBytes.toString(),
                ...testAgent.getAuthHeaders(),
            },
            body: uploadBody,
            duplex: "half",
            signal: controller.signal,
        };
        const uploadPromise = fetch(
            testAgent.getRawUrl(uploadedFilePath),
            uploadOptions,
        );

        const activeTransfer = await waitForValue({
            description: "active upload progress row before client abort",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === uploadedFilePath &&
                        transfer.direction === "upload" &&
                        transfer.state === "active" &&
                        transfer.total_bytes === totalBytes &&
                        transfer.transferred_bytes === firstChunk.length,
                );
            },
        });

        const serverLogBeforeAbort = processManager.getStdout(serverPid);

        controller.abort();
        streamController?.error(new Error("client aborted upload"));

        // Rejecting the fetch proves the HTTP client observed its own cancellation instead of receiving a normal response.
        await expect(uploadPromise).rejects.toThrow(
            /abort|aborted|cancel|fetch failed/i,
        );

        const finishedTransfer = await waitForValue({
            description: "errored upload progress row after client abort",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "errored",
                );
            },
        });

        // The errored state proves the server surfaced client-side cancellation instead of leaving the upload active forever.
        expect(finishedTransfer.state).toBe("errored");
        // Keeping partial progress proves cancellation happened after real bytes were already forwarded to the agent.
        expect(finishedTransfer.transferred_bytes).toBe(firstChunk.length);
        // Remaining below the declared total confirms the upload stopped mid-stream rather than after completion.
        expect(finishedTransfer.transferred_bytes).toBeLessThan(totalBytes);
        // The cancellation text confirms the router attributed the failure to the disconnected client.
        expect(finishedTransfer.error).toMatch(/canceled by client/i);

        await waitForValue({
            description: "server upload cancel logs after client abort",
            predicate: async () => {
                const stdout = processManager.getStdout(serverPid);
                const newStdout = stdout.slice(serverLogBeforeAbort.length);

                if (
                    /No pending response found for request_id=/.test(newStdout)
                ) {
                    throw new Error(
                        "Unexpected missing pending response warning after upload cancellation",
                    );
                }

                return /Sending upload cancel to agent: agent_id=.*request_id=/.test(
                    newStdout,
                ) &&
                    /Received canceled upload ack from agent: agent_id=.*request_id=.*is_error=true/.test(
                        newStdout,
                    )
                    ? true
                    : undefined;
            },
        });

        // A missing final file proves the canceled upload never got finalized at the destination path.
        await expect(testAgent.raw(uploadedFilePath)).rejects.toThrow(
            /not found|no such file/i,
        );
    });

    it("should return error for upload to non-existent agent", async () => {
        const fakeAgent = new Agent(
            apiClient.baseUrl,
            {
                id: "non-existent-agent-id",
                name: "fake",
                cwd: "/tmp",
                managed: false,
                configuration_editable: false,
                ssh_target: null,
                status: "disconnected",
                connected_at: null,
                connection_id: null,
                last_seen_at: null,
                connection_issue: null,
                provisioning_status: [],
                binary: null,
                supports_self_exec: false,
                supports_native_open: false,
                supports_move_to_trash: false,
                supports_trash: false,
            },
            {
                getSessionCookie: () =>
                    apiClient.getAuthHeaders().Cookie ?? null,
            },
        );
        const uploadFile = new File(["content"], "content.txt", {
            type: "text/plain",
        });

        // Missing agents should fail fast instead of hanging the upload request.
        await expect(
            fakeAgent.upload("/tmp/fake-upload.txt", uploadFile),
        ).rejects.toThrow();
    });

    it("should return error for permission denied upload", async () => {
        const protectedDir = path.join(
            tempFiles.tempFile({ suffix: ".tmp" }),
            "..",
            `blocked-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        fs.mkdirSync(protectedDir, 0o555);

        onTestFinished(() => {
            fs.chmodSync(protectedDir, 0o755);
            fs.rmdirSync(protectedDir);
        });

        const uploadedFilePath = path.join(protectedDir, "blocked.txt");
        const uploadFile = new File(["secret"], "blocked.txt", {
            type: "text/plain",
        });

        // Depending on the OS and temp directory behavior, creating a file inside a
        // read-only directory may surface either a permission error or a not found style
        // error from the agent, but it must fail instead of succeeding.
        await expect(
            testAgent.upload(uploadedFilePath, uploadFile),
        ).rejects.toThrow();
    });
});
