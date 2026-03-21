import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import {
    Cpu,
    HardDrive,
    Clock,
    Server,
    User,
    Activity,
    AlertCircle,
    FolderOpen,
    Zap,
    Terminal,
    Gauge,
} from "lucide-react";

export const Route = createFileRoute("/agents/$agentId/")({
    loader: async ({ params, context }) => {
        const agents = await context.api.listAgents();
        const agent = agents.find((a) => a.id === params.agentId);
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
        return agent.getDetails();
    },
    component: AgentDetails,
    errorComponent: ErrorDisplay,
});

function ErrorDisplay(props: { error: Error }) {
    const error = props.error;
    if (error.message.includes("not found")) {
        return (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                    <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-[#ef4444] blur-2xl opacity-20"></div>
                        <AlertCircle className="h-16 w-16 text-[#ef4444] relative" />
                    </div>
                    <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                        Agent Not Found
                    </h2>
                    <p className="font-mono text-sm text-[#64748b]">
                        The requested agent could not be located
                    </p>
                </div>
            </div>
        );
    }
    return (
        <div className="min-h-screen flex items-center justify-center p-8">
            <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                <div className="relative inline-block mb-6">
                    <div className="absolute inset-0 bg-[#ef4444] blur-2xl opacity-20"></div>
                    <AlertCircle className="h-16 w-16 text-[#ef4444] relative" />
                </div>
                <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                    Error Loading Details
                </h2>
                <p className="font-mono text-sm text-[#64748b] mb-4">
                    {error.message}
                </p>
            </div>
        </div>
    );
}

function AgentDetails() {
    const details = Route.useLoaderData();

    return (
        <div className="min-h-screen p-8">
            <div className="max-w-6xl mx-auto">
                {/* Header Section */}
                <div className="mb-8">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                        <div className="flex items-center gap-4">
                            <div className="relative">
                                <div className="absolute inset-0 bg-[#f59e0b] blur-xl opacity-30"></div>
                                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-[#1a1a24] to-[#12121a] border border-[rgba(245,158,11,0.3)] flex items-center justify-center">
                                    <HardDrive className="h-8 w-8 text-[#f59e0b]" />
                                </div>
                            </div>
                            <div>
                                <div className="flex items-center gap-3 mb-1">
                                    <h1 className="font-display text-3xl font-bold text-[#f8fafc] tracking-wide">
                                        {details.name}
                                    </h1>
                                    <span className="badge badge-amber">
                                        Active
                                    </span>
                                </div>
                                <p className="font-mono text-sm text-[#64748b]">
                                    ID: {details.id}
                                </p>
                            </div>
                        </div>
                        <Link
                            to="/agents/$agentId/browser/$"
                            params={{ agentId: details.id }}
                            className="btn-primary"
                        >
                            <FolderOpen className="h-4 w-4" />
                            Browse Files
                        </Link>
                    </div>
                    <div className="h-px bg-gradient-to-r from-[rgba(245,158,11,0.3)] via-[rgba(6,182,212,0.2)] to-transparent"></div>
                </div>

                {/* Info Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    {/* Process Information */}
                    <DetailCard
                        title="Process Information"
                        icon={<Cpu className="h-5 w-5 text-[#f59e0b]" />}
                        accent="amber"
                    >
                        <DetailItem label="PID" value={details.pid} />
                        <DetailItem
                            label="Working Dir"
                            value={details.cwd}
                            monospace
                            truncate
                        />
                        <div className="mt-4 pt-4 border-t border-[rgba(245,158,11,0.1)]">
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId: details.id }}
                                className="link-primary font-mono text-sm flex items-center gap-2"
                            >
                                <FolderOpen className="h-4 w-4" />
                                Open in Browser
                            </Link>
                        </div>
                    </DetailCard>

                    {/* System Load */}
                    <DetailCard
                        title="System Load"
                        icon={<Gauge className="h-5 w-5 text-[#06b6d4]" />}
                        accent="cyan"
                    >
                        <LoadBar
                            label="1 min"
                            value={details.load_average_one}
                            max={4}
                        />
                        <LoadBar
                            label="5 min"
                            value={details.load_average_five}
                            max={4}
                        />
                        <LoadBar
                            label="15 min"
                            value={details.load_average_fifteen}
                            max={4}
                        />
                    </DetailCard>

                    {/* System Info */}
                    <DetailCard
                        title="System Information"
                        icon={<Server className="h-5 w-5 text-[#a855f7]" />}
                        accent="purple"
                    >
                        <DetailItem
                            label="Operating System"
                            value={details.os}
                        />
                        <DetailItem label="Architecture" value={details.arch} />
                        <DetailItem label="Hostname" value={details.hostname} />
                    </DetailCard>

                    {/* User Info */}
                    <DetailCard
                        title="User Context"
                        icon={<User className="h-5 w-5 text-[#10b981]" />}
                        accent="green"
                    >
                        <DetailItem label="Username" value={details.username} />
                    </DetailCard>

                    {/* Uptime */}
                    <DetailCard
                        title="Uptime Statistics"
                        icon={<Clock className="h-5 w-5 text-[#f59e0b]" />}
                        accent="amber"
                    >
                        <DetailItem
                            label="System Uptime"
                            value={formatUptime(details.system_uptime)}
                            highlight
                        />
                        <DetailItem
                            label="Connected Since"
                            value={formatTimestamp(details.connected_at)}
                        />
                    </DetailCard>

                    {/* Quick Actions */}
                    <DetailCard
                        title="Quick Actions"
                        icon={<Zap className="h-5 w-5 text-[#f59e0b]" />}
                        accent="amber"
                    >
                        <div className="space-y-3">
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId: details.id }}
                                className="btn-secondary w-full justify-center"
                            >
                                <FolderOpen className="h-4 w-4" />
                                Browse Filesystem
                            </Link>
                            <button
                                className="btn-secondary w-full justify-center opacity-50 cursor-not-allowed"
                                disabled
                            >
                                <Terminal className="h-4 w-4" />
                                Remote Shell (Soon)
                            </button>
                        </div>
                    </DetailCard>
                </div>

                {/* System Metrics Visualization */}
                <div className="mt-8 glass-card rounded-xl p-6">
                    <div className="flex items-center gap-3 mb-6">
                        <Activity className="h-5 w-5 text-[#f59e0b]" />
                        <h3 className="font-heading font-semibold text-[#f8fafc] uppercase tracking-wider text-sm">
                            System Overview
                        </h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <MetricCard
                            label="Load Average"
                            value={`${details.load_average_one.toFixed(2)}`}
                            subtext="1 minute average"
                            color="amber"
                        />
                        <MetricCard
                            label="System Uptime"
                            value={formatUptimeShort(details.system_uptime)}
                            subtext="Since last boot"
                            color="cyan"
                        />
                        <MetricCard
                            label="Process ID"
                            value={details.pid.toString()}
                            subtext="Agent process"
                            color="purple"
                        />
                    </div>
                </div>
            </div>
            <Outlet />
        </div>
    );
}

function DetailCard(props: {
    title: string;
    icon: React.ReactNode;
    accent: "amber" | "cyan" | "purple" | "green";
    children: React.ReactNode;
}) {
    const accentColors = {
        amber: "border-[rgba(245,158,11,0.2)] hover:border-[rgba(245,158,11,0.4)]",
        cyan: "border-[rgba(6,182,212,0.2)] hover:border-[rgba(6,182,212,0.4)]",
        purple: "border-[rgba(168,85,247,0.2)] hover:border-[rgba(168,85,247,0.4)]",
        green: "border-[rgba(16,185,129,0.2)] hover:border-[rgba(16,185,129,0.4)]",
    };

    return (
        <div
            className={`glass-card rounded-xl p-5 transition-all duration-300 ${accentColors[props.accent]}`}
        >
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-[rgba(245,158,11,0.1)]">
                <div className="p-2 rounded-lg bg-[rgba(245,158,11,0.05)]">
                    {props.icon}
                </div>
                <h3 className="font-heading font-semibold text-[#f8fafc] uppercase tracking-wider text-sm">
                    {props.title}
                </h3>
            </div>
            <div className="space-y-3">{props.children}</div>
        </div>
    );
}

function DetailItem(props: {
    label: string;
    value: string | number | bigint;
    monospace?: boolean;
    truncate?: boolean;
    highlight?: boolean;
}) {
    return (
        <div className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs text-[#64748b] uppercase tracking-wider">
                {props.label}
            </span>
            <span
                className={`text-sm ${props.monospace ? "font-mono" : "font-body"} ${props.truncate ? "truncate max-w-[200px]" : ""} ${props.highlight ? "text-[#f59e0b] font-semibold" : "text-[#f8fafc]"}`}
            >
                {props.value}
            </span>
        </div>
    );
}

function LoadBar(props: { label: string; value: number; max: number }) {
    const percentage = Math.min((props.value / props.max) * 100, 100);
    const getColor = (val: number) => {
        if (val < 1) return "bg-[#10b981]";
        if (val < 2) return "bg-[#f59e0b]";
        return "bg-[#ef4444]";
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs text-[#64748b] uppercase tracking-wider">
                    {props.label}
                </span>
                <span className="font-mono text-sm text-[#f8fafc]">
                    {props.value.toFixed(2)}
                </span>
            </div>
            <div className="h-2 bg-[#1a1a24] rounded-full overflow-hidden border border-[rgba(245,158,11,0.1)]">
                <div
                    className={`h-full rounded-full transition-all duration-500 ${getColor(props.value)}`}
                    style={{ width: `${percentage}%` }}
                ></div>
            </div>
        </div>
    );
}

function MetricCard(props: {
    label: string;
    value: string;
    subtext: string;
    color: "amber" | "cyan" | "purple";
}) {
    const colorClasses = {
        amber: "text-[#f59e0b]",
        cyan: "text-[#06b6d4]",
        purple: "text-[#a855f7]",
    };

    return (
        <div className="text-center p-4 rounded-xl bg-[rgba(245,158,11,0.03)] border border-[rgba(245,158,11,0.1)]">
            <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider mb-2">
                {props.label}
            </p>
            <p
                className={`font-display text-3xl font-bold ${colorClasses[props.color]} mb-1`}
            >
                {props.value}
            </p>
            <p className="font-mono text-xs text-[#475569]">{props.subtext}</p>
        </div>
    );
}

function formatUptime(seconds: bigint): string {
    const sec = Number(seconds);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const minutes = Math.floor((sec % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

function formatUptimeShort(seconds: bigint): string {
    const sec = Number(seconds);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    return `${hours}h`;
}

function formatTimestamp(timestamp: bigint): string {
    return new Date(Number(timestamp) * 1000).toLocaleString();
}
