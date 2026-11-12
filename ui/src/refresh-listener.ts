import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import { type ApiClient, SESSION_ENDED_CLOSE_CODE } from "#ui/api-client";
import type { UiEvent } from "#bindings/UiEvent";
import type { OpenPathKind } from "#bindings/OpenPathKind";
import type { VaultSession } from "#ui/vault/vault-session";
import {
    invalidateAgentData,
    invalidateAllAgentData,
    queryKeys,
} from "#ui/queries";

const openPathKindSchema: z.ZodType<OpenPathKind> = z.union([
    z.literal("file"),
    z.literal("directory"),
]);

const uiEventSchema: z.ZodType<UiEvent> = z.discriminatedUnion("type", [
    z.object({ type: z.literal("agents_changed") }),
    z.object({ type: z.literal("routes_changed") }),
    z.object({ type: z.literal("transfers_changed") }),
    z.object({ type: z.literal("terminals_changed") }),
    z.object({
        type: z.literal("open_path"),
        agent_id: z.string(),
        device_name: z.string(),
        path: z.string(),
        kind: openPathKindSchema,
    }),
]);

/** An `rd-open` request from a terminal: show `path` of a device in this window. */
export type OpenPathEvent = Extract<UiEvent, { type: "open_path" }>;

/**
 * Finds agents whose connection was replaced, ended or appeared between two inventory
 * snapshots. Everything cached from an old connection (details, listings, git state) may no
 * longer match what the new one reports, so those agents' data must be refreshed.
 *
 * An agent missing from the previous snapshot counts too: a restarted server lists a
 * standalone agent only once it reconnects, and views refetched while it was missing hold
 * errors until something refreshes them again.
 */
export function agentsWithReplacedConnection(
    previous: AgentInfoResponse[],
    next: AgentInfoResponse[],
): string[] {
    return next.flatMap((agent) => {
        const before = previous.find((entry) => entry.id === agent.id);

        return before === undefined ||
            before.status !== agent.status ||
            before.connection_id !== agent.connection_id
            ? [agent.id]
            : [];
    });
}

/**
 * Turns server hints into query invalidations. Events only say what kind of data changed,
 * so the cache is the single place where views learn about it: components and route
 * loaders read the same queries and need no separate reload signal. The one command among
 * them, `rd-open`, is handed to `onOpenPath`, because only the shell can navigate.
 */
export class RefreshListener {
    private reconnectTimer: number | null = null;
    private websocket: WebSocket | null = null;
    private started = false;
    private hasConnected = false;

    constructor(
        private api: ApiClient,
        private queryClient: QueryClient,
        private shell: {
            vault: Pick<VaultSession, "check">;
            onOpenPath: (event: OpenPathEvent) => void;
        },
    ) {}

    /** Starts the UI event connection once for the authenticated shell. */
    start() {
        if (this.started) return;
        this.started = true;
        this.connect();
    }

    /** Stops reconnects and releases the current UI event connection. */
    stop() {
        this.started = false;
        this.hasConnected = false;

        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.websocket?.close();
        this.websocket = null;
    }

    /**
     * Refetches the inventory, then refreshes the data of agents whose connection changed.
     * Comparing snapshots keeps lifecycle chatter, such as provisioning steps, from
     * refetching every open file view.
     */
    private async refreshAgents() {
        const previous = this.queryClient.getQueryData<AgentInfoResponse[]>(
            queryKeys.agents(),
        );

        await this.queryClient.invalidateQueries({
            queryKey: queryKeys.agents(),
            exact: true,
        });

        const next = this.queryClient.getQueryData<AgentInfoResponse[]>(
            queryKeys.agents(),
        );

        if (!previous || !next) return;

        await Promise.all(
            agentsWithReplacedConnection(previous, next).map((agentId) =>
                invalidateAgentData(this.queryClient, agentId),
            ),
        );
    }

    /** Applies one validated server hint to the data it announces. */
    private handleEvent(event: UiEvent) {
        if (event.type === "open_path") {
            this.shell.onOpenPath(event);

            return;
        }

        if (event.type === "transfers_changed") {
            void this.queryClient.invalidateQueries({
                queryKey: queryKeys.transfers(),
            });

            return;
        }

        if (event.type === "terminals_changed") {
            // Another window opened or closed a tab, or a shell exited.
            void this.queryClient.invalidateQueries({
                queryKey: queryKeys.terminalSessions(),
                exact: true,
            });

            return;
        }

        if (event.type === "routes_changed") {
            // Uploads and edits finished, which changes listings, metadata and git state.
            void invalidateAllAgentData(this.queryClient);

            return;
        }

        // A reconnected destination may bring back partials it kept while offline.
        void this.queryClient.invalidateQueries({
            queryKey: queryKeys.partials(),
        });
        void this.refreshAgents();
    }

    /**
     * Recovers from events missed while the socket was down, which nothing announces.
     * User state is left alone: it is written by this browser, not pushed by the server.
     */
    private refreshAfterReconnect() {
        for (const queryKey of [
            // A server restarted from the command line may run another build, which the
            // shell notices through the refreshed server info and reloads for.
            queryKeys.serverInfo(),
            queryKeys.agents(),
            queryKeys.partials(),
            queryKeys.transfers(),
            queryKeys.terminalSessions(),
        ]) {
            void this.queryClient.invalidateQueries({ queryKey, exact: true });
        }

        void invalidateAllAgentData(this.queryClient);
        // A server restart forgets every vault device secret, so tabs holding keys must lock.
        void this.shell.vault.check();
    }

    /** Connects to the event stream and scopes each event to affected data. */
    private connect() {
        if (!this.started) return;
        this.websocket = new WebSocket(this.api.getUiWebSocketUrl());
        this.websocket.addEventListener("open", () => {
            if (this.hasConnected) {
                this.refreshAfterReconnect();
            }

            this.hasConnected = true;
        });
        this.websocket.addEventListener("message", (event) => {
            const frame = z.string().safeParse(event.data);

            if (!frame.success) return;

            let message: UiEvent;

            try {
                message = uiEventSchema.parse(JSON.parse(frame.data));
            } catch {
                return;
            }

            this.handleEvent(message);
        });
        this.websocket.addEventListener("error", () => {
            this.websocket?.close();
        });
        this.websocket.addEventListener("close", (event) => {
            this.websocket = null;

            // The session ended; reconnecting would only be refused again.
            if (event.code === SESSION_ENDED_CLOSE_CODE) {
                this.api.notifySessionEnded();

                return;
            }

            if (this.started) {
                this.reconnectTimer = window.setTimeout(() => {
                    this.reconnectTimer = null;
                    this.connect();
                }, 1000);
            }
        });
    }
}

/**
 * Ties the UI event connection to the authenticated shell: it opens when the shell mounts,
 * after the loaders have proven the session valid, and closes when the shell unmounts, so
 * the login page never holds an event socket. `onOpenPath` may change on every render
 * without reconnecting.
 */
export function useRefreshListener(
    api: ApiClient,
    vault: Pick<VaultSession, "check">,
    onOpenPath: (event: OpenPathEvent) => void,
) {
    const queryClient = useQueryClient();
    const openPath = React.useEffectEvent(onOpenPath);

    React.useEffect(() => {
        const refreshListener = new RefreshListener(api, queryClient, {
            vault,
            onOpenPath: (event) => openPath(event),
        });

        refreshListener.start();

        return () => refreshListener.stop();
    }, [api, queryClient, vault]);
}
