import { onTestFinished } from "vitest";

import type { Agent } from "#ui/api-client";
import { ApiError } from "#ui/api-transport";
import type { SystemdJournalEvent } from "#bindings/SystemdJournalEvent";
import type { SystemdScope } from "#bindings/SystemdScope";

/** HTTP status and error code of an API call; 200 and no code when it succeeded. */
export type Failure = { status: number; code: string | null };

/**
 * Resolves to the HTTP status and code of a failed API call, or 200 when it succeeded, so
 * systemd tests can assert the typed failures the UI branches on.
 */
export async function failureOf(call: Promise<unknown>): Promise<Failure> {
    try {
        await call;

        return { status: 200, code: null };
    } catch (error) {
        if (error instanceof ApiError) {
            return { status: error.status, code: error.code };
        }

        throw error;
    }
}

/**
 * Opens a unit's journal stream that collects every event in the background until the test
 * finishes, so tests can act on the unit while the stream stays open and then check that
 * live lines arrived on the same stream.
 */
export function openSystemdJournal(options: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    lines?: number;
}) {
    const controller = new AbortController();
    const events: SystemdJournalEvent[] = [];
    let failure: Error | null = null;

    const reading = (async () => {
        try {
            for await (const batch of options.agent.streamSystemdJournal(
                options.scope,
                options.unit,
                { lines: options.lines, signal: controller.signal },
            )) {
                events.push(...batch);
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                failure =
                    error instanceof Error ? error : new Error(String(error));
            }
        }
    })();

    const close = async () => {
        controller.abort();
        await reading;

        if (failure !== null) {
            throw failure;
        }
    };

    onTestFinished(close);

    return { events, close };
}

/** Entry messages of a journal stream, in arrival order. */
export function journalMessages(events: SystemdJournalEvent[]): string[] {
    return events.flatMap((event) =>
        event.type === "entry" ? [event.entry.message] : [],
    );
}
