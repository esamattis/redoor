import * as React from "react";
import { ScrollText } from "lucide-react";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    Level,
    LogEntry,
    LogEvent,
    LoggingLevelResponse,
} from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { Select } from "#ui/components/select";
import { Toast } from "#ui/components/toast";

type ConnectionState = "connecting" | "connected" | "reconnecting";
type ViewerEntry = { id: number; record: LogEntry };
type LoggingLevelControlConfig = {
    queryKey: readonly unknown[];
    load: () => Promise<LoggingLevelResponse>;
    update: (level: Level) => Promise<LoggingLevelResponse>;
};

const MAX_LOG_ENTRIES = 1000;
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
    config: LoggingLevelControlConfig;
}) {
    const queryClient = useQueryClient();
    const levelQuery = useQuery({
        queryKey: props.config.queryKey,
        queryFn: props.config.load,
    });
    const [feedback, setFeedback] = React.useState<{
        tone: "success" | "error";
        message: string;
    } | null>(null);
    const mutation = useMutation({
        mutationFn: props.config.update,
        onSuccess: (response) => {
            queryClient.setQueryData(props.config.queryKey, response);
            setFeedback({
                tone: "success",
                message: `${props.sourceLabel} logging level changed to ${response.level}.`,
            });
        },
        onError: (error) => {
            void queryClient.invalidateQueries({
                queryKey: props.config.queryKey,
            });
            setFeedback({
                tone: "error",
                message: `Could not change ${props.sourceLabel} logging level: ${error.message}`,
            });
        },
    });

    return (
        <>
            <label className="flex items-center gap-2 text-sm text-slate-400">
                Level
                <Select
                    aria-label={`${props.sourceLabel} logging level`}
                    value={levelQuery.data?.level ?? ""}
                    disabled={levelQuery.isPending || mutation.isPending}
                    onChange={(event) => {
                        const level = LOGGING_LEVELS.find(
                            (candidate) =>
                                candidate.value === event.target.value,
                        );
                        if (level) {
                            mutation.mutate(level.value);
                        }
                    }}
                    className="h-9 min-w-28 py-1.5 text-sm"
                >
                    {LOGGING_LEVELS.map((level) => (
                        <option key={level.value} value={level.value}>
                            {level.label}
                        </option>
                    ))}
                </Select>
            </label>
            {feedback ? (
                <Toast tone={feedback.tone} onDismiss={() => setFeedback(null)}>
                    {feedback.message}
                </Toast>
            ) : null}
        </>
    );
}

/** Groups independent viewer controls so the socket-owning component stays focused. */
function LogViewerControls(props: {
    sourceLabel: string;
    headerActions?: React.ReactNode;
    loggingLevelControl: LoggingLevelControlConfig;
    autoScroll: boolean;
    wrapLines: boolean;
    onAutoScrollChange: (checked: boolean) => void;
    onWrapLinesChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            {props.headerActions}
            <LoggingLevelControl
                sourceLabel={props.sourceLabel}
                config={props.loggingLevelControl}
            />
            <Checkbox
                checked={props.autoScroll}
                role="checkbox"
                onCheckedChange={props.onAutoScrollChange}
            >
                Auto-scroll
            </Checkbox>
            <Checkbox
                checked={props.wrapLines}
                role="checkbox"
                onCheckedChange={props.onWrapLinesChange}
            >
                Wrap lines
            </Checkbox>
        </div>
    );
}

const logEntrySchema = z.object({
    timestamp: z.string().datetime({ offset: true }),
    level: z.enum(["trace", "debug", "info", "warning", "error"]),
    message: z.string(),
    error: z
        .object({ chain: z.string(), backtrace: z.string().nullable() })
        .nullable(),
});

const logEventSchema: z.ZodType<LogEvent> = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("snapshot"),
        entries: z.array(logEntrySchema),
        file_logging_enabled: z.boolean(),
    }),
    z.object({ type: z.literal("entry"), entry: logEntrySchema }),
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

/** Gives severity a visible and screen-reader-friendly label independent from message text. */
function Severity(props: { level: Level }) {
    const label =
        props.level === "warning"
            ? "Warning"
            : `${props.level.charAt(0).toUpperCase()}${props.level.slice(1)}`;
    const tone =
        props.level === "error"
            ? "text-red-300"
            : props.level === "warning"
              ? "text-amber-300"
              : props.level === "debug" || props.level === "trace"
                ? "text-slate-500"
                : "text-blue-300";
    return (
        <span
            className={`font-semibold ${tone}`}
            aria-label={`Severity: ${label}`}
        >
            {label.toUpperCase()}
        </span>
    );
}

/** Discloses bounded failure diagnostics in separate copyable sections. */
function ErrorDetailsDialog(props: {
    entry: LogEntry | null;
    sourceLabel: string;
    onClose: () => void;
}) {
    return (
        <Dialog
            isOpen={props.entry !== null}
            title="Error details"
            description={props.entry?.message ?? ""}
            closeAriaLabel="Close error details"
            size="wide"
            onClose={props.onClose}
        >
            {props.entry?.error ? (
                <div className="mt-5 grid gap-4">
                    <dl className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-sm sm:grid-cols-[auto_1fr]">
                        <dt className="font-semibold text-slate-400">Source</dt>
                        <dd className="text-slate-200">{props.sourceLabel}</dd>
                        <dt className="font-semibold text-slate-400">
                            Timestamp
                        </dt>
                        <dd>
                            <time dateTime={props.entry.timestamp}>
                                {props.entry.timestamp}
                            </time>
                        </dd>
                    </dl>
                    <CopyableCodeRow
                        label="Error chain"
                        value={props.entry.error.chain}
                        multiline
                    />
                    {props.entry.error.backtrace ? (
                        <CopyableCodeRow
                            label="Backtrace"
                            value={props.entry.error.backtrace}
                            multiline
                        />
                    ) : (
                        <section
                            aria-labelledby="backtrace-heading"
                            className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"
                        >
                            <h3
                                id="backtrace-heading"
                                className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-500"
                            >
                                Backtrace
                            </h3>
                            <p className="mt-2 text-sm text-slate-400">
                                Backtrace unavailable
                            </p>
                        </section>
                    )}
                </div>
            ) : null}
        </Dialog>
    );
}

/** Renders structured fields while making only diagnostic errors interactive. */
function LogRecordRow(props: {
    entry: ViewerEntry;
    wrapLines: boolean;
    onOpenError: (entry: LogEntry, trigger: HTMLButtonElement) => void;
}) {
    const content = (
        <>
            <time
                dateTime={props.entry.record.timestamp}
                className="text-slate-500 sm:shrink-0"
            >
                {props.entry.record.timestamp}
            </time>
            <Severity level={props.entry.record.level} />
            <span
                className={
                    props.wrapLines
                        ? "min-w-0 whitespace-pre-wrap wrap-break-word"
                        : "whitespace-pre"
                }
            >
                {props.entry.record.message}
            </span>
        </>
    );
    if (props.entry.record.level === "error" && props.entry.record.error) {
        return (
            <Button
                type="button"
                variant="subtle"
                size="sm"
                aria-label={`Open error details: ${props.entry.record.message}`}
                onClick={(event) =>
                    props.onOpenError(props.entry.record, event.currentTarget)
                }
                className="flex w-full flex-col items-start justify-start gap-x-3 gap-y-0 rounded px-2 py-1 text-left text-red-200 hover:bg-red-950/40 focus-visible:outline-2 focus-visible:outline-red-400 sm:flex-row"
            >
                {content}
            </Button>
        );
    }
    return (
        <div
            className={`flex flex-col gap-x-3 gap-y-0 px-2 py-1 sm:flex-row ${props.entry.record.level === "warning" ? "text-amber-100" : ""}`}
        >
            {content}
        </div>
    );
}

/** Owns diagnostic selection and focus restoration independently from socket lifecycle. */
function useErrorDetailsSelection() {
    const [selected, setSelected] = React.useState<LogEntry | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const open = React.useCallback(
        (entry: LogEntry, trigger: HTMLButtonElement) => {
            triggerRef.current = trigger;
            setSelected(entry);
        },
        [],
    );
    const close = React.useCallback(() => {
        setSelected(null);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
    }, []);
    return { selected, open, close };
}

/** Owns one reconnecting route-scoped log socket and a bounded browser rolling window. */
export function LogViewer(props: {
    title: string;
    sourceLabel: string;
    websocketUrl: string;
    headerActions?: React.ReactNode;
    loggingLevelControl: LoggingLevelControlConfig;
}) {
    const [entries, setEntries] = React.useState<ViewerEntry[]>([]);
    const errorDetails = useErrorDetailsSelection();
    const [autoScroll, setAutoScroll] = React.useState(true);
    const [wrapLines, setWrapLines] = React.useState(true);
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
        const createEntry = (record: LogEntry): ViewerEntry => {
            const entry = { id: nextEntryId.current, record };
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
                    <LogViewerControls
                        sourceLabel={props.sourceLabel}
                        headerActions={props.headerActions}
                        loggingLevelControl={props.loggingLevelControl}
                        autoScroll={autoScroll}
                        wrapLines={wrapLines}
                        onAutoScrollChange={setAutoScroll}
                        onWrapLinesChange={setWrapLines}
                    />
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
                            Persistent output is disabled. The latest 1,000
                            in-process records remain available for replay.
                        </span>
                    ) : null}
                </div>
                <div
                    ref={logContainerRef}
                    role="log"
                    aria-label={`${props.sourceLabel} log entries`}
                    aria-live="off"
                    className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-800 bg-[#080a0e] p-4 font-mono text-xs leading-5 text-slate-300"
                >
                    {entries.map((entry) => (
                        <LogRecordRow
                            key={entry.id}
                            entry={entry}
                            wrapLines={wrapLines}
                            onOpenError={errorDetails.open}
                        />
                    ))}
                </div>
            </div>
            <ErrorDetailsDialog
                entry={errorDetails.selected}
                sourceLabel={props.sourceLabel}
                onClose={errorDetails.close}
            />
        </div>
    );
}
