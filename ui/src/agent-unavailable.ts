import { useEffect } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";

import type { Agent } from "#ui/api-client";

/**
 * Thrown by a device route's loader while the agent cannot serve paths. The offline state
 * is a router error rather than loader data, because the router reloads a failed match on
 * every load, blocking like a fresh navigation. Loader data saying "offline" would instead
 * stay on screen after the agent connects until something reloaded it, and a redirect from
 * that reload kept it there. It carries the URL's location, so the shell still knows which
 * path the offline page is waiting to open.
 */
export class AgentUnavailableError extends Error {
    constructor(
        readonly agentId: string,
        readonly path: string,
    ) {
        super("The agent is not connected");
        this.name = "AgentUnavailableError";
    }
}

/**
 * Reloads the routes that failed because this agent was not connected, once it is. It
 * lives in the device layout rather than in the error view: reloading resets the route's
 * error boundary, which remounts the error view, so a trigger there would reload forever.
 * Both conditions are watched, so a loader that finished offline just after the agent
 * connected is still reloaded.
 */
export function useReloadUnavailableRoutes(agent: Agent | undefined) {
    const router = useRouter();
    const agentId = agent?.id;
    const isAvailable = agent?.status === "connected" && agent.cwd !== null;

    const hasUnavailableMatch = useRouterState({
        select: (state) =>
            state.matches.some(
                (match) =>
                    match.error instanceof AgentUnavailableError &&
                    match.error.agentId === agentId,
            ),
    });

    useEffect(() => {
        if (!isAvailable || !hasUnavailableMatch) {
            return;
        }

        void router.invalidate({
            filter: (match) =>
                match.error instanceof AgentUnavailableError &&
                match.error.agentId === agentId,
        });
    }, [agentId, hasUnavailableMatch, isAvailable, router]);
}
