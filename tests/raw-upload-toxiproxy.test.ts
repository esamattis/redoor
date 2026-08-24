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
import fs from "node:fs/promises";

import {
    ProcessManager,
    TempFileManager,
    createToxiproxyAgent,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";

const AGENT_NAME = "raw-upload-toxiproxy-test-agent";

describe("Raw Upload API with toxiproxy", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let apiClient: ApiClient;
    let serverPort: number;
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
        testAgent = setup.testAgent;
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("should keep a slowish upload observable via toxiproxy", async () => {
        const chunkSizeBytes = 64 * 1024;
        const totalBytes = chunkSizeBytes * 2 + 123;
        const uploadContent = Buffer.alloc(totalBytes, "u");
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".bin" });
        const { proxy, proxiedAgent } = await createToxiproxyAgent({
            serverPort,
            agent: testAgent,
            proxyNamePrefix: "raw-upload-slow",
        });

        onTestFinished(async () => {
            await proxy.remove().catch(() => undefined);
        });

        await proxy.addToxic({
            name: "slow-upload",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                rate: 16,
            },
        });

        const uploadFile = new File([uploadContent], "slow-upload.bin", {
            type: "application/octet-stream",
        });

        const uploadPromise = proxiedAgent.upload(uploadedFilePath, uploadFile);

        const activeTransfer = await waitForValue({
            description: "partially transferred upload progress row",
            timeoutMs: 15000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === uploadedFilePath &&
                        transfer.direction === "upload" &&
                        transfer.state === "active" &&
                        transfer.total_bytes === totalBytes &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                );
            },
        });

        // A partial byte count proves the toxiproxy bandwidth limit kept the upload observable mid-flight.
        expect(activeTransfer.transferred_bytes).toBeGreaterThan(0);
        // Remaining bytes confirm we observed a live transfer instead of racing straight to completion after one chunk.
        expect(activeTransfer.transferred_bytes).toBeLessThan(totalBytes);
        // The active state check ensures progress polling works while the throttled request is still streaming.
        expect(activeTransfer.state).toBe("active");

        const uploadResponse = await uploadPromise;

        // A successful response confirms the upload still completes cleanly when the request body is throttled.
        expect(uploadResponse.ok).toBe(true);

        const completedTransfer = await waitForValue({
            description: "completed slow upload progress row",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "completed",
                );
            },
        });

        // Reusing the same request id shows the finished row belongs to the throttled upload we observed earlier.
        expect(completedTransfer.request_id).toBe(activeTransfer.request_id);
        // Matching transferred and total bytes proves the slow upload still reaches 100% progress.
        expect(completedTransfer.transferred_bytes).toBe(totalBytes);

        const downloadedContent = Buffer.from(
            await testAgent.raw(uploadedFilePath),
        );

        // Reading the file back verifies the bandwidth toxic did not corrupt the uploaded binary payload.
        expect(Buffer.compare(downloadedContent, uploadContent)).toBe(0);
    }, 20000);

    it("should keep command requests responsive during a throttled upload", async () => {
        const chunkSizeBytes = 64 * 1024;
        const totalBytes = chunkSizeBytes * 3 + 17;
        const uploadContent = Buffer.alloc(totalBytes, "c");
        const uploadedFilePath = tempFiles.tempFile({ suffix: ".bin" });
        const { proxy, proxiedAgent } = await createToxiproxyAgent({
            serverPort,
            agent: testAgent,
            proxyNamePrefix: "raw-upload-concurrent-command",
        });

        onTestFinished(async () => {
            await proxy.remove().catch(() => undefined);
        });

        await proxy.addToxic({
            name: "slow-upload",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                rate: 16,
            },
        });

        const uploadPromise = proxiedAgent.upload(
            uploadedFilePath,
            new File([uploadContent], "concurrent-upload.bin", {
                type: "application/octet-stream",
            }),
        );

        const activeTransfer = await waitForValue({
            description: "active upload before issuing concurrent command",
            timeoutMs: 15000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === uploadedFilePath &&
                        transfer.direction === "upload" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                );
            },
        });

        const detailsResult = await Promise.race([
            testAgent
                .getDetails()
                .then((details) => ({ ok: true as const, details })),
            new Promise<{ ok: false; error: string }>((resolve) => {
                setTimeout(() => {
                    resolve({
                        ok: false,
                        error: "getDetails timed out while upload was still active",
                    });
                }, 3000);
            }),
        ]);

        // Observing an active row first proves the command raced with a real in-flight upload instead of running after completion.
        expect(activeTransfer.state).toBe("active");
        // A successful metadata call confirms control commands are no longer queued behind upload chunks.
        expect(detailsResult.ok).toBe(true);
        if (!detailsResult.ok) {
            throw new Error(detailsResult.error);
        }
        // Returning the same agent name proves the responsive command still reached the intended agent during the upload.
        expect(detailsResult.details.name).toBe(testAgent.name);

        const uploadResponse = await uploadPromise;

        // Finishing successfully confirms the responsiveness fix does not break the throttled upload itself.
        expect(uploadResponse.ok).toBe(true);
    }, 20000);

    it("cancels a throttled upload over the control path and removes partial output", async () => {
        const totalBytes = 8 * 1024 * 1024;
        const destinationRoot = tempFiles.tempDirectory({
            suffix: "-upload-cancel",
        });
        const destinationPath = `${destinationRoot}/canceled.bin`;
        const { proxy, proxiedAgent } = await createToxiproxyAgent({
            serverPort,
            agent: testAgent,
            proxyNamePrefix: "raw-upload-cancel",
        });
        onTestFinished(async () => {
            await proxy.remove().catch(() => undefined);
        });
        await proxy.addToxic({
            name: "slow-cancelable-upload",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: { rate: 32 },
        });

        const uploadResult = proxiedAgent
            .upload(
                destinationPath,
                new File([Buffer.alloc(totalBytes, "x")], "canceled.bin"),
            )
            .then(
                () => ({ completed: true as const }),
                (error: Error) => ({ completed: false as const, error }),
            );
        const active = await waitForValue({
            description: "partially uploaded row before explicit cancellation",
            timeoutMs: 15000,
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.path === destinationPath &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                ),
        });

        const cancellation = await apiClient.cancelTransfer(active.request_id);
        // Accepted proves cancellation used the public id rather than an internal websocket request id.
        expect(cancellation.status).toBe("accepted");
        const canceled = await waitForValue({
            description: "terminal canceled upload row",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.request_id === active.request_id &&
                        transfer.state === "canceled",
                ),
        });
        // Partial progress remains visible so cancellation is not misreported as a fresh zero-byte error.
        expect(canceled.transferred_bytes).toBeGreaterThan(0);
        const repeated = await apiClient.cancelTransfer(active.request_id);
        // A repeated request must be harmless after the worker acknowledgement settles the row.
        expect(repeated.status).toBe("already_canceled");
        const result = await uploadResult;
        // Closing the server-side upload producer must terminate the throttled HTTP request.
        expect(result.completed).toBe(false);
        await expect(testAgent.metadata(destinationPath)).rejects.toThrow();
        const remainingEntries = await fs.readdir(destinationRoot);
        // Terminal cancellation is published only after hidden partial output is removed.
        expect(remainingEntries).toEqual([]);
        // A responsive command after cleanup proves cancellation did not block the control lane.
        expect((await testAgent.getDetails()).name).toBe(testAgent.name);
    }, 25000);

    it("should report interrupted uploads and recover after removing the toxic", async () => {
        const chunkSizeBytes = 64 * 1024;
        const interruptedTotalBytes = chunkSizeBytes * 4 + 123;
        const interruptionLimitBytes = chunkSizeBytes * 2;
        const interruptedContent = Buffer.alloc(interruptedTotalBytes, "i");
        const interruptedPath = tempFiles.tempFile({ suffix: ".bin" });
        const { proxy, proxiedAgent } = await createToxiproxyAgent({
            serverPort,
            agent: testAgent,
            proxyNamePrefix: "raw-upload-interrupt",
        });

        onTestFinished(async () => {
            await proxy.remove().catch(() => undefined);
        });

        const interruptionToxic = await proxy.addToxic({
            name: "interrupt-upload",
            type: "limit_data",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                bytes: interruptionLimitBytes,
            },
        });

        const interruptedUploadResultPromise = proxiedAgent
            .upload(
                interruptedPath,
                new File([interruptedContent], "interrupted-upload.bin", {
                    type: "application/octet-stream",
                }),
            )
            .then(
                (response) => ({ ok: true as const, response }),
                (error: Error) => ({ ok: false as const, error }),
            );

        const erroredTransfer = await waitForValue({
            description:
                "errored upload progress row after connection interruption",
            timeoutMs: 15000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === interruptedPath &&
                        transfer.direction === "upload" &&
                        transfer.total_bytes === interruptedTotalBytes &&
                        transfer.state === "errored",
                );
            },
        });

        // The errored state proves the transfer REST API surfaces a broken upload instead of leaving it active forever.
        expect(erroredTransfer.state).toBe("errored");
        // A non-zero byte count confirms the connection broke after the upload had already started streaming.
        expect(erroredTransfer.transferred_bytes).toBeGreaterThan(0);
        // Fewer transferred bytes than declared total prove the failure happened mid-upload rather than after completion.
        expect(erroredTransfer.transferred_bytes).toBeLessThan(
            interruptedTotalBytes,
        );
        // Keeping the error text lets API callers distinguish interrupted uploads from successful completions.
        expect(erroredTransfer.error).toMatch(
            /read request body|aborted|reset|closed|stream/i,
        );

        const interruptedUploadResult = await interruptedUploadResultPromise;

        // The client request should fail once toxiproxy cuts the upstream connection mid-upload.
        expect(interruptedUploadResult.ok).toBe(false);
        if (interruptedUploadResult.ok) {
            throw new Error("Interrupted upload unexpectedly succeeded");
        }
        // Keeping the fetch error confirms the failure propagated back to the HTTP client as a broken connection.
        expect(interruptedUploadResult.error.message).toMatch(
            /fetch failed|socket|closed/i,
        );

        await interruptionToxic.remove();

        const recoveredContent = Buffer.alloc(chunkSizeBytes * 2 + 77, "r");
        const recoveredPath = tempFiles.tempFile({ suffix: ".bin" });

        const recoveryResponse = await proxiedAgent.upload(
            recoveredPath,
            new File([recoveredContent], "recovered-upload.bin", {
                type: "application/octet-stream",
            }),
        );

        // A successful response after toxic removal confirms the proxy path recovers for later uploads.
        expect(recoveryResponse.ok).toBe(true);

        const recoveredTransfer = await waitForValue({
            description: "completed upload progress row after toxic removal",
            timeoutMs: 15000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === recoveredPath &&
                        transfer.direction === "upload" &&
                        transfer.total_bytes === recoveredContent.length &&
                        transfer.state === "completed",
                );
            },
        });

        // The completed state proves later uploads finish normally once the interruption toxic is removed.
        expect(recoveredTransfer.state).toBe("completed");
        // Full progress confirms the recovered upload was not partially affected by the earlier interruption setup.
        expect(recoveredTransfer.transferred_bytes).toBe(
            recoveredContent.length,
        );

        const downloadedRecoveredContent = Buffer.from(
            await testAgent.raw(recoveredPath),
        );

        // Reading the file back verifies the recovered upload reached the agent without corruption.
        expect(
            Buffer.compare(downloadedRecoveredContent, recoveredContent),
        ).toBe(0);
    }, 20000);
});
