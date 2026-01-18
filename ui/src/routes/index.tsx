import { createFileRoute, Link } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";

import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

function Index() {
    const { agents } = RootRoute.useLoaderData();

    return (
        <div className="p-6">
            <div className="max-w-6xl mx-auto">
                <h1 className="text-2xl font-bold text-gray-900 mb-6">Agents</h1>
                {agents.length === 0 ? (
                    <div className="flex items-center justify-center h-64 border-2 border-dashed border-gray-300 rounded-lg">
                        <p className="text-gray-500">No agents connected</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {agents.map((agent) => (
                            <Link
                                key={agent.id}
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                className="bg-white border rounded-lg p-6 hover:border-blue-500 hover:shadow-md transition-all cursor-pointer flex items-center gap-4"
                            >
                                <HardDrive className="h-8 w-8 text-blue-600 flex-shrink-0" />
                                <div>
                                    <h2 className="font-semibold text-gray-900">
                                        {agent.name}
                                    </h2>
                                    <p className="text-sm text-gray-500 mt-1">
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
