import * as React from "react";
import { Info, RotateCcw } from "lucide-react";

import type { SystemdJournalEntry } from "#bindings/SystemdJournalEntry";
import type { SystemdJournalEvent } from "#bindings/SystemdJournalEvent";
import type { SystemdScope } from "#bindings/SystemdScope";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { systemdScopeKey } from "#ui/systemd-queries";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";

/** Lines of history the journal starts with before following new ones. */
const JOURNAL_HISTORY_LINES = 200;

/**
 * Entries kept in memory. The journal follows a unit for as long as the page is open, and a
 * chatty service would otherwise grow the page without bound.
 */
const MAX_JOURNAL_ENTRIES = 5000;

/** How close to the bottom, in pixels, still counts as reading the newest lines. */
const BOTTOM_SLACK_PX = 24;

type JournalRow = { id: number; entry: SystemdJournalEntry };

/**
 * Where the stream is: following, or stopped with or without a reason. Opening counts as
 * following, since a unit without history sends nothing until it logs, and a refused request
 * fails within moments.
 */
type JournalStatus =
    | { kind: "live" }
    | { kind: "ended"; message: string | null }
    | { kind: "failed"; message: string };

type JournalState = {
    rows: JournalRow[];
    accessLimited: string | null;
    status: JournalStatus;
};

const INITIAL_STATE: JournalState = {
    rows: [],
    accessLimited: null,
    status: { kind: "live" },
};

/**
 * Folds one batch of stream events into the view. Entries past the memory bound drop the
 * oldest first, since the newest lines are the ones being followed.
 */
function applyJournalBatch(
    state: JournalState,
    batch: SystemdJournalEvent[],
    nextId: () => number,
): JournalState {
    const added: JournalRow[] = [];
    let accessLimited = state.accessLimited;
    let status: JournalStatus = { kind: "live" };

    for (const event of batch) {
        switch (event.type) {
            case "entry":
                added.push({ id: nextId(), entry: event.entry });
                break;
            case "access_limited":
                accessLimited = event.message;
                break;
            case "end":
                status = { kind: "ended", message: event.message };
                break;
        }
    }

    const rows =
        added.length === 0
            ? state.rows
            : [...state.rows, ...added].slice(-MAX_JOURNAL_ENTRIES);

    return { rows, accessLimited, status };
}

/**
 * Follows one unit's journal for as long as the view is mounted. The stream is a browser
 * subscription like a socket, not a REST read, so it lives in an effect, and unmounting or
 * changing the unit aborts it, which stops `journalctl` on the device. `attempt` restarts it.
 */
function useSystemdJournal(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    attempt: number;
}): JournalState {
    const [state, setState] = React.useState<JournalState>(INITIAL_STATE);
    const agentId = props.agent.id;
    const scopeKey = systemdScopeKey(props.scope);
    const unit = props.unit;

    // The device and scope objects are rebuilt whenever unrelated device data changes, so the
    // stream is opened through an effect event and restarted only for another unit or retry.
    const openStream = React.useEffectEvent((signal: AbortSignal) =>
        props.agent.streamSystemdJournal(props.scope, unit, {
            lines: JOURNAL_HISTORY_LINES,
            signal,
        }),
    );

    React.useEffect(() => {
        const controller = new AbortController();
        let counter = 0;
        const nextId = () => ++counter;

        setState(INITIAL_STATE);

        /** Reads batches until the stream ends, fails or the view goes away. */
        const follow = async () => {
            try {
                for await (const batch of openStream(controller.signal)) {
                    setState((current) =>
                        applyJournalBatch(current, batch, nextId),
                    );
                }

                // The stream normally never ends; say so when it did without an `end` event.
                setState((current) =>
                    current.status.kind === "ended"
                        ? current
                        : {
                              ...current,
                              status: { kind: "ended", message: null },
                          },
                );
            } catch (error) {
                if (controller.signal.aborted) {
                    return;
                }

                setState((current) => ({
                    ...current,
                    status: {
                        kind: "failed",
                        message: getErrorMessage(
                            error,
                            "The journal could not be read",
                        ),
                    },
                }));
            }
        };

        void follow();

        return () => controller.abort();
    }, [agentId, scopeKey, unit, props.attempt]);

    return state;
}

/** Colours a line by its syslog priority, so errors and warnings stand out in a long log. */
function priorityTone(priority: number | null): string {
    if (priority === null) {
        return "text-slate-300";
    }

    if (priority <= 3) {
        return "text-red-300";
    }

    if (priority === 4) {
        return "text-amber-200";
    }

    if (priority === 5) {
        return "text-slate-100";
    }

    return priority >= 7 ? "text-slate-500" : "text-slate-300";
}

/** Names syslog priorities for assistive technology, which cannot see the colours. */
const PRIORITY_NAMES = [
    "emergency",
    "alert",
    "critical",
    "error",
    "warning",
    "notice",
    "info",
    "debug",
];

/** Formats journal time in the reader's locale, with seconds, since log lines come in bursts. */
const timeFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

/** One journal line: time, program and PID, then the message. */
function JournalLine(props: { entry: SystemdJournalEntry; wrap: boolean }) {
    const timestamp =
        props.entry.timestamp_us === null
            ? null
            : new Date(props.entry.timestamp_us / 1000);

    const source =
        props.entry.identifier === null
            ? null
            : props.entry.pid === null
              ? props.entry.identifier
              : `${props.entry.identifier}[${props.entry.pid}]`;

    const priorityName =
        props.entry.priority === null
            ? undefined
            : PRIORITY_NAMES[props.entry.priority];

    return (
        <div
            className={cn(
                "flex flex-col gap-x-3 px-2 py-0.5 font-mono text-[11px] leading-4 @xl:flex-row",
                priorityTone(props.entry.priority),
            )}
            data-priority={priorityName}
        >
            {timestamp ? (
                <time
                    dateTime={timestamp.toISOString()}
                    className="shrink-0 text-slate-500"
                >
                    {timeFormat.format(timestamp)}
                </time>
            ) : null}
            {source ? (
                <span className="shrink-0 text-sky-300/80">{source}</span>
            ) : null}
            {priorityName &&
            props.entry.priority !== null &&
            props.entry.priority <= 4 ? (
                <span className="sr-only">{priorityName}:</span>
            ) : null}
            <span
                className={
                    props.wrap
                        ? "min-w-0 whitespace-pre-wrap wrap-break-word"
                        : "whitespace-pre"
                }
            >
                {props.entry.message}
            </span>
        </div>
    );
}

/** Explains why the journal is incomplete or stopped, above or below the lines. */
function JournalNotice(props: {
    tone: "info" | "warning";
    children: React.ReactNode;
}) {
    return (
        <p
            role="status"
            className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                props.tone === "warning"
                    ? "border-amber-800/60 bg-amber-950/20 text-amber-200"
                    : "border-slate-800 bg-slate-900/40 text-slate-400",
            )}
        >
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 wrap-break-word">{props.children}</span>
        </p>
    );
}

/**
 * Shows a unit's journal: the last lines, then new ones as they are written. It keeps the
 * newest line in view while the reader is at the bottom and stops following when they
 * scroll up to read, so live lines never yank the page away from what is being read.
 */
export function SystemdJournal(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
}) {
    const [attempt, setAttempt] = React.useState(0);
    const [wrap, setWrap] = React.useState(true);

    const journal = useSystemdJournal({
        agent: props.agent,
        scope: props.scope,
        unit: props.unit,
        attempt,
    });

    const containerRef = React.useRef<HTMLDivElement>(null);
    const atBottomRef = React.useRef(true);

    React.useLayoutEffect(() => {
        const container = containerRef.current;

        if (container && atBottomRef.current) {
            container.scrollTop = container.scrollHeight;
        }
    }, [journal.rows, wrap]);

    /** Remembers whether the reader is at the bottom, which decides whether new lines scroll. */
    const trackScroll = (event: React.UIEvent<HTMLDivElement>) => {
        const container = event.currentTarget;

        atBottomRef.current =
            container.scrollHeight -
                container.scrollTop -
                container.clientHeight <=
            BOTTOM_SLACK_PX;
    };

    const status = journal.status;

    return (
        <section aria-label="Journal" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-100">Journal</h3>
                <div className="flex items-center gap-3 text-sm">
                    <span
                        className={
                            status.kind === "live"
                                ? "text-emerald-300"
                                : "text-slate-500"
                        }
                    >
                        {status.kind === "live" ? "Live" : "Stopped"}
                    </span>
                    <Checkbox
                        role="checkbox"
                        checked={wrap}
                        onCheckedChange={setWrap}
                    >
                        Wrap lines
                    </Checkbox>
                </div>
            </div>
            {journal.accessLimited ? (
                <JournalNotice tone="warning">
                    {journal.accessLimited}
                </JournalNotice>
            ) : null}
            <div
                ref={containerRef}
                role="log"
                aria-label={`${props.unit} journal`}
                aria-live="off"
                tabIndex={0}
                onScroll={trackScroll}
                // `relative` makes this the containing block of each line's sr-only label;
                // otherwise those absolute labels escape the clip and stretch the page.
                className="relative h-[min(32rem,65vh)] overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 py-1"
            >
                {journal.rows.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-slate-500">
                        No journal entries yet.
                    </p>
                ) : null}
                {journal.rows.map((row) => (
                    <JournalLine key={row.id} entry={row.entry} wrap={wrap} />
                ))}
            </div>
            {status.kind === "ended" || status.kind === "failed" ? (
                <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
                    <div className="min-w-0 flex-1">
                        <JournalNotice
                            tone={status.kind === "failed" ? "warning" : "info"}
                        >
                            {status.kind === "failed"
                                ? status.message
                                : status.message === null
                                  ? "The journal stopped following."
                                  : `The journal stopped following: ${status.message}`}
                        </JournalNotice>
                    </div>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        tooltip="Read the journal again and follow it"
                        onClick={() => setAttempt((current) => current + 1)}
                    >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        Follow again
                    </Button>
                </div>
            ) : null}
        </section>
    );
}
