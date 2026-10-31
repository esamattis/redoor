import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import { type ApiClient } from "#ui/api-client";
import type { UiEvent } from "#bindings/UiEvent";
import {
    invalidateAgentData,
    invalidateAllAgentData,
    queryKeys,
} from "#ui/queries";

const uiEventSchema: z.ZodType<UiEvent> = z.object({
    type: z.union([
        z.literal("agents_changed"),
        z.literal("routes_changed"),
        z.literal("transfers_changed"),
        z.literal("terminals_changed"),
    ]),
});

/**
 * Finds agents whose connection was replaced or ended between two inventory snapshots.
 * Everything cached from the old connection (details, listings, git state) may no longer
 * match what the new one reports, so those agents' data must be refreshed.
 */
export function agentsWithReplacedConnection(
    previous: AgentInfoResponse[],
    next: AgentInfoResponse[],
): string[] {
    return next.flatMap((agent) => {
        const before = previous.find((entry) => entry.id === agent.id);

        return before !== undefined &&
            (before.status !== agent.status ||
                before.connection_id !== agent.connection_id)
            ? [agent.id]
            : [];
    });
}

/**
 * Turns server hints into query invalidations. Events only say what kind of data changed,
 * so the cache is the single place where views learn about it: components and route
 * loaders read the same queries and need no separate reload signal.
 */
export class RefreshListener {
    private reconnectTimer: number | null = null;
    private websocket: WebSocket | null = null;
    private started = false;
    private hasConnected = false;

    constructor(
        private api: ApiClient,
        private queryClient: QueryClient,
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
            queryKeys.agents(),
            queryKeys.partials(),
            queryKeys.transfers(),
            queryKeys.terminalSessions(),
        ]) {
            void this.queryClient.invalidateQueries({ queryKey, exact: true });
        }

        void invalidateAllAgentData(this.queryClient);
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
        this.websocket.addEventListener("close", () => {
            this.websocket = null;

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
 * the login page never holds an event socket.
 */
export function useRefreshListener(api: ApiClient) {
    const queryClient = useQueryClient();

    React.useEffect(() => {
        const refreshListener = new RefreshListener(api, queryClient);
        refreshListener.start();

        return () => refreshListener.stop();
    }, [api, queryClient]);
}
