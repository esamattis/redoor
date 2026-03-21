import { createFileRoute, Link } from "@tanstack/react-router";
import { HardDrive, Activity, Terminal, Server } from "lucide-react";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

function Index() {
    const agents = RootRoute.useLoaderData();

    return (
        <div className="min-h-screen p-8">
            <div className="max-w-6xl mx-auto">
                {/* Header */}
                <div className="mb-10">
                    <div className="flex items-center gap-4 mb-4">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#f59e0b] to-[#d97706] flex items-center justify-center shadow-lg shadow-[rgba(245,158,11,0.3)]">
                            <Terminal className="h-6 w-6 text-[#0a0a0f]" />
                        </div>
                        <div>
                            <h1 className="font-display text-3xl font-bold text-[#f8fafc] tracking-wide">
                                AGENT DASHBOARD
                            </h1>
                            <p className="font-mono text-sm text-[#64748b] mt-1">
                                Monitor and manage connected agents
                            </p>
                        </div>
                    </div>
                    <div className="h-px bg-gradient-to-r from-[rgba(245,158,11,0.3)] via-[rgba(6,182,212,0.2)] to-transparent"></div>
                </div>

                {agents.length === 0 ? (
                    // Empty State
                    <div className="glass-card rounded-2xl p-16 text-center">
                        <div className="relative inline-block mb-6">
                            <div className="absolute inset-0 bg-[#64748b] blur-2xl opacity-20"></div>
                            <div className="relative w-24 h-24 mx-auto rounded-2xl bg-[#1a1a24] border border-[rgba(100,116,139,0.2)] flex items-center justify-center">
                                <Activity className="h-10 w-10 text-[#64748b]" />
                            </div>
                        </div>
                        <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-3">
                            No Agents Connected
                        </h2>
                        <p className="font-mono text-sm text-[#64748b] max-w-md mx-auto leading-relaxed">
                            Waiting for agents to establish connection...
                            <br />
                            Agents will appear here once they connect to the
                            server.
                        </p>
                    </div>
                ) : (
                    // Agent Grid
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {agents.map((agent, index) => (
                            <Link
                                key={agent.id}
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                className="group relative"
                            >
                                <div className="glass-card card-hover rounded-xl p-6 cursor-pointer relative overflow-hidden">
                                    {/* Glow Effect */}
                                    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-[rgba(245,158,11,0.1)] to-transparent rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

                                    {/* Status Indicator */}
                                    <div className="absolute top-5 right-5 flex items-center gap-2">
                                        <div className="status-dot"></div>
                                        <span className="font-mono text-xs text-[#10b981] uppercase tracking-wider">
                                            Online
                                        </span>
                                    </div>

                                    {/* Icon */}
                                    <div className="relative mb-5">
                                        <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[#1a1a24] to-[#12121a] border border-[rgba(245,158,11,0.15)] flex items-center justify-center group-hover:border-[rgba(245,158,11,0.4)] transition-colors duration-300">
                                            <HardDrive className="h-6 w-6 text-[#f59e0b]" />
                                        </div>
                                    </div>

                                    {/* Content */}
                                    <h2 className="font-heading text-lg font-semibold text-[#f8fafc] mb-2 group-hover:text-[#f59e0b] transition-colors duration-300">
                                        {agent.name}
                                    </h2>
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="badge badge-amber">
                                            Agent
                                        </span>
                                    </div>
                                    <p className="font-mono text-xs text-[#64748b] truncate">
                                        ID: {agent.id}
                                    </p>

                                    {/* Connection Line */}
                                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#f59e0b] via-[#06b6d4] to-[#a855f7] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left"></div>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}

                {/* Stats Footer */}
                <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="glass-card rounded-xl p-5 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-[rgba(245,158,11,0.1)] flex items-center justify-center">
                            <Server className="h-5 w-5 text-[#f59e0b]" />
                        </div>
                        <div>
                            <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider">
                                Total Agents
                            </p>
                            <p className="font-heading text-2xl font-bold text-[#f8fafc]">
                                {agents.length}
                            </p>
                        </div>
                    </div>
                    <div className="glass-card rounded-xl p-5 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-[rgba(16,185,129,0.1)] flex items-center justify-center">
                            <Activity className="h-5 w-5 text-[#10b981]" />
                        </div>
                        <div>
                            <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider">
                                Active Connections
                            </p>
                            <p className="font-heading text-2xl font-bold text-[#f8fafc]">
                                {agents.length}
                            </p>
                        </div>
                    </div>
                    <div className="glass-card rounded-xl p-5 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-[rgba(6,182,212,0.1)] flex items-center justify-center">
                            <Terminal className="h-5 w-5 text-[#06b6d4]" />
                        </div>
                        <div>
                            <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider">
                                Server Status
                            </p>
                            <p className="font-heading text-lg font-bold text-[#10b981]">
                                OPERATIONAL
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
