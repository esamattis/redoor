import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, HardDrive } from "lucide-react";

import { LogViewer } from "#ui/components/log-viewer";

export const Route = createFileRoute("/agents/$agentId/logs")({
    loader: async ({ parentMatchPromise }) => {
        const agentMatch = await parentMatchPromise;
        const loaderData = agentMatch.loaderData;
        if (!loaderData) {
            throw new Error("Agent loader data is unavailable");
        }
        const agent = loaderData.agent;
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
                        className="mt-6 inline-flex items-center gap-2 rounded bg-[var(--app-primary)] px-4 py-2 text-[var(--app-primary-ink)] hover:bg-[var(--app-primary-hover)]"
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
        />
    );
}
