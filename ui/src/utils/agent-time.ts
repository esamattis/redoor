import * as React from "react";
import type { AgentConnectionStatus } from "#bindings/AgentConnectionStatus";

/** Formats compact elapsed time while keeping second-level startup feedback useful. */
export function formatElapsed(totalSeconds: number): string {
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

/** Accepts leftover second stamps from older localStorage without mis-scaling them. */
function provisioningStampMs(at: number): number {
    return at < 1_000_000_000_000 ? at * 1000 : at;
}

/** Formats provisioning deltas as whole seconds plus leftover milliseconds. */
export function formatElapsedSecsMs(totalMs: number): string {
    const ms = Math.max(0, Math.floor(totalMs));
    const seconds = Math.floor(ms / 1000);
    const remainder = ms % 1000;
    return `${seconds}s ${String(remainder).padStart(3, "0")}ms`;
}

/** Puts the gap from the previous stamp in the tooltip so the visible label can stay cumulative. */
export function provisioningElapsedTooltip(
    sincePrevious: string,
    index: number,
    total: number,
): string {
    if (index === 0 && total <= 1) {
        return `${sincePrevious} since this attempt started.`;
    }
    if (index === 0) {
        return `${sincePrevious} until the next step.`;
    }
    return `${sincePrevious} after the previous step.`;
}

/** Time from the first step to this row, ticking on the latest row. */
export function provisioningElapsedFromStartMs(options: {
    messages: Array<{ at: number }>;
    index: number;
    nowMs: number;
}): number {
    const first = options.messages[0];
    const current = options.messages[options.index];
    if (first === undefined || current === undefined) {
        return 0;
    }
    const endMs =
        options.index === options.messages.length - 1
            ? options.nowMs
            : provisioningStampMs(current.at);
    return Math.max(0, endMs - provisioningStampMs(first.at));
}

/** Gap from the previous stamp, or how long the first step stayed current. */
export function provisioningStepElapsedMs(options: {
    messages: Array<{ at: number }>;
    index: number;
    nowMs: number;
}): number {
    const current = options.messages[options.index];
    if (current === undefined) {
        return 0;
    }
    const previous = options.messages[options.index - 1];
    if (previous !== undefined) {
        return Math.max(
            0,
            provisioningStampMs(current.at) - provisioningStampMs(previous.at),
        );
    }
    const next = options.messages[options.index + 1];
    const endMs =
        next === undefined ? options.nowMs : provisioningStampMs(next.at);
    return Math.max(0, endMs - provisioningStampMs(current.at));
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
