import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { GitDirectoryEntriesResponse } from "#bindings/GitDirectoryEntriesResponse";
import type { GitStatusResponse } from "#bindings/GitStatusResponse";
import type { GitWorktreeStatusResponse } from "#bindings/GitWorktreeStatusResponse";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { Agent, ApiClient } from "#ui/api-client";
import { FakeAgent, type StreamFrame } from "./fake-agent";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

/** Body of the upload the fake agent receives. */
const UPLOAD_BODY = Buffer.from("request lifecycle upload body");

describe("request lifecycle on the multiplexed connection", () => {
    const processes = new ProcessManager();
    const tempFiles = new TempFileManager();
    let api: ApiClient;
    let serverPort: number;

    beforeAll(async () => {
        const setup = await startServerAndAgent({
            processManager: processes,
            agentName: "request-lifecycle-agent",
            agentCwd: tempFiles.tempDirectory({ suffix: "-request-lifecycle" }),
        });

        api = setup.apiClient;
        serverPort = setup.serverPort;
    }, 30000);

    afterAll(async () => {
        await processes.killAll();
        tempFiles.cleanup();
    });

    /** Connects a fake agent and waits until the server lists it as connected. */
    async function connectFake(agentName: string): Promise<FakeAgent> {
        const fake = await FakeAgent.connect({ serverPort, agentName });

        onTestFinished(() => fake.close());
        await waitForValue({
            description: "fake agent connected",
            predicate: async () =>
                (await api.listAgents()).find(
                    (agent) =>
                        agent.id === fake.agentId && agent.status === "connected",
                ),
        });

        return fake;
    }

    /** Answers the metadata lookup a raw download makes before it starts streaming. */
    async function answerMetadata(fake: FakeAgent, path: string, size: number): Promise<void> {
        const command = await fake.nextCommand("Metadata");

        const metadata: MetadataResponse = {
            path,
            mime_type: "application/octet-stream",
            file_size: size,
            is_file: true,
            is_dir: false,
            editable: false,
            viewable_image: false,
            one_time_tokens: [],
        };

        fake.respond(command.id, metadata);
    }

    it("sends upload data only after the agent's credit grant and never publishes a canceled upload", async () => {
        const agentName = "request-lifecycle-upload";
        const fake = await connectFake(agentName);
        const path = "/tmp/request-lifecycle.bin";
        const frames: StreamFrame[] = [];
        let granted = false;
        let framesBeforeGrant = 0;

        fake.onStreamFrame((frame) => {
            if (!granted) {
                framesBeforeGrant++;
            }

            frames.push(frame);
        });

        const upload = fetch(`${api.baseUrl}/api/v1/agents/${agentName}/raw${path}`, {
            method: "PUT",
            headers: {
                ...api.getAuthHeaders(),
                "Content-Type": "application/octet-stream",
                "Content-Length": UPLOAD_BODY.length.toString(),
            },
            body: UPLOAD_BODY,
        });

        const command = await fake.nextCommand("RawUpload");

        // Uploads start without credit, because the agent's worker may not exist yet.
        expect(command.credit).toBe(0);
        granted = true;
        fake.grantCredit(command.id, 4);

        await waitForValue({
            description: "upload body to end with FIN",
            predicate: async () =>
                frames.find((frame) => frame.stream === command.id && frame.last),
        });

        // The first grant is the readiness signal; nothing was sent before it.
        expect(framesBeforeGrant).toBe(0);
        // The whole body arrived on the upload's stream.
        expect(Buffer.concat(frames.map((frame) => frame.data))).toEqual(UPLOAD_BODY);

        const transfer = await waitForValue({
            description: "upload listed as active",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) => entry.path === path && entry.state === "active",
                ),
        });

        await api.cancelTransfer(transfer.request_id);

        const cancel = await fake.waitForFrame(
            (frame) => frame.type === "cancel" && frame.id === command.id,
        );

        // The command was written long ago, so the cancel goes to the agent.
        expect(cancel.id).toBe(command.id);

        // The agent asks to publish only after the cancel was decided.
        fake.send({ type: "publish_request", id: command.id });

        const decision = await fake.waitForFrame(
            (frame) => frame.type === "publish_decision" && frame.id === command.id,
        );

        // A canceled upload must never replace its destination.
        expect(decision.allowed).toBe(false);

        fake.fail(command.id, "canceled", "Upload canceled by server");

        const settled = await waitForValue({
            description: "canceled upload to settle",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) => entry.path === path && entry.state === "canceled",
                ),
        });

        // The agent's result acknowledges the cancel, so the row ends canceled.
        expect(settled.state).toBe("canceled");
        // The HTTP client learns that its upload did not happen.
        expect((await upload).ok).toBe(false);
    });

    it("delivers a download's data before settling it on the result that follows", async () => {
        const agentName = "request-lifecycle-download";
        const fake = await connectFake(agentName);
        const path = "/tmp/request-lifecycle-download.bin";

        const response = fetch(`${api.baseUrl}/api/v1/agents/${agentName}/raw${path}`, {
            headers: api.getAuthHeaders(),
        });

        await answerMetadata(fake, path, "first second".length);

        const command = await fake.nextCommand("RawDownload");

        // Output streams get their initial credit in the command frame.
        expect(command.credit).toBeGreaterThan(0);
        fake.sendStreamFrame(command.id, Buffer.from("first "));
        fake.sendStreamFrame(command.id, Buffer.from("second"), { last: true });

        const download = await response;

        // FIN ends the body successfully even before the result arrives.
        expect(await download.text()).toBe("first second");

        fake.respond(command.id, null);

        const settled = await waitForValue({
            description: "download to complete on its result",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) => entry.path === path && entry.state === "completed",
                ),
        });

        // Completion counts every byte of the stream, which preceded the result.
        expect(settled.transferred_bytes).toBe("first second".length);
    });

    it("fails a download whose result reports an error after partial data", async () => {
        const agentName = "request-lifecycle-failed-download";
        const fake = await connectFake(agentName);
        const path = "/tmp/request-lifecycle-failed.bin";

        const response = fetch(`${api.baseUrl}/api/v1/agents/${agentName}/raw${path}`, {
            headers: api.getAuthHeaders(),
        });

        await answerMetadata(fake, path, 64);

        const command = await fake.nextCommand("RawDownload");

        fake.sendStreamFrame(command.id, Buffer.from("partial"));
        // A failed stream ends without FIN; the result carries the failure.
        fake.fail(command.id, "internal", "Failed to read file: disk gone");

        // The client must not mistake the partial body for a complete file; the connection
        // may abort before or after the headers were flushed.
        await expect(response.then((download) => download.text())).rejects.toThrow();

        const settled = await waitForValue({
            description: "download to fail on its result",
            predicate: async () =>
                (await api.getTransferProgress()).transfers.find(
                    (entry) => entry.path === path && entry.state === "errored",
                ),
        });

        // The history row carries the agent's reason.
        expect(settled.error).toBe("Failed to read file: disk gone");
    });

    /** Long-running reads that should stop on the agent once their caller gives up. */
    const abandonableReads: {
        command: string;
        start: (
            agent: Agent,
            signal: AbortSignal,
        ) => Promise<
            | FileSearchResponse
            | ContentGrepResponse
            | GitStatusResponse
            | GitDirectoryEntriesResponse
            | GitWorktreeStatusResponse
        >;
    }[] = [
        {
            command: "FileSearch",
            start: (agent, signal) =>
                agent.searchFiles("/tmp", "abandoned", {
                    timeoutSeconds: 60,
                    includeHidden: false,
                    respectGitignore: true,
                    signal,
                }),
        },
        {
            command: "ContentGrep",
            start: (agent, signal) =>
                agent.grepContent("/tmp", "abandoned", {
                    timeoutSeconds: 60,
                    includeHidden: false,
                    respectGitignore: true,
                    fixedString: true,
                    signal,
                }),
        },
        {
            command: "GitStatus",
            start: (agent, signal) => agent.gitStatus("/tmp", { signal }),
        },
        {
            command: "GitDirectoryEntries",
            start: (agent, signal) =>
                agent.gitDirectoryEntries("/tmp", { signal }),
        },
        {
            command: "GitWorktreeStatus",
            start: (agent, signal) =>
                agent.gitWorktreeStatus(["/tmp"], { signal }),
        },
    ];

    it.each(abandonableReads)(
        "cancels an abandoned $command on the agent",
        async (read) => {
            const agentName = `request-lifecycle-abandon-${read.command.toLowerCase()}`;
            const fake = await connectFake(agentName);

            const agent = (await api.listAgents()).find(
                (candidate) => candidate.id === fake.agentId,
            );

            if (agent === undefined) {
                throw new Error(`Fake agent ${agentName} is not listed`);
            }

            const controller = new AbortController();
            const request = read.start(agent, controller.signal);
            // The aborted request rejects by design; keep it from surfacing as unhandled.
            request.catch(() => undefined);

            const command = await fake.nextCommand(read.command);

            // The fake never answers, so the command is still running when the browser leaves.
            controller.abort();

            const cancel = await fake.waitForFrame(
                (frame) => frame.type === "cancel" && frame.id === command.id,
            );

            // The server must tell the agent to stop exactly the abandoned request, or the
            // search keeps its slots until its own timeout and newer searches queue behind it.
            expect(cancel).toMatchObject({ type: "cancel", id: command.id });
            await expect(request).rejects.toThrow();
        },
    );
});
