import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, HardDrive } from "lucide-react";

import { LogViewer } from "#ui/components/log-viewer";
import { agentLoggingLevelQueryOptions, queryKeys } from "#ui/queries";

export const Route = createFileRoute("/agents/$agentId/logs")({
    loader: async ({ parentMatchPromise, context }) => {
        const agentMatch = await parentMatchPromise;
        const loaderData = agentMatch.loaderData;
        if (!loaderData) {
            throw new Error("Agent loader data is unavailable");
        }
        const agent = loaderData.agent;
        if (agent.status === "connected") {
            await context.queryClient.ensureQueryData(
                agentLoggingLevelQueryOptions(agent),
            );
        }
        return { agent };
    },
    component: AgentLogsPage,
});

/** Avoids opening a retrying live socket when retained inventory says the agent is disconnected. */
function AgentLogsPage() {
    const { agent } = Route.useLoaderData();
    if (agent.status !== "connected") {
        return (
            <div className="flex h-full items-center justify-center p-8">
                <section className="max-w-lg text-center">
                    <AlertCircle className="mx-auto h-12 w-12 text-amber-400" />
                    <h1 className="mt-4 text-2xl font-semibold text-slate-100">
                        {agent.name} is disconnected
                    </h1>
                    <p className="mt-2 text-slate-400">
                        Connect the agent before opening its live logs.
                    </p>
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId: agent.id }}
                        className="mt-6 inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                    >
                        <HardDrive className="h-4 w-4" />
                        Agent
                    </Link>
                </section>
            </div>
        );
    }

    return (
        <LogViewer
            title={`${agent.name} logs`}
            sourceLabel={agent.name}
            websocketUrl={agent.getLogsWebSocketUrl()}
            headerActions={
                <Link
                    to="/logs"
                    className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
                >
                    Server logs
                </Link>
            }
            loggingLevelControl={{
                queryKey: queryKeys.agentLoggingLevel(agent.id),
                load: () => agent.getLoggingLevel(),
                update: (level) => agent.updateLoggingLevel(level),
            }}
        />
    );
}
