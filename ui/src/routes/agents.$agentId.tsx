import { createFileRoute, Outlet } from "@tanstack/react-router";
import { z } from "zod";

import { SearchDialog } from "#ui/components/search-dialog";
import { RouteError } from "#ui/components/route-error";

export type AgentSearch = {
    q?: string;
    mode?: "content";
    context?: number;
    timeout?: number;
    hidden?: boolean;
    gitignore?: boolean;
    regex?: boolean;
    gitroot?: boolean;
};

/** Restricts grep timeout URLs to the same safe range accepted by recursive search. */
const searchTimeoutSchema = z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .catch(undefined);

/** Restricts shared before/after grep context to the limit accepted by the agent. */
const searchContextSchema = z.coerce
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .catch(undefined);

/** Accepts booleans from both router navigation and directly entered query strings. */
const optionalBooleanSchema = z
    .union([
        z.boolean(),
        z.literal("true").transform(() => true),
        z.literal("false").transform(() => false),
    ])
    .optional()
    .catch(undefined);

/** Keeps presence meaningful because an empty q still opens and focuses the dialog. */
const searchQuerySchema = z.string().optional().catch(undefined);

/** Treats a missing mode as path search while rejecting stale shared URL values. */
const searchModeSchema = z.literal("content").optional().catch(undefined);

export const Route = createFileRoute("/agents/$agentId")({
    validateSearch: (search): AgentSearch => ({
        q: searchQuerySchema.parse(search.q),
        mode: searchModeSchema.parse(search.mode),
        context: searchContextSchema.parse(search.context),
        timeout: searchTimeoutSchema.parse(search.timeout),
        hidden: optionalBooleanSchema.parse(search.hidden),
        gitignore: optionalBooleanSchema.parse(search.gitignore),
        regex: optionalBooleanSchema.parse(search.regex),
        gitroot: optionalBooleanSchema.parse(search.gitroot),
    }),
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
    const data = Route.useLoaderData();
    return (
        <>
            <Outlet />
            <SearchDialog agent={data.agent} />
        </>
    );
}
