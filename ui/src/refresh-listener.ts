import type { AnyRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { type ApiClient, type UiEvent } from "#ui/api-client";
import { queryKeys } from "#ui/queries";

const uiEventSchema: z.ZodType<UiEvent> = z.object({
    type: z.union([
        z.literal("agents_changed"),
        z.literal("routes_changed"),
        z.literal("transfers_changed"),
    ]),
});

/** Keeps query and route data synchronized with domain-specific server events. */
export class RefreshListener {
    private reconnectTimer: number | null = null;
    private websocket: WebSocket | null = null;
    private invalidateInFlight: Promise<void> | null = null;
    private invalidateQueued = false;
    private unsubscribeFromResolved: (() => void) | null = null;
    private started = false;

    constructor(
        private api: ApiClient,
        private router: AnyRouter,
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
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.websocket?.close();
        this.websocket = null;
        this.unsubscribeFromResolved?.();
        this.unsubscribeFromResolved = null;
        this.invalidateInFlight = null;
        this.invalidateQueued = false;
    }

    /** Serializes route reloads so server events do not interrupt navigation. */
    private runInvalidate() {
        if (!this.started) return;
        if (this.invalidateInFlight) {
            this.invalidateQueued = true;
            return;
        }
        if (this.router.state.status === "pending") {
            this.invalidateQueued = true;
            if (!this.unsubscribeFromResolved) {
                const unsubscribe = this.router.subscribe("onResolved", () => {
                    unsubscribe();
                    this.unsubscribeFromResolved = null;
                    if (this.invalidateQueued && this.started) {
                        // Let navigation commit before refreshing its destination loaders.
                        this.invalidateQueued = false;
                        this.runInvalidate();
                    }
                });
                this.unsubscribeFromResolved = unsubscribe;
            }
            return;
        }

        this.invalidateInFlight = this.router
            .invalidate()
            .catch(() => {})
            .then(
                () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
            )
            .finally(() => {
                this.invalidateInFlight = null;
                if (this.invalidateQueued && this.started) {
                    // Drain one follow-up pass for events received during the reload.
                    this.invalidateQueued = false;
                    this.runInvalidate();
                }
            });
    }

    /** Connects to the event stream and scopes each event to affected data. */
    private connect() {
        if (!this.started) return;
        this.websocket = new WebSocket(this.api.getUiWebSocketUrl());
        this.websocket.addEventListener("message", (event) => {
            const frame = z.string().safeParse(event.data);
            if (!frame.success) return;

            let message: UiEvent;
            try {
                message = uiEventSchema.parse(JSON.parse(frame.data));
            } catch {
                return;
            }

            if (message.type === "transfers_changed") {
                void this.queryClient.invalidateQueries({
                    queryKey: queryKeys.transfers(),
                });
                return;
            }
            if (message.type === "routes_changed") {
                this.runInvalidate();
                return;
            }
            void this.queryClient
                .invalidateQueries({
                    queryKey: queryKeys.agents(),
                    refetchType: "none",
                })
                .then(() => this.runInvalidate());
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
