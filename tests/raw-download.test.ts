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

import fs from "node:fs";
import {
    ProcessManager,
    TempFileManager,
    getAvailablePort,
    waitForLogMessage,
    waitForValue,
    startServerAndAgent,
} from "./test-utils";
import { Toxiproxy } from "toxiproxy-node-client";
import { z } from "zod";

const AGENT_NAME = "raw-test-agent";
const createOneTimeTokenResponseSchema = z.object({
    one_time_token: z.string(),
});

describe("Raw Download API", () => {
    const processManager = new ProcessManager();
    const tempFiles = new TempFileManager();
    let serverPort: number;
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

        serverPort = setup.serverPort;
        apiClient = setup.apiClient;
        serverPid = setup.serverPid;
        testAgent = setup.testAgent;
        expect(testAgent).toBeDefined();
    }, 30000);

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    it("should download small file via raw endpoint", async () => {
        const testContent = "Hello, World!\nThis is a test file.";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result).toString("utf-8");
        expect(downloadedContent).toBe(testContent);
    });

    it("cancels a throttled download and closes its HTTP stream promptly", async () => {
        const testFilePath = tempFiles.create(
            Buffer.alloc(8 * 1024 * 1024, "d"),
            {
                suffix: ".bin",
            },
        );
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }
        const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
        const proxyPort = await getAvailablePort();
        const proxy = await toxiproxy.createProxy({
            name: `raw-download-explicit-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            listen: `127.0.0.1:${proxyPort}`,
            upstream: `127.0.0.1:${serverPort}`,
        });
        const proxiedAgentName = "raw-download-explicit-cancel-agent";
        const connected = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${proxiedAgentName},`,
            ),
            10000,
        );
        const proxiedAgentPid = processManager.spawnAgent({
            wsAddress: `ws://${proxy.listen}/ws`,
            name: proxiedAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-explicit-cancel-agent-cwd",
            }),
        });
        onTestFinished(async () => {
            processManager.kill(proxiedAgentPid);
            await proxy.remove().catch(() => undefined);
        });
        await proxy.addToxic({
            name: "slow-cancelable-download",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: { rate: 512 },
        });
        await connected;
        const proxiedAgent = await waitForValue({
            description: "explicit cancellation proxied agent",
            predicate: async () =>
                (await apiClient.listAgents()).find(
                    (agent) => agent.name === proxiedAgentName,
                ),
        });

        const response = await proxiedAgent.download(testFilePath);
        const reader = response.body?.getReader();
        expect(reader).toBeDefined();
        if (reader === undefined) {
            throw new Error("download response did not expose a body reader");
        }
        const firstChunk = await reader.read();
        // Receiving bytes proves the download worker and throttled HTTP response were both live.
        expect(firstChunk.value?.byteLength ?? 0).toBeGreaterThan(0);
        const active = await waitForValue({
            description:
                "partially downloaded row before explicit cancellation",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.path === testFilePath &&
                        transfer.direction === "download" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0,
                ),
        });

        expect((await apiClient.cancelTransfer(active.request_id)).status).toBe(
            "accepted",
        );
        let streamClosedByServer = false;
        try {
            while (!streamClosedByServer) {
                const read = await reader.read();
                streamClosedByServer = read.done;
            }
        } catch (error) {
            // Fixed-length HTTP responses terminate with a protocol error when cancellation truncates them.
            expect(error).toBeInstanceOf(Error);
            streamClosedByServer = true;
        }
        // Explicit cancellation, not consumer-side reader cancellation, must close the HTTP body.
        expect(streamClosedByServer).toBe(true);
        const canceled = await waitForValue({
            description: "terminal canceled download row",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer) =>
                        transfer.request_id === active.request_id &&
                        transfer.state === "canceled",
                ),
        });
        // Cancellation preserves the byte snapshot instead of converting the row into an error.
        expect(canceled.transferred_bytes).toBeGreaterThan(0);
        reader.releaseLock();
        // The server-settled response releases the reader without client cancellation.
        expect(response.body?.locked).toBe(false);
        // Control work remains responsive while the agent releases its file handle.
        expect((await testAgent.getDetails()).name).toBe(testAgent.name);
    }, 25000);

    it("should authorize an exact raw path with a one-time token", async () => {
        const testContent = "one-time download";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });
        const mismatchedPath = tempFiles.create("other file", {
            suffix: ".txt",
        });
        const createTokenUrl = testAgent
            .getRawUrl(testFilePath)
            .replace("/raw/", "/one-time-token/");
        const createResponse = await fetch(createTokenUrl, {
            method: "POST",
            headers: testAgent.getAuthHeaders(),
        });
        // Token creation remains protected by the normal authenticated API boundary.
        expect(createResponse.status).toBe(200);
        const { one_time_token: oneTimeToken } =
            createOneTimeTokenResponseSchema.parse(await createResponse.json());
        const metadataBefore = await testAgent.metadata(testFilePath);
        // Metadata exposes the still-outstanding token only for its exact path.
        expect(metadataBefore.one_time_tokens).toContain(oneTimeToken);

        const mismatchResponse = await fetch(
            `${testAgent.getRawUrl(mismatchedPath)}?one_time_token=${encodeURIComponent(oneTimeToken)}`,
        );
        // A path mismatch fails before file work without consuming the valid token.
        expect(mismatchResponse.status).toBe(401);
        const metadataAfterMismatch = await testAgent.metadata(testFilePath);
        // Failed matching leaves the legitimate exact-path token outstanding.
        expect(metadataAfterMismatch.one_time_tokens).toContain(oneTimeToken);

        const tokenUrl = `${testAgent.getRawUrl(testFilePath)}?one_time_token=${encodeURIComponent(oneTimeToken)}`;
        const downloadResponse = await fetch(tokenUrl);
        // The token permits a cookie-free request only once.
        expect(downloadResponse.status).toBe(200);
        // Token-authorized downloads are always presented as attachments.
        expect(downloadResponse.headers.get("Content-Disposition")).toMatch(
            /attachment/,
        );
        // The authorized response still streams the original file bytes.
        expect(await downloadResponse.text()).toBe(testContent);

        const reusedResponse = await fetch(tokenUrl);
        // Registry removal makes the successfully consumed UUID unusable afterward.
        expect(reusedResponse.status).toBe(401);
        const metadataAfterUse = await testAgent.metadata(testFilePath);
        // Successful consumption removes the token from registry memory and metadata.
        expect(metadataAfterUse.one_time_tokens).not.toContain(oneTimeToken);
    });

    it("should retain a one-time token until an interrupted download is resumed", async () => {
        const totalBytes = 4 * 1024 * 1024;
        const downloadContent = Buffer.alloc(totalBytes, "t");
        const sourcePath = tempFiles.create(downloadContent, {
            suffix: ".bin",
        });
        const { one_time_token: oneTimeToken } =
            await testAgent.createOneTimeToken(sourcePath);
        const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
        const proxyPort = await getAvailablePort();
        const proxy = await toxiproxy.createProxy({
            name: `one-time-download-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            listen: `127.0.0.1:${proxyPort}`,
            upstream: `127.0.0.1:${serverPort}`,
        });
        const bandwidthToxic = await proxy.addToxic({
            name: "slow-one-time-download",
            type: "bandwidth",
            stream: "downstream",
            toxicity: 1,
            attributes: { rate: 256 },
        });

        onTestFinished(async () => {
            await proxy.remove().catch(() => undefined);
        });

        const tokenUrl = new URL(testAgent.getRawUrl(sourcePath));
        tokenUrl.host = proxy.listen;
        tokenUrl.searchParams.set("one_time_token", oneTimeToken);
        const initialResponse = await fetch(tokenUrl);
        // The outstanding token authorizes the first anonymous request.
        expect(initialResponse.status).toBe(200);
        const reader = initialResponse.body?.getReader();
        if (!reader) {
            throw new Error("One-time download response body was unavailable");
        }
        const firstChunk = await reader.read();
        // Receiving a non-final prefix gives the retry a deterministic range offset.
        expect(firstChunk.done).toBe(false);
        if (!firstChunk.value) {
            throw new Error("One-time download returned no prefix bytes");
        }
        const resumeOffset = firstChunk.value.byteLength;
        await reader.cancel();

        await waitForValue({
            description: "canceled one-time download progress row",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === testAgent.id &&
                        transfer.path === sourcePath &&
                        transfer.direction === "download" &&
                        transfer.state === "errored",
                );
            },
        });
        const metadataAfterCancel = await testAgent.metadata(sourcePath);
        // Canceling before the complete file is delivered must leave the token retryable.
        expect(metadataAfterCancel.one_time_tokens).toContain(oneTimeToken);

        await bandwidthToxic.remove();
        const resumedResponse = await fetch(tokenUrl, {
            headers: { Range: `bytes=${resumeOffset}-` },
        });
        // The same anonymous token authorizes the remaining byte range.
        expect(resumedResponse.status).toBe(206);
        const resumedBytes = Buffer.from(await resumedResponse.arrayBuffer());
        // The resumed response returns exactly the requested suffix.
        expect(
            Buffer.compare(
                resumedBytes,
                downloadContent.subarray(resumeOffset),
            ),
        ).toBe(0);

        await waitForValue({
            description: "one-time token removal after resumed download",
            timeoutMs: 10000,
            predicate: async () => {
                const metadata = await testAgent.metadata(sourcePath);
                return metadata.one_time_tokens.includes(oneTimeToken)
                    ? undefined
                    : true;
            },
        });
        const reusedResponse = await fetch(tokenUrl);
        // Covering the complete file across both requests consumes the token permanently.
        expect(reusedResponse.status).toBe(401);
    }, 40000);

    it("should download large file via raw endpoint", async () => {
        const largeContent = "x".repeat(100 * 1024);
        const testFilePath = tempFiles.create(largeContent, { suffix: ".txt" });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result).toString("utf-8");
        expect(downloadedContent.length).toBe(largeContent.length);
        expect(downloadedContent).toBe(largeContent);
    });

    it("should handle binary file download", async () => {
        const binaryContent = Buffer.from([0, 1, 2, 3, 255, 254, 253]);
        const testFilePath = tempFiles.create(binaryContent, {
            suffix: ".bin",
        });

        const result = await testAgent.raw(testFilePath);
        const downloadedContent = Buffer.from(result);
        expect(Buffer.compare(downloadedContent, binaryContent)).toBe(0);
    });

    it("should return error for non-existent file", async () => {
        const nonExistentPath = "/tmp/non-existent-file-12345.txt";
        await expect(testAgent.raw(nonExistentPath)).rejects.toThrow();
    });

    it("should return error for non-existent agent", async () => {
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
                uid: null,
                is_root: false,
            },
            {
                getSessionCookie: () =>
                    apiClient.getAuthHeaders().Cookie ?? null,
            },
        );
        // Server should return an error instead of hanging forever
        await expect(fakeAgent.raw("/tmp/somefile")).rejects.toThrow(
            /not found/i,
        );
    });

    it("should handle agent disconnect during download", async () => {
        // Create a large file that takes multiple chunks to transfer
        const largeContent = "x".repeat(32 * 1024 * 1024);
        const testFilePath = tempFiles.create(largeContent, {
            suffix: ".txt",
        });
        const fileSize = Buffer.byteLength(largeContent);

        const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
        const ephemeralAgentName = "ephemeral-raw-agent";

        // Spawn a second agent that we can kill mid-transfer
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const waitForEphemeralAgent = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${ephemeralAgentName},`,
            ),
            10000,
        );

        const ephemeralAgentPid = processManager.spawnAgent({
            wsAddress: wsUrl,
            name: ephemeralAgentName,
            cwd: tempFiles.tempDirectory({ suffix: "-ephemeral-agent-cwd" }),
        });

        await waitForEphemeralAgent;

        const agents = await apiClient.listAgents();
        const ephemeralAgent = agents.find(
            (a) => a.name === ephemeralAgentName,
        );
        if (!ephemeralAgent) {
            throw new Error(`Agent ${ephemeralAgentName} was not registered`);
        }
        expect(ephemeralAgent).toBeDefined();

        const ephemeralAgentProcess =
            processManager.getProcess(ephemeralAgentPid);
        if (!ephemeralAgentProcess) {
            throw new Error("Ephemeral agent process not found");
        }

        // Waiting for observable transfer progress ensures we interrupt a real in-flight download
        // without depending on a specific agent log line format.
        const downloadPromise = fetch(ephemeralAgent.getRawUrl(testFilePath), {
            headers: ephemeralAgent.getAuthHeaders(),
        });

        const observedTransfer = await waitForValue({
            description: "active or finished download progress row",
            timeoutMs: 20000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === ephemeralAgent.id &&
                        transfer.path === testFilePath &&
                        transfer.direction === "download" &&
                        transfer.total_bytes === fileSize &&
                        ((transfer.state === "active" &&
                            transfer.transferred_bytes > 0) ||
                            transfer.state === "completed" ||
                            transfer.state === "errored"),
                );
            },
        });

        // The download direction check proves the shared endpoint tracks download rows separately from uploads.
        expect(observedTransfer.direction).toBe("download");
        // The total size check confirms the server reuses the computed content length for progress.
        expect(observedTransfer.total_bytes).toBe(fileSize);
        // A tracked row proves the router registered this transfer even if it completed before polling observed the active state.
        expect(["active", "completed", "errored"]).toContain(
            observedTransfer.state,
        );

        processManager.kill(ephemeralAgentPid);

        // The download should fail with an error or complete early if the disconnect races late,
        // but it must NOT hang forever.
        const result = await Promise.race([
            downloadPromise
                .then(async (response) => ({
                    ok: response.ok,
                    status: response.status,
                    body: await response.text(),
                }))
                .catch((e: Error) => ({ ok: false, error: e.message })),
            new Promise((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Download hung for 10s after agent disconnect",
                            ),
                        ),
                    10000,
                ),
            ),
        ]);

        const finishedTransfer = await waitForValue({
            description: "finished download progress row after disconnect",
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === observedTransfer.request_id &&
                        (transfer.state === "errored" ||
                            transfer.state === "completed"),
                );
            },
        });

        // Reaching this assertion confirms router cleanup closed the request path instead of hanging the client.
        expect(result).toBeDefined();
        if (finishedTransfer.state === "errored") {
            // The errored state check ensures disconnect cleanup keeps the transfer row queryable when the transfer is interrupted.
            expect(finishedTransfer.transferred_bytes).toBeLessThan(
                finishedTransfer.total_bytes,
            );
            // The retained error text gives callers an explicit reason for the failed transfer.
            expect(finishedTransfer.error).toMatch(
                /disconnect|stream|closed|lost/i,
            );
        } else {
            // A completed state is valid when the disconnect races after the full response has already been delivered.
            expect(finishedTransfer.state).toBe("completed");
            // Full progress proves the transfer finished before the disconnect cleanup could interrupt it.
            expect(finishedTransfer.transferred_bytes).toBe(
                finishedTransfer.total_bytes,
            );
            // A null error confirms the late disconnect did not overwrite a successful completion.
            expect(finishedTransfer.error).toBeNull();
        }
    }, 30000);

    it("should keep command requests responsive during a throttled download", async () => {
        const chunkSizeBytes = 1024 * 1024;
        const totalBytes = chunkSizeBytes * 8 + 123;
        const downloadContent = Buffer.alloc(totalBytes, "d");
        const sourcePath = tempFiles.create(downloadContent, {
            suffix: ".bin",
        });
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
        const proxyPort = await getAvailablePort();
        const proxy = await toxiproxy.createProxy({
            name: `raw-download-concurrent-command-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            listen: `127.0.0.1:${proxyPort}`,
            upstream: `127.0.0.1:${serverPort}`,
        });
        const proxiedAgentName = "raw-download-proxied-agent";
        const waitForProxiedAgent = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${proxiedAgentName},`,
            ),
            10000,
        );
        const proxiedAgentPid = processManager.spawnAgent({
            wsAddress: `ws://${proxy.listen}/ws`,
            name: proxiedAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-proxied-download-agent-cwd",
            }),
        });

        onTestFinished(async () => {
            processManager.kill(proxiedAgentPid);
            await proxy.remove().catch(() => undefined);
        });

        await waitForProxiedAgent;

        const agents = await apiClient.listAgents();
        const proxiedAgent = agents.find(
            (agent) => agent.name === proxiedAgentName,
        );
        if (!proxiedAgent) {
            throw new Error(`Agent ${proxiedAgentName} was not registered`);
        }

        await proxy.addToxic({
            name: "slow-download",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                rate: 512,
            },
        });

        const downloadPromise = proxiedAgent.raw(sourcePath);

        const activeTransfer = await waitForValue({
            description: "active download before issuing concurrent command",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === proxiedAgent.id &&
                        transfer.path === sourcePath &&
                        transfer.direction === "download" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                );
            },
        });

        const detailsPromise = proxiedAgent.getDetails();
        const firstCompletion = await Promise.race([
            detailsPromise.then((details) => ({
                winner: "details" as const,
                details,
            })),
            downloadPromise.then((bytes) => ({
                winner: "download" as const,
                bytes,
            })),
        ]);

        // Observing an active row first proves the command raced with a real in-flight download instead of running after completion.
        expect(activeTransfer.state).toBe("active");
        // Finishing the command before the payload proves control messages are not stuck behind the throttled download stream.
        expect(firstCompletion.winner).toBe("details");
        if (firstCompletion.winner !== "details") {
            throw new Error(
                "Download completed before getDetails responded during throttled transfer",
            );
        }
        // Returning the proxied agent name proves the responsive command still reached the intended agent during the download.
        expect(firstCompletion.details.name).toBe(proxiedAgent.name);

        const downloadedContent = Buffer.from(await downloadPromise);

        // Matching bytes prove the throttled download still completes successfully after the concurrent command.
        expect(Buffer.compare(downloadedContent, downloadContent)).toBe(0);
    }, 40000);

    it("should cancel throttled download cleanly when client aborts", async () => {
        const totalBytes = 8 * 1024 * 1024;
        const downloadContent = Buffer.alloc(totalBytes, "c");
        const sourcePath = tempFiles.create(downloadContent, {
            suffix: ".bin",
        });
        const serverProcess = processManager.getProcess(serverPid);
        if (!serverProcess) {
            throw new Error("Server process not found");
        }

        const toxiproxy = new Toxiproxy("http://127.0.0.1:8474");
        const proxyPort = await getAvailablePort();
        const proxy = await toxiproxy.createProxy({
            name: `raw-download-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            listen: `127.0.0.1:${proxyPort}`,
            upstream: `127.0.0.1:${serverPort}`,
        });
        // Limit the transfer socket from birth so the agent cannot finish the file before abort.
        await proxy.addToxic({
            name: "slow-cancel-download",
            type: "bandwidth",
            stream: "upstream",
            toxicity: 1,
            attributes: {
                rate: 512,
            },
        });
        const proxiedAgentName = "raw-download-cancel-agent";
        const waitForProxiedAgent = waitForLogMessage(
            serverProcess,
            new RegExp(
                `Transfer socket registered: agent_id=${proxiedAgentName},`,
            ),
            10000,
        );
        const proxiedAgentPid = processManager.spawnAgent({
            wsAddress: `ws://${proxy.listen}/ws`,
            name: proxiedAgentName,
            cwd: tempFiles.tempDirectory({
                suffix: "-proxied-cancel-agent-cwd",
            }),
        });

        onTestFinished(async () => {
            processManager.kill(proxiedAgentPid);
            await proxy.remove().catch(() => undefined);
        });

        await waitForProxiedAgent;

        const agents = await apiClient.listAgents();
        const proxiedAgent = agents.find(
            (agent) => agent.name === proxiedAgentName,
        );
        if (!proxiedAgent) {
            throw new Error(`Agent ${proxiedAgentName} was not registered`);
        }

        const controller = new AbortController();
        const downloadResponsePromise = fetch(
            proxiedAgent.getRawUrl(sourcePath),
            {
                signal: controller.signal,
                headers: proxiedAgent.getAuthHeaders(),
            },
        );

        const activeTransfer = await waitForValue({
            description: "active throttled download before cancellation",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === proxiedAgent.id &&
                        transfer.path === sourcePath &&
                        transfer.direction === "download" &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0 &&
                        transfer.transferred_bytes < totalBytes,
                );
            },
        });

        const response = await downloadResponsePromise;
        const abortReadPromise = response.arrayBuffer();
        const serverLogBeforeAbort = processManager.getStdout(serverPid);
        const proxiedAgentProcess = processManager.getProcess(proxiedAgentPid);
        if (!proxiedAgentProcess) {
            throw new Error("Proxied agent process not found");
        }
        const waitForAgentCancel = waitForLogMessage(
            proxiedAgentProcess,
            /Received transfer cancel from server: request_id=/,
            30000,
        );

        controller.abort();

        await expect(abortReadPromise).rejects.toThrow(/abort|aborted|cancel/i);
        await waitForAgentCancel;

        const finishedTransfer = await waitForValue({
            description: "errored download progress row after client abort",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                return response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "errored",
                );
            },
        });

        // The errored state proves the server surfaced client-side cancellation instead of leaving the transfer active forever.
        expect(finishedTransfer.state).toBe("errored");
        // Retaining partial progress proves cancellation happened mid-stream instead of after a completed download.
        expect(finishedTransfer.transferred_bytes).toBeLessThan(
            finishedTransfer.total_bytes,
        );
        // The cancellation message confirms the server recognized a client abort rather than inventing a transport error.
        expect(finishedTransfer.error).toMatch(/canceled by client/i);

        const serverLogAfterCancel = processManager
            .getStdout(serverPid)
            .slice(serverLogBeforeAbort.length);
        // Keeping canceled routing state until the agent acknowledges avoids noisy orphan chunks.
        expect(serverLogAfterCancel).not.toMatch(
            /No streaming response found for request_id=/,
        );

        const resumedResponse = await proxiedAgent.download(sourcePath);
        // Android can retry a canceled browser download as a second full HTTP request.
        expect(resumedResponse.status).toBe(200);
        const resumedBytes = Buffer.from(await resumedResponse.arrayBuffer());
        // Matching all bytes proves the replacement request itself completed successfully.
        expect(Buffer.compare(resumedBytes, downloadContent)).toBe(0);

        const completedTransfer = await waitForValue({
            description: "completed download progress row after full retry",
            timeoutMs: 30000,
            predicate: async () => {
                const response = await apiClient.getTransferProgress();
                const completed = response.transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.request_id === activeTransfer.request_id &&
                        transfer.state === "completed",
                );
                if (completed) {
                    return completed;
                }
                const matching = response.transfers.filter(
                    (transfer: TransferProgressEntry) =>
                        transfer.agent_id === proxiedAgent.id &&
                        transfer.path === sourcePath,
                );
                throw new Error(JSON.stringify(matching));
            },
        });

        // Reusing the logical request row prevents a successful resumed download from retaining a false error.
        expect(completedTransfer.error).toBeNull();
        // Full progress confirms the successful retry replaced the original partial count.
        expect(completedTransfer.transferred_bytes).toBe(totalBytes);
        const matchingTransfers = (
            await apiClient.getTransferProgress()
        ).transfers.filter(
            (transfer: TransferProgressEntry) =>
                transfer.agent_id === proxiedAgent.id &&
                transfer.path === sourcePath &&
                transfer.direction === "download",
        );
        // One row proves the retry was folded into the original logical download instead of reported separately.
        expect(matchingTransfers).toHaveLength(1);
    }, 50000);

    it("should return proper error for permission denied", async () => {
        const testFilePath = tempFiles.create("secret", { suffix: ".txt" });
        fs.chmodSync(testFilePath, 0o000);

        try {
            // The agent should propagate the actual OS error message
            await expect(testAgent.raw(testFilePath)).rejects.toThrow(
                /permission denied/i,
            );
        } finally {
            // Restore permissions so cleanup works
            fs.chmodSync(testFilePath, 0o644);
        }
    });

    it("should set correct Content-Disposition header", async () => {
        const testContent = "test content";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            download: true,
        });
        console.log(
            "Content-Disposition headers:",
            response.headers.get("Content-Disposition"),
        );
        expect(response.headers.get("Content-Disposition")).toMatch(
            /attachment/,
        );
        expect(response.headers.get("Content-Disposition")).toMatch(/\.txt/);
    });

    it("should indicate range support with Accept-Ranges header", async () => {
        const testContent = "test content for range check";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath);

        // A normal GET advertises resumability now that HEAD is not part of the download contract.
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    });

    it("should return 206 Partial Content for range request", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [0, 9],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-9/100");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe("0123456789");
    });

    it("should handle suffix range request (last N bytes)", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [null, 10],
        });

        expect(response.status).toBe(206);
        // Last 10 bytes should be "0123456789"
        expect(response.headers.get("Content-Range")).toBe("bytes 90-99/100");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe("0123456789");
    });

    it("should handle open-ended range request (from byte to end)", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [50, null],
        });

        expect(response.status).toBe(206);
        // From byte 50 to end (99) = 50 bytes
        expect(response.headers.get("Content-Range")).toBe("bytes 50-99/100");
        expect(response.headers.get("Content-Length")).toBe("50");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(50);
    });

    it("should return 416 for unsatisfiable range", async () => {
        // Create a small test file (10 bytes)
        const testContent = "0123456789";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [100, 200],
        });

        expect(response.status).toBe(416);
        expect(response.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("should handle range request for binary file", async () => {
        // Create binary file with pattern 0x00-0xFF repeated
        const pattern = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const testContent = Buffer.concat([pattern, pattern, pattern, pattern]); // 1024 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".bin" });

        const response = await testAgent.download(testFilePath, {
            range: [100, 109],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe(
            "bytes 100-109/1024",
        );
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(10);

        // Verify the content matches expected bytes (wrapping around at 256)
        const expected = new Uint8Array([
            100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
        ]);
        const actual = new Uint8Array(data);
        for (let i = 0; i < 10; i++) {
            expect(actual[i]).toBe(expected[i]);
        }
    });

    it("should return 200 OK for full file without Range header", async () => {
        const testContent = "Full file content without range";
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath);

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Range")).toBeNull();
        expect(response.headers.get("Content-Length")).toBe(
            testContent.length.toString(),
        );

        const data = await response.arrayBuffer();
        const content = Buffer.from(data).toString("utf-8");
        expect(content).toBe(testContent);
    });

    it("should handle range at end of file", async () => {
        // Create test file with known content (100 bytes)
        const testContent = "0123456789".repeat(10); // 100 bytes
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [95, 99],
        });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 95-99/100");
        expect(response.headers.get("Content-Length")).toBe("5");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(5);
    });

    it("should clamp range end to file size", async () => {
        // Create test file (50 bytes)
        const testContent = "x".repeat(50);
        const testFilePath = tempFiles.create(testContent, { suffix: ".txt" });

        const response = await testAgent.download(testFilePath, {
            range: [40, 100], // Request beyond file size
        });

        expect(response.status).toBe(206);
        // Should clamp to 40-49 (10 bytes)
        expect(response.headers.get("Content-Range")).toBe("bytes 40-49/50");
        expect(response.headers.get("Content-Length")).toBe("10");

        const data = await response.arrayBuffer();
        expect(data.byteLength).toBe(10);
    });
});
