import { createFileRoute, Link } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";

import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

function Index() {
    const { agents } = RootRoute.useLoaderData();
    const sortedAgents = [...agents].sort((left, right) =>
        left.name.localeCompare(right.name),
    );

    return (
        <div className="p-8">
            <div className="mx-auto max-w-6xl">
                <h1 className="mb-6 text-2xl font-bold text-slate-100">
                    Agents
                </h1>
                {agents.length === 0 ? (
                    <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-slate-800">
                        <p className="text-slate-500">No agents connected</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {sortedAgents.map((agent) => (
                            <Link
                                key={agent.id}
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                className="flex cursor-pointer items-center gap-4 rounded-lg border border-slate-800 bg-[#11141b] p-6 transition-all hover:border-blue-500/60 hover:bg-[#161a23] hover:shadow-[0_0_0_1px_rgba(59,130,246,0.35)]"
                            >
                                <HardDrive className="h-8 w-8 flex-shrink-0 text-blue-400" />
                                <div className="min-w-0">
                                    <h2 className="truncate font-semibold text-slate-100">
                                        {agent.name}
                                    </h2>
                                    <p className="mt-1 truncate text-sm text-slate-500">
                                        {agent.id}
                                    </p>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
