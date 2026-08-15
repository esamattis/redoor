import { createFileRoute, Outlet } from "@tanstack/react-router";

import { RouteError } from "#ui/components/route-error";

export const Route = createFileRoute("/agents/$agentId")({
    loader: async ({ params, parentMatchPromise }) => {
        const rootMatch = await parentMatchPromise;
        const agents = rootMatch.loaderData?.agents ?? [];
        const agent = agents.find((entry) => entry.id === params.agentId);
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
        if (agent.status !== "connected") {
            return { kind: "lifecycle" as const, agent, agents };
        }
        return {
            kind: "connected" as const,
            agent,
            agents,
            details: await agent.getDetails(),
        };
    },
    component: AgentRouteLayout,
    errorComponent: RouteError,
});

/** Shares one agent-details command across status and filesystem child routes. */
function AgentRouteLayout() {
    return <Outlet />;
}
