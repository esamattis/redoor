import {
    Outlet,
    Link,
    useLocation,
    createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Cpu, HardDrive, Terminal, Activity } from "lucide-react";
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
    const agents = Route.useLoaderData();
    const location = useLocation();

    return (
        <div className="flex h-screen bg-[#0a0a0f] relative z-10">
            {/* Sidebar */}
            <aside className="w-72 flex flex-col sidebar">
                {/* Logo Header */}
                <div className="p-5 border-b border-[rgba(245,158,11,0.1)] bg-gradient-to-r from-[#12121a] to-[#0a0a0f]">
                    <Link to="/" className="flex items-center gap-3 group">
                        <div className="relative">
                            <div className="absolute inset-0 bg-[#f59e0b] blur-lg opacity-30 group-hover:opacity-50 transition-opacity duration-300"></div>
                            <Cpu className="h-7 w-7 text-[#f59e0b] relative z-10" />
                        </div>
                        <div>
                            <h1 className="font-display text-xl font-bold text-gradient tracking-wider">
                                REDOOR
                            </h1>
                            <p className="font-mono text-[0.65rem] text-[#64748b] tracking-[0.2em] uppercase">
                                Agent Control
                            </p>
                        </div>
                    </Link>
                </div>

                {/* Agents List */}
                <div className="flex-1 overflow-auto py-3">
                    {agents.length === 0 ? (
                        <div className="px-5 py-8 text-center">
                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[#1a1a24] border border-[rgba(245,158,11,0.1)] flex items-center justify-center">
                                <Activity className="h-6 w-6 text-[#64748b]" />
                            </div>
                            <p className="font-mono text-sm text-[#64748b]">
                                No agents connected
                            </p>
                            <p className="font-mono text-xs text-[#475569] mt-2">
                                Waiting for connections...
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-1 px-3">
                            <div className="px-3 py-2">
                                <p className="font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
                                    Connected Agents
                                </p>
                            </div>
                            {agents.map((agent) => {
                                const isActive =
                                    location.pathname ===
                                    `/agents/${encodeURIComponent(agent.id)}`;
                                return (
                                    <Link
                                        key={agent.id}
                                        to="/agents/$agentId"
                                        params={{ agentId: agent.id }}
                                        className={`sidebar-item rounded-lg ${isActive ? "active" : ""}`}
                                    >
                                        <div className="relative">
                                            <HardDrive
                                                className={`h-4 w-4 ${isActive ? "text-[#f59e0b]" : "text-[#64748b]"}`}
                                            />
                                            {isActive && (
                                                <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#10b981] rounded-full animate-pulse"></div>
                                            )}
                                        </div>
                                        <span className="truncate">
                                            {agent.name}
                                        </span>
                                    </Link>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-[rgba(245,158,11,0.1)] bg-[#0a0a0f]">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse"></div>
                            <span className="font-mono text-xs text-[#64748b]">
                                Server Online
                            </span>
                        </div>
                        <span className="font-mono text-xs text-[#475569]">
                            v1.0.0
                        </span>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto relative">
                <Outlet />
            </main>

            {/* DevTools */}
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
