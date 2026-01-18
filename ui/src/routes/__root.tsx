import {
    Outlet,
    createRootRoute,
    Link,
    useLocation,
    createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Cpu, HardDrive } from "lucide-react";
import { ApiClient } from "../api-client";

interface AppRouterContext {
    api: ApiClient;
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
    loader: async ({ context }) => {
        return context.api.listAgents();
    },
    component: RootLayout,
});

function RootLayout() {
    const { agents } = Route.useLoaderData();
    const location = useLocation();

    return (
        <div className="flex h-screen">
            <aside className="w-72 border-r bg-gray-50 flex flex-col">
                <div className="p-4 border-b bg-white flex items-center gap-2">
                    <Cpu className="h-6 w-6 text-blue-600" />
                    <h1 className="font-bold text-lg text-gray-800">Redoor</h1>
                </div>
                <div className="flex-1 overflow-auto">
                    {agents.length === 0 ? (
                        <div className="p-4 text-sm text-gray-500 text-center">
                            No agents connected
                        </div>
                    ) : (
                        <ul className="divide-y">
                            {agents.map((agent) => {
                                const isActive =
                                    location.pathname ===
                                    `/agents/${encodeURIComponent(agent.id)}`;
                                return (
                                    <li key={agent.id}>
                                        <Link
                                            to="/agents/$agentId"
                                            params={{ agentId: agent.id }}
                                            className={`px-4 py-3 hover:bg-gray-100 cursor-pointer flex items-center gap-3 ${
                                                isActive
                                                    ? "bg-blue-50 border-l-4 border-blue-500"
                                                    : ""
                                            }`}
                                        >
                                            <HardDrive className="h-4 w-4 text-gray-500" />
                                            <span className="text-sm font-medium text-gray-700">
                                                {agent.name}
                                            </span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </aside>
            <main className="flex-1 overflow-auto">
                <Outlet />
            </main>
            <TanStackDevtools
                config={{
                    position: "bottom-right",
                }}
                plugins={[
                    {
                        name: "Tanstack Router",
                        render: <TanStackRouterDevtoolsPanel />,
                    },
                ]}
            />
        </div>
    );
}
