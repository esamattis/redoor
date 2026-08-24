import * as React from "react";
import { ScrollText } from "lucide-react";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Level, LogEvent, LoggingLevelResponse } from "#ui/api-client";
import { Checkbox } from "#ui/components/checkbox";
import { ToggleButton } from "#ui/components/toggle-button";
import { Toast } from "#ui/components/toast";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type LogEntry = { id: number; text: string };

const MAX_LOG_ENTRIES = 500;
const LOGGING_LEVELS: { value: Level; label: string }[] = [
    { value: "trace", label: "Trace" },
    { value: "debug", label: "Debug" },
    { value: "info", label: "Info" },
    { value: "warning", label: "Warning" },
    { value: "error", label: "Error" },
];

/** Keeps confirmed query state authoritative when a runtime update is rejected. */
function LoggingLevelControl(props: {
    sourceLabel: string;
    queryKey: readonly unknown[];
    load: () => Promise<LoggingLevelResponse>;
    update: (level: Level) => Promise<LoggingLevelResponse>;
}) {
    const queryClient = useQueryClient();
    const levelQuery = useQuery({
        queryKey: props.queryKey,
        queryFn: props.load,
    });
    const [feedback, setFeedback] = React.useState<{
        tone: "success" | "error";
        message: string;
    } | null>(null);
    const mutation = useMutation({
        mutationFn: props.update,
        onSuccess: (response) => {
            queryClient.setQueryData(props.queryKey, response);
            setFeedback({
                tone: "success",
                message: `${props.sourceLabel} logging level changed to ${response.level}.`,
            });
        },
        onError: (error) => {
            void queryClient.invalidateQueries({ queryKey: props.queryKey });
            setFeedback({
                tone: "error",
                message: `Could not change ${props.sourceLabel} logging level: ${error.message}`,
            });
        },
    });

    return (
        <>
            <div
                role="group"
                aria-label={`${props.sourceLabel} logging level`}
                className="flex items-center gap-1"
            >
                <span className="mr-1 text-sm text-slate-400">Level</span>
                {LOGGING_LEVELS.map((level) => (
                    <ToggleButton
                        key={level.value}
                        size="sm"
                        pressed={levelQuery.data?.level === level.value}
                        label={`${level.label} logging`}
                        tooltip={`Emit ${level.label.toLowerCase()} and more severe logs`}
                        disabled={levelQuery.isPending || mutation.isPending}
                        onClick={() => mutation.mutate(level.value)}
                    >
                        {level.label}
                    </ToggleButton>
                ))}
            </div>
            {feedback ? (
                <Toast tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                    {feedback.message}
                </Toast>
            ) : null}
        </>
    );
}

const logEventSchema: z.ZodType<LogEvent> = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("snapshot"),
        entries: z.array(z.string()),
        file_logging_enabled: z.boolean(),
    }),
    z.object({ type: z.literal("entry"), entry: z.string() }),
    z.object({ type: z.literal("lagged"), skipped: z.number() }),
    z.object({ type: z.literal("error"), message: z.string() }),
]);

/** Rejects structurally invalid payloads before they can corrupt the displayed rolling window. */
function parseLogEvent(data: string): LogEvent {
    return logEventSchema.parse(JSON.parse(data));
}

/** Gives every connection phase a concise operator-facing label. */
function connectionStateLabel(state: ConnectionState): string {
    if (state === "connected") {
        return "Live";
    }
    return state === "reconnecting" ? "Reconnecting…" : "Connecting…";
}

/** Owns one reconnecting route-scoped log socket and a bounded browser rolling window. */
export function LogViewer(props: {
    title: string;
    sourceLabel: string;
    websocketUrl: string;
    headerActions?: React.ReactNode;
    loggingLevelControl: {
        queryKey: readonly unknown[];
        load: () => Promise<LoggingLevelResponse>;
        update: (level: Level) => Promise<LoggingLevelResponse>;
    };
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
                if (!active || socket !== nextSocket) {
                    return;
                }
                try {
                    const frame = z.string().parse(event.data);
                    const message = parseLogEvent(frame);
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
                        <LoggingLevelControl
                            sourceLabel={props.sourceLabel}
                            queryKey={props.loggingLevelControl.queryKey}
                            load={props.loggingLevelControl.load}
                            update={props.loggingLevelControl.update}
                        />
                        <Checkbox
                            checked={autoScroll}
                            role="checkbox"
                            onCheckedChange={setAutoScroll}
                        >
                            Auto-scroll
                        </Checkbox>
                    </div>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
                    <span
                        role="status"
                        aria-label={`${props.sourceLabel} log connection status`}
                    >
                        {connectionStateLabel(connectionState)}
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
