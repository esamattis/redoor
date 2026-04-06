import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    afterEach,
    onTestFinished,
} from "vitest";
import { ApiClient, Agent } from "@/api-client";
import type { TransferProgressEntry } from "@/api-client";
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
    let serverPort: number;
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
        serverPort = setup.serverPort;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(() => {
        tempFiles.cleanup();
        processManager.killAll();
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

        const uploadPromise = fetch(testAgent.getRawUrl(uploadedFilePath), {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": totalBytes.toString(),
            },
            body: uploadBody,
            duplex: "half",
        } as RequestInit & { duplex: "half" });

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
            | ReadableStreamDefaultController<Uint8Array>
            | undefined;

        const uploadBody = new ReadableStream<Uint8Array>({
            start(bodyController) {
                streamController = bodyController;
                bodyController.enqueue(firstChunk);
            },
        });

        const uploadPromise = fetch(testAgent.getRawUrl(uploadedFilePath), {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": totalBytes.toString(),
            },
            body: uploadBody,
            duplex: "half",
            signal: controller.signal,
        } as RequestInit & { duplex: "half" });

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
        const fakeAgent = new Agent(apiClient.baseUrl, {
            id: "non-existent-agent-id",
            name: "fake",
        });
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
