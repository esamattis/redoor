import { useMatches } from "@tanstack/react-router";

import type { Agent } from "#ui/api-client";
import { useDisplayedAgentId } from "#ui/use-active-agent";
import { useAgents } from "#ui/use-agents";
import { useBrowserLocation } from "#ui/use-browser-location";

/** Names the agent representation on screen, which decides the top bar's view navigation. */
export type AgentViewContext =
    | { kind: "agent"; agent: Agent }
    | { kind: "logs"; agent: Agent }
    | { kind: "configuration"; agent: Agent }
    | { kind: "trash"; agent: Agent }
    | { kind: "systemd"; agent: Agent }
    | { kind: "directory"; agent: Agent; path: string }
    | { kind: "file"; agent: Agent; path: string }
    | null;

/**
 * Derives the contextual view navigation from the matched leaf route and already loaded
 * data. Route ids replace pathname comparisons, so renaming a URL cannot silently break it.
 */
export function useAgentViewContext(): AgentViewContext {
    const agents = useAgents();
    const displayedAgentId = useDisplayedAgentId();
    const browser = useBrowserLocation();

    const leafRouteId = useMatches({
        select: (matches) => matches.at(-1)?.routeId,
    });

    // A revision page is a filesystem view even when its path is not on disk or did not
    // resolve at the revision, so it keeps the device tabs with Files active.
    const browserEntry =
        browser?.entry ??
        (browser?.revision ? (browser.revision.entry ?? "directory") : null);

    if (browser && browserEntry) {
        const browserAgent = agents.find(
            (agent) => agent.id === browser.agentId,
        );

        if (browserAgent) {
            return {
                kind: browserEntry,
                agent: browserAgent,
                path: browser.path,
            };
        }
    }

    const activeAgent = agents.find((agent) => agent.id === displayedAgentId);

    if (!activeAgent) {
        return null;
    }

    switch (leafRouteId) {
        case "/_app/agents/$deviceName/":
            return { kind: "agent", agent: activeAgent };
        case "/_app/agents/$deviceName/edit":
            return activeAgent.configurationEditable
                ? { kind: "configuration", agent: activeAgent }
                : null;
        case "/_app/agents/$deviceName/logs":
            return isBrowsable(activeAgent)
                ? { kind: "logs", agent: activeAgent }
                : null;
        case "/_app/agents/$deviceName/trash":
            return isBrowsable(activeAgent)
                ? { kind: "trash", agent: activeAgent }
                : null;
        default:
            // Every systemd page, including disconnected and unsupported explanations, keeps
            // the device tabs, so the reader can always switch back to the other views.
            return leafRouteId?.startsWith("/_app/agents/$deviceName/systemd")
                ? { kind: "systemd", agent: activeAgent }
                : null;
    }
}

/** Logs and trash only exist for a connected agent that has resolved its home directory. */
function isBrowsable(agent: Agent): boolean {
    return agent.status === "connected" && agent.cwd !== null;
}
