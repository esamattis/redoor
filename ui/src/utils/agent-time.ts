import * as React from "react";
import type { AgentConnectionStatus } from "../../../bindings/AgentConnectionStatus";

/** Formats compact elapsed time while keeping second-level startup feedback useful. */
function formatElapsed(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainder = seconds % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${remainder}s`;
    return `${remainder}s`;
}

/** Groups the server timestamps needed to describe an agent's connection recency. */
type AgentRecency = {
    status: AgentConnectionStatus;
    connectedAt: number | null;
    lastSeenAt: number | null;
};

/** Describes current connection duration or retained last-seen recency. */
export function formatAgentRecency(agent: AgentRecency, nowMs: number): string {
    if (agent.status === "connected" && agent.connectedAt !== null) {
        return `Connected for ${formatElapsed(nowMs / 1000 - agent.connectedAt)}`;
    }
    if (agent.lastSeenAt !== null) {
        return `Last seen ${formatElapsed(nowMs / 1000 - agent.lastSeenAt)} ago`;
    }
    return "Never connected";
}

/** Updates labels locally so duration ticking does not create API traffic. */
export function useNow(intervalMs: number = 1000): number {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}
