import * as React from "react";
import { ScrollText } from "lucide-react";

import type { LogEvent } from "../api-client";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type LogEntry = { id: number; text: string };

const MAX_LOG_ENTRIES = 500;

/** Rejects structurally invalid payloads before they can corrupt the displayed rolling window. */
function parseLogEvent(data: string): LogEvent {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
        throw new Error("Server sent an invalid log event");
    }

    if (
        parsed.type === "snapshot" &&
        "entries" in parsed &&
        Array.isArray(parsed.entries) &&
        parsed.entries.every((entry) => typeof entry === "string") &&
        "file_logging_enabled" in parsed &&
        typeof parsed.file_logging_enabled === "boolean"
    ) {
        return {
            type: "snapshot",
            entries: parsed.entries,
            file_logging_enabled: parsed.file_logging_enabled,
        };
    }
    if (
        parsed.type === "entry" &&
        "entry" in parsed &&
        typeof parsed.entry === "string"
    ) {
        return { type: "entry", entry: parsed.entry };
    }
    if (
        parsed.type === "lagged" &&
        "skipped" in parsed &&
        typeof parsed.skipped === "number"
    ) {
        return { type: "lagged", skipped: parsed.skipped };
    }
    if (
        parsed.type === "error" &&
        "message" in parsed &&
        typeof parsed.message === "string"
    ) {
        return { type: "error", message: parsed.message };
    }
    throw new Error("Server sent an invalid log event");
}

/** Owns one reconnecting route-scoped log socket and a bounded browser rolling window. */
export function LogViewer(props: {
    title: string;
    sourceLabel: string;
    websocketUrl: string;
    headerActions?: React.ReactNode;
}) {
    const [entries, setEntries] = React.useState<LogEntry[]>([]);
    const [autoScroll, setAutoScroll] = React.useState(true);
    const [fileLoggingEnabled, setFileLoggingEnabled] = React.useState<
        boolean | null
    >(null);
    const [connectionState, setConnectionState] =
        React.useState<ConnectionState>("connecting");
    const [statusMessage, setStatusMessage] = React.useState<string | null>(
        null,
    );
    const nextEntryId = React.useRef(0);
    const logContainerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        let active = true;
        let hasConnected = false;
        let socket: WebSocket | null = null;
        let reconnectTimer: number | null = null;

        /** Allocates stable local keys because identical logger text can validly render twice. */
        const createEntry = (text: string): LogEntry => {
            const entry = { id: nextEntryId.current, text };
            nextEntryId.current += 1;
            return entry;
        };

        /** Schedules at most one reconnect so close and error events cannot multiply sockets. */
        const scheduleReconnect = () => {
            if (!active || reconnectTimer !== null) {
                return;
            }
            setConnectionState("reconnecting");
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, 1000);
        };

        /** Opens a fresh socket whose first snapshot replaces anything missed while disconnected. */
        const connect = () => {
            if (!active) {
                return;
            }
            setConnectionState(hasConnected ? "reconnecting" : "connecting");
            const nextSocket = new WebSocket(props.websocketUrl);
            socket = nextSocket;

            nextSocket.addEventListener("message", (event) => {
                if (
                    !active ||
                    socket !== nextSocket ||
                    typeof event.data !== "string"
                ) {
                    return;
                }
                try {
                    const message = parseLogEvent(event.data);
                    switch (message.type) {
                        case "snapshot":
                            setEntries(
                                message.entries
                                    .slice(-MAX_LOG_ENTRIES)
                                    .map(createEntry),
                            );
                            setFileLoggingEnabled(message.file_logging_enabled);
                            setStatusMessage(null);
                            setConnectionState("connected");
                            hasConnected = true;
                            break;
                        case "entry":
                            setEntries((current) =>
                                [...current, createEntry(message.entry)].slice(
                                    -MAX_LOG_ENTRIES,
                                ),
                            );
                            break;
                        case "lagged":
                            setStatusMessage(
                                "Live logs fell behind; reconnecting…",
                            );
                            nextSocket.close();
                            break;
                        case "error":
                            setStatusMessage(message.message);
                            nextSocket.close();
                            break;
                    }
                } catch {
                    setStatusMessage(
                        "The server sent an invalid log event; reconnecting…",
                    );
                    nextSocket.close();
                }
            });
            nextSocket.addEventListener("error", () => {
                if (!active || socket !== nextSocket) {
                    return;
                }
                setStatusMessage("Log connection failed; reconnecting…");
                nextSocket.close();
            });
            nextSocket.addEventListener("close", () => {
                if (socket !== nextSocket) {
                    return;
                }
                socket = null;
                scheduleReconnect();
            });
        };

        connect();
        return () => {
            active = false;
            if (reconnectTimer !== null) {
                window.clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            const activeSocket = socket;
            socket = null;
            activeSocket?.close();
        };
    }, [props.websocketUrl]);

    React.useLayoutEffect(() => {
        if (!autoScroll) {
            return;
        }
        const container = logContainerRef.current;
        if (!container) {
            return;
        }
        container.scrollTop = container.scrollHeight;
    }, [autoScroll, entries]);

    const connectionLabel =
        connectionState === "connected"
            ? "Live"
            : connectionState === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…";

    return (
        <div className="flex h-full min-h-0 flex-col p-8">
            <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <ScrollText
                            className="h-6 w-6 text-blue-400"
                            aria-hidden="true"
                        />
                        <h1 className="text-2xl font-bold text-slate-100">
                            {props.title}
                        </h1>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        {props.headerActions}
                        <label className="flex items-center gap-2 text-sm text-slate-300">
                            <input
                                type="checkbox"
                                checked={autoScroll}
                                onChange={(event) =>
                                    setAutoScroll(event.currentTarget.checked)
                                }
                            />
                            Auto-scroll
                        </label>
                    </div>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
                    <span
                        role="status"
                        aria-label={`${props.sourceLabel} log connection status`}
                    >
                        {connectionLabel}
                    </span>
                    {statusMessage ? (
                        <span role="status">{statusMessage}</span>
                    ) : null}
                    {fileLoggingEnabled === false ? (
                        <span role="status">
                            History is unavailable because file logging is
                            disabled. New in-process logs still appear live.
                        </span>
                    ) : null}
                </div>
                <div
                    ref={logContainerRef}
                    role="log"
                    aria-label={`${props.sourceLabel} log entries`}
                    aria-live="off"
                    className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-800 bg-[#080a0e] p-4 font-mono text-xs leading-5 text-slate-300"
                >
                    {entries.map((entry) => (
                        <div
                            key={entry.id}
                            className="whitespace-pre-wrap wrap-break-word"
                        >
                            {entry.text}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
