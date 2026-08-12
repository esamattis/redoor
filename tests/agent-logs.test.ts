import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
} from "vitest";
import WebSocket from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent, ApiClient, LogEvent } from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    startServerAndAgent,
    waitForValue,
    webSocketDataToString,
} from "./test-utils";

const processManager = new ProcessManager();
const tempFiles = new TempFileManager();
const agentCwd = tempFiles.tempDirectory({ suffix: "-agent-logs" });
const agentLogPath = join(import.meta.dirname, "../log/agent-logs-agent.log");
let testAgent: Agent;
let apiClient: ApiClient;
let serverPid: number;
let agentPid: number;

beforeAll(async () => {
    const started = await startServerAndAgent({
        processManager,
        agentName: "agent-logs-agent",
        agentCwd,
    });
    testAgent = started.testAgent;
    apiClient = started.apiClient;
    serverPid = started.serverPid;
    agentPid = started.agentPid;
}, 30_000);

afterAll(() => {
    tempFiles.cleanup();
    processManager.killAll();
});

/** Parses one text WebSocket payload into the generated shared event shape. */
function parseEvent(data: WebSocket.RawData): LogEvent {
    const event: LogEvent = JSON.parse(webSocketDataToString(data));
    return event;
}

/** Opens an authenticated browser tunnel and captures events in arrival order. */
async function openLogSocket(): Promise<{
    socket: WebSocket;
    events: LogEvent[];
}> {
    const socket = new WebSocket(testAgent.getLogsWebSocketUrl(), {
        headers: testAgent.getAuthHeaders(),
    });
    onTestFinished(() => socket.close());
    const events: LogEvent[] = [];
    socket.on("message", (data) => events.push(parseEvent(data)));
    await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    return { socket, events };
}

/** Polls the captured bounded event list until one event satisfies the requested predicate. */
async function waitForEvent(
    events: LogEvent[],
    predicate: (event: LogEvent) => boolean,
    description: string,
): Promise<LogEvent> {
    return waitForValue({
        predicate: async () => events.find(predicate),
        description,
    });
}

/** Resolves when a WebSocket closes, including sockets already closed by a fast peer. */
async function waitForClose(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
        return;
    }
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

/** Resolves on the server-originated control frame without adding application traffic. */
async function waitForPing(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("idle log websocket did not receive a ping")),
            15_000,
        );
        socket.once("ping", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

describe.sequential("dedicated agent log tunnel", () => {
    it("requires browser authentication", async () => {
        const status = await new Promise<number>((resolve, reject) => {
            const socket = new WebSocket(testAgent.getLogsWebSocketUrl());
            onTestFinished(() => socket.close());
            socket.once("unexpected-response", (_request, response) => {
                resolve(response.statusCode ?? 0);
                response.resume();
            });
            socket.once("open", () =>
                reject(
                    new Error(
                        "unauthenticated log websocket unexpectedly opened",
                    ),
                ),
            );
            socket.once("error", () => {});
        });
        // The browser endpoint must remain behind session middleware.
        expect(status).toBe(401);
    });

    it("delivers history before live entries and reconnects with a fresh snapshot", async () => {
        const first = await openLogSocket();
        const snapshot = await waitForEvent(
            first.events,
            (event) => event.type === "snapshot",
            "initial agent log snapshot",
        );
        // Persistent agent logging must be advertised to enable historical context.
        expect(
            snapshot.type === "snapshot" && snapshot.file_logging_enabled,
        ).toBe(true);
        // Startup and control-connection records prove the snapshot came from the agent file.
        expect(
            snapshot.type === "snapshot" &&
                snapshot.entries.some((entry) =>
                    entry.includes("Agent connected:"),
                ),
        ).toBe(true);

        const started = await waitForEvent(
            first.events,
            (event) =>
                event.type === "entry" &&
                event.entry.includes("Agent log stream started:"),
            "live stream-start entry",
        );
        // Arrival order must put the replacement snapshot before every live marker.
        expect(first.events.indexOf(snapshot)).toBeLessThan(
            first.events.indexOf(started),
        );
        first.socket.close();
        await waitForClose(first.socket);

        const second = await openLogSocket();
        const secondSnapshot = await waitForEvent(
            second.events,
            (event) => event.type === "snapshot",
            "reconnected agent log snapshot",
        );
        // Every reconnect starts with replacement state rather than continuing a stale stream.
        expect(second.events[0]).toBe(secondSnapshot);
    });

    it("keeps an idle browser-facing relay alive", async () => {
        const opened = await openLogSocket();
        await waitForEvent(
            opened.events,
            (event) => event.type === "snapshot",
            "snapshot before idle log keepalive",
        );
        await waitForPing(opened.socket);

        // Receiving a later keepalive without a close proves the idle browser leg stayed active.
        expect(opened.socket.readyState).toBe(WebSocket.OPEN);
    }, 20_000);

    it("keeps idle UI refresh and server log sockets active", async () => {
        const uiSocket = new WebSocket(apiClient.getUiWebSocketUrl(), {
            headers: apiClient.getAuthHeaders(),
        });
        const serverLogsSocket = new WebSocket(
            apiClient.getServerLogsWebSocketUrl(),
            { headers: apiClient.getAuthHeaders() },
        );
        onTestFinished(() => uiSocket.close());
        onTestFinished(() => serverLogsSocket.close());
        await Promise.all([
            new Promise<void>((resolve, reject) => {
                uiSocket.once("open", resolve);
                uiSocket.once("error", reject);
            }),
            new Promise<void>((resolve, reject) => {
                serverLogsSocket.once("open", resolve);
                serverLogsSocket.once("error", reject);
            }),
        ]);

        await Promise.all([waitForPing(uiSocket), waitForPing(serverLogsSocket)]);

        // The refresh socket must stay open without requiring a router event.
        expect(uiSocket.readyState).toBe(WebSocket.OPEN);
        // The log socket must keep writing even when no new log entry is available.
        expect(serverLogsSocket.readyState).toBe(WebSocket.OPEN);
    }, 20_000);

    it("releases agent and server resources when the browser disconnects", async () => {
        const opened = await openLogSocket();
        const started = await waitForEvent(
            opened.events,
            (event) =>
                event.type === "entry" &&
                event.entry.includes("Agent log stream started:"),
            "stream identifier marker",
        );
        if (started.type !== "entry") {
            throw new Error("stream start event had an unexpected shape");
        }
        const id = started.entry.match(/log_stream_id=([0-9a-f-]+)/)?.[1];
        // Lifecycle correlation requires the same non-secret identifier at both relay ends.
        expect(id).toBeDefined();
        if (!id) {
            return;
        }

        opened.socket.close();
        await waitForClose(opened.socket);
        await waitForValue({
            predicate: async () => {
                const contents = await readFile(agentLogPath, "utf8");
                return contents.includes(
                    `Agent log stream stopped: log_stream_id=${id}`,
                )
                    ? true
                    : undefined;
            },
            description: "agent log subscription cleanup marker",
        });
        // The agent marker proves its broadcast receiver and active handle were released.
        expect(await readFile(agentLogPath, "utf8")).toContain(
            `Agent log stream stopped: log_stream_id=${id}`,
        );
        await waitForValue({
            predicate: async () =>
                processManager
                    .getStdout(serverPid)
                    .includes(
                        `Agent log relay stopped: agent_id=${testAgent.id}, log_stream_id=${id}`,
                    )
                    ? true
                    : undefined,
            description: "server relay cleanup marker",
        });
        // The matching server marker proves no detached relay survived browser teardown.
        expect(processManager.getStdout(serverPid)).toContain(
            `Agent log relay stopped: agent_id=${testAgent.id}, log_stream_id=${id}`,
        );
    });

    it("closes active streams when the authoritative agent connection is lost", async () => {
        const opened = await openLogSocket();
        await waitForEvent(
            opened.events,
            (event) => event.type === "snapshot",
            "snapshot before agent shutdown",
        );
        const closed = waitForClose(opened.socket);
        processManager.kill(agentPid);
        await closed;
        // Dedicated socket closure proves control disconnect canceled active agent stream work.
        expect(opened.socket.readyState).toBe(WebSocket.CLOSED);
        const disconnected = await waitForValue({
            predicate: async () => {
                const current = (await apiClient.listAgents()).find(
                    (agent) => agent.id === testAgent.id,
                );
                return current?.status !== "connected" ? current : undefined;
            },
            description: "retained agent inventory to become disconnected",
        });
        // Router inventory must stop advertising a live agent after authoritative socket loss.
        expect(disconnected.status).not.toBe("connected");
    });
});
