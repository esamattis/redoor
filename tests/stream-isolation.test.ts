import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import WebSocket from "ws";
import type { Agent, ApiClient } from "#ui/api-client";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import type { ExecEvent } from "#bindings/ExecEvent";
import { openTerminal as openTerminalSession } from "./terminal-test-utils";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
} from "./test-utils";

const AGENT_NAME = "stream-isolation-agent";

/** Large enough that the unread body cannot hide in socket and HTTP client buffers. */
const STALLED_FILE_BYTES = 64 * 1024 * 1024;

/** Upper bound for an interactive round trip that must not queue behind bulk data. */
const INTERACTIVE_LATENCY_MS = 2000;

/** Size of the bulk upload that runs while control commands are measured. */
const BULK_UPLOAD_BYTES = 256 * 1024 * 1024;

/** One megabyte of upload body, produced on demand so the test never buffers the upload. */
const UPLOAD_CHUNK = Buffer.alloc(1024 * 1024, "u");

describe("Per-stream transfer isolation", () => {
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

    afterAll(async () => {
        await processManager.killAll();
        tempFiles.cleanup();
    });

    /** Runs one command through the exec endpoint and decodes its NDJSON events. */
    async function execEvents(argv: string[]): Promise<ExecEvent[]> {
        const response = await fetch(
            `${apiClient.baseUrl}/api/v1/agents/${testAgent.id}/exec`,
            {
                method: "POST",
                headers: {
                    ...apiClient.getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ argv }),
            },
        );

        // Admission must succeed even though another stream of the agent is stalled.
        expect(response.status).toBe(200);

        return (await response.text())
            .trim()
            .split("\n")
            .map((line): ExecEvent => JSON.parse(line));
    }

    /** Starts a download whose body is never read, and waits until it is mid-stream. */
    async function stallDownload(): Promise<string> {
        const stalledPath = tempFiles.create(
            Buffer.alloc(STALLED_FILE_BYTES, "s"),
            { suffix: ".bin" },
        );

        const stalledAbort = new AbortController();

        onTestFinished(() => stalledAbort.abort());

        const stalled = await fetch(testAgent.getRawUrl(stalledPath), {
            headers: testAgent.getAuthHeaders(),
            signal: stalledAbort.signal,
        });

        // Headers arrive only after the agent started streaming the stalled file.
        expect(stalled.status).toBe(200);
        await waitForValue({
            description: "stalled download to transfer its first bytes",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === stalledPath &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0,
                ),
        });

        return stalledPath;
    }

    /** Opens a terminal session and resolves once its PTY is ready. */
    async function openTerminal(): Promise<WebSocket> {
        const { viewer } = await openTerminalSession(
            apiClient,
            testAgent,
            testAgent.cwd ?? "/",
        );

        return viewer.socket;
    }

    /** Types `marker` into the terminal and resolves with the time until it is echoed. */
    async function echoLatency(
        socket: WebSocket,
        marker: string,
    ): Promise<number> {
        const started = performance.now();
        const decoder = new TextDecoder();
        let output = "";

        const echoed = new Promise<void>((resolve) => {
            const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
                if (!isBinary || !(data instanceof ArrayBuffer)) {
                    return;
                }

                output =
                    `${output}${decoder.decode(new Uint8Array(data), { stream: true })}`.slice(
                        -4096,
                    );

                if (output.includes(marker)) {
                    socket.off("message", onMessage);
                    resolve();
                }
            };

            socket.on("message", onMessage);
        });

        socket.send(Buffer.from(`echo ${marker}\r`));
        await echoed;

        return performance.now() - started;
    }

    it("keeps terminal echoes fast while a download consumer is stalled", async () => {
        await stallDownload();
        const terminal = await openTerminal();
        const marker = `isolated-terminal-${Date.now()}`;

        const latency = await echoLatency(terminal, marker);

        // Terminal frames use the interactive lane, so they never queue behind stalled bulk data.
        expect(latency).toBeLessThan(INTERACTIVE_LATENCY_MS);
    }, 60000);

    it("keeps control commands fast while a bulk upload streams", async () => {
        const uploadPath = tempFiles.tempFile({ suffix: "-bulk.bin" });
        let produced = 0;

        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (produced >= BULK_UPLOAD_BYTES) {
                    controller.close();

                    return;
                }

                controller.enqueue(UPLOAD_CHUNK);
                produced += UPLOAD_CHUNK.length;
            },
        });

        // A separate options object lets Node's streaming `duplex` field through the DOM types.
        const uploadOptions = {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": BULK_UPLOAD_BYTES.toString(),
                ...testAgent.getAuthHeaders(),
            },
            body,
            duplex: "half",
        };

        const upload = fetch(testAgent.getRawUrl(uploadPath), uploadOptions);

        await waitForValue({
            description: "bulk upload to stream its first bytes",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === uploadPath &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0,
                ),
        });

        const latencies: number[] = [];

        for (let index = 0; index < 5; index++) {
            const started = performance.now();

            // Each echo is a full command round trip on the connection the upload saturates.
            expect(
                (await testAgent.echo(`during-upload-${index}`)).message,
            ).toBe(`during-upload-${index}`);
            latencies.push(performance.now() - started);
        }

        // Control frames go ahead of bulk data, so commands stay fast during the upload.
        expect(Math.max(...latencies)).toBeLessThan(INTERACTIVE_LATENCY_MS);
        // The upload itself still completes on the shared connection.
        expect((await upload).ok).toBe(true);
    }, 120000);

    it("keeps other downloads and exec output flowing while one download consumer is stalled", async () => {
        const stalledPath = tempFiles.create(
            Buffer.alloc(STALLED_FILE_BYTES, "s"),
            { suffix: ".bin" },
        );

        const independentContent = "independent download on the same agent";

        const independentPath = tempFiles.create(independentContent, {
            suffix: ".txt",
        });

        const stalledAbort = new AbortController();
        onTestFinished(() => stalledAbort.abort());

        // The response body is deliberately never read, so this consumer stalls once the
        // socket and client buffers are full.
        const stalled = await fetch(testAgent.getRawUrl(stalledPath), {
            headers: testAgent.getAuthHeaders(),
            signal: stalledAbort.signal,
        });

        // Headers arrive only after the agent started streaming the stalled file.
        expect(stalled.status).toBe(200);

        const stalledTransfer = await waitForValue({
            description: "stalled download to transfer its first bytes",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === stalledPath &&
                        transfer.state === "active" &&
                        transfer.transferred_bytes > 0,
                ),
        });

        // The stalled download really is mid-stream, sharing the agent's connection.
        expect(stalledTransfer.transferred_bytes).toBeLessThan(
            STALLED_FILE_BYTES,
        );

        const independent = Buffer.from(
            await testAgent.raw(independentPath),
        ).toString("utf-8");

        // A second download on the same connection completes despite the stalled consumer.
        expect(independent).toBe(independentContent);

        const events = await execEvents(["sh", "-c", "echo isolated"]);

        // Exec output also shares the connection and must not queue behind the stall.
        expect(
            Buffer.from(
                events
                    .filter((event) => event.type === "stdout")
                    .flatMap((event) => event.data),
            ).toString(),
        ).toBe("isolated\n");
        // The process exit is reported normally, proving the stream reached its terminal frame.
        expect(events.at(-1)).toEqual({ type: "exit", code: 0, signal: null });

        stalledAbort.abort();

        const settled = await waitForValue({
            description: "stalled download to settle after its client left",
            predicate: async () =>
                (await apiClient.getTransferProgress()).transfers.find(
                    (transfer: TransferProgressEntry) =>
                        transfer.path === stalledPath &&
                        transfer.state !== "active",
                ),
        });

        // Dropping the stalled body still cancels its agent worker through the router.
        expect(settled.error).toBe("Download canceled by client");
    }, 60000);
});
