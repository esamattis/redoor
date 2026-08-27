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

import {
    ApiError,
    type Agent,
    type ApiClient,
    type LogEvent,
} from "#ui/api-client";
import {
    ProcessManager,
    TempFileManager,
    getAvailablePort,
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

afterAll(async () => {
    await processManager.killAll();
    tempFiles.cleanup();
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

/** Opens the server process stream so runtime admission can be observed independently. */
async function openServerLogSocket(): Promise<{
    socket: WebSocket;
    events: LogEvent[];
}> {
    const socket = new WebSocket(apiClient.getServerLogsWebSocketUrl(), {
        headers: apiClient.getAuthHeaders(),
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
            () =>
                reject(new Error("idle log websocket did not receive a ping")),
            // The suite sets REDOOR_WEBSOCKET_KEEPALIVE=200ms, so a live ping arrives far sooner than production's 10s.
            2_000,
        );
        socket.once("ping", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

describe.sequential("dedicated agent log tunnel", () => {
    it("authenticates and changes server and agent logging levels at runtime", async () => {
        const unauthenticated = await fetch(
            `${apiClient.baseUrl}/api/v1/server/logging-level`,
        );
        // Logging control must be protected by the same browser session middleware as log viewing.
        expect(unauthenticated.status).toBe(401);

        const initialServer = await apiClient.getServerLoggingLevel();
        // Info remains the default when this test process supplies no startup override.
        expect(initialServer.level).toBe("info");
        const changedServer = await apiClient.updateServerLoggingLevel("debug");
        // The update response must report the process-authoritative value, not merely echo a pending choice.
        expect(changedServer.level).toBe("debug");
        // A separate read proves the atomic value survives beyond the update request.
        expect((await apiClient.getServerLoggingLevel()).level).toBe("debug");

        const initialAgent = await testAgent.getLoggingLevel();
        // A connected agent exposes its own process threshold rather than the server threshold.
        expect(initialAgent.level).toBe("info");
        const changedAgent = await testAgent.updateLoggingLevel("trace");
        // Runtime control must travel over the authoritative agent command connection.
        expect(changedAgent.level).toBe("trace");
        // Restoring defaults prevents this workflow from changing unrelated log-volume assertions.
        expect((await testAgent.updateLoggingLevel("info")).level).toBe("info");
        expect((await apiClient.updateServerLoggingLevel("info")).level).toBe(
            "info",
        );
    });

    it("rejects invalid logging levels with a clear client error", async () => {
        const response = await fetch(
            `${apiClient.baseUrl}/api/v1/server/logging-level`,
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    ...apiClient.getAuthHeaders(),
                },
                body: JSON.stringify({ level: "verbose" }),
            },
        );
        // Invalid enum values must be rejected instead of silently selecting the default.
        expect(response.status).toBe(422);
        // The rejection names the invalid field vocabulary so API callers can correct it.
        expect(await response.text()).toContain("unknown variant");
    });

    it("applies runtime thresholds before server and agent records reach live streams", async () => {
        const serverLogs = await openServerLogSocket();
        await waitForEvent(
            serverLogs.events,
            (event) => event.type === "snapshot",
            "server snapshot before threshold checks",
        );

        await apiClient.updateServerLoggingLevel("error");
        await testAgent.getLoggingLevel();
        await apiClient.updateServerLoggingLevel("trace");
        await testAgent.getLoggingLevel();
        await waitForEvent(
            serverLogs.events,
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Routing REST command:"),
            "enabled server trace command marker",
        );
        const serverTraceEntries = serverLogs.events.filter(
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Routing REST command:"),
        );
        // Only the command sent after enabling trace may reach the live stream.
        expect(serverTraceEntries).toHaveLength(1);
        await apiClient.updateServerLoggingLevel("info");

        await testAgent.updateLoggingLevel("error");
        const observingAgentLogs = await openLogSocket();
        await waitForEvent(
            observingAgentLogs.events,
            (event) => event.type === "snapshot",
            "agent snapshot before threshold checks",
        );
        const suppressedAgentLogs = await openLogSocket();
        await waitForEvent(
            suppressedAgentLogs.events,
            (event) => event.type === "snapshot",
            "agent snapshot while info is disabled",
        );
        await testAgent.updateLoggingLevel("trace");
        const enabledAgentLogs = await openLogSocket();
        await waitForEvent(
            enabledAgentLogs.events,
            (event) => event.type === "snapshot",
            "agent snapshot after trace is enabled",
        );
        await waitForEvent(
            observingAgentLogs.events,
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Agent log stream started:"),
            "enabled agent stream-start marker",
        );
        const agentInfoEntries = observingAgentLogs.events.filter(
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Agent log stream started:"),
        );
        // The observer and suppressed stream started below the error threshold; only the trace-era stream is emitted.
        expect(agentInfoEntries).toHaveLength(1);
        suppressedAgentLogs.socket.close();
        enabledAgentLogs.socket.close();
        await testAgent.updateLoggingLevel("info");
    });

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

    it("uses CLI log format over environment and TOML", async () => {
        const port = await getAvailablePort();
        const config = tempFiles.create(
            `agent_token = "format-test-token"

[server]
port = ${port}
username = "format-user"
password = "format-password"
log_format = "line"
`,
            { suffix: ".toml" },
        );
        const pid = processManager.spawn(
            join(import.meta.dirname, "../target/debug/redoor"),
            ["server", "--config", config, "--log-format", "json"],
            { env: { REDOOR_SERVER_LOG_FORMAT: "line" } },
        );
        onTestFinished(() => processManager.kill(pid));
        const output = await waitForValue({
            predicate: async () => {
                const lines = processManager
                    .getStdout(pid)
                    .split("\n")
                    .filter(Boolean);
                return lines.find((line) => line.startsWith("{"));
            },
            description: "newline-delimited JSON server output",
        });
        const record: {
            timestamp: string;
            level: string;
            message: string;
            error: unknown;
        } = JSON.parse(output);
        // CLI JSON wins over both the role environment and TOML line settings.
        expect(record).toMatchObject({ level: "info", error: null });
        // Every NDJSON line contains the same structured fields sent to browser streams.
        expect(record.timestamp).toMatch(/T.*(?:Z|[+-]\d{2}:\d{2})$/);
        expect(record.message.length).toBeGreaterThan(0);
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
        // Startup and control-connection records prove replay comes from this agent process.
        expect(
            snapshot.type === "snapshot" &&
                snapshot.entries.some((entry) =>
                    entry.message.includes("Agent connected:"),
                ),
        ).toBe(true);

        const started = await waitForEvent(
            first.events,
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Agent log stream started:"),
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
    }, 5_000);

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

        await Promise.all([
            waitForPing(uiSocket),
            waitForPing(serverLogsSocket),
        ]);

        // The refresh socket must stay open without requiring a router event.
        expect(uiSocket.readyState).toBe(WebSocket.OPEN);
        // The log socket must keep writing even when no new log entry is available.
        expect(serverLogsSocket.readyState).toBe(WebSocket.OPEN);
    }, 5_000);

    it("releases agent and server resources when the browser disconnects", async () => {
        const opened = await openLogSocket();
        const started = await waitForEvent(
            opened.events,
            (event) =>
                event.type === "entry" &&
                event.entry.message.includes("Agent log stream started:"),
            "stream identifier marker",
        );
        if (started.type !== "entry") {
            throw new Error("stream start event had an unexpected shape");
        }
        // The relay must preserve independent structured fields instead of rendering prefixes.
        expect(started.entry).toMatchObject({
            level: "info",
            error: null,
        });
        // An explicit offset and millisecond precision make timestamps portable across viewers.
        expect(started.entry.timestamp).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/,
        );
        const id = started.entry.message.match(
            /log_stream_id=([0-9a-f-]+)/,
        )?.[1];
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
        const unavailable = await testAgent
            .getLoggingLevel()
            .catch((error) => error);
        // A disconnected update/read must fail rather than displaying a value from server state.
        expect(unavailable).toBeInstanceOf(ApiError);
        if (unavailable instanceof ApiError) {
            // The REST status must identify unavailable agent control without mutating any confirmed UI value.
            expect([404, 503]).toContain(unavailable.status);
        }
    });
});
