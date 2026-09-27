import type { Agent } from "#ui/api-client";

/** Shares home-chip lifecycle colors so connection state stays scannable in every agent list. */
export function AgentStatusDot(props: {
    agent: Pick<Agent, "status" | "connectionIssue">;
}) {
    return (
        <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(props.agent)}`}
            aria-hidden="true"
        />
    );
}

/** Red for a diagnostic, green only while connected, amber for every other lifecycle state. */
function statusDotClass(
    agent: Pick<Agent, "status" | "connectionIssue">,
): string {
    if (agent.connectionIssue) {
        return "bg-red-500";
    }
    if (agent.status === "connected") {
        return "bg-emerald-500";
    }
    return "bg-amber-400";
}
