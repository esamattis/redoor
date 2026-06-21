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
} from "lucide-react";

export const Route = createFileRoute("/agents/$agentId/")({
    loader: async ({ params, parentMatchPromise }) => {
        const rootMatch = await parentMatchPromise;
        const agents = rootMatch.loaderData?.agents ?? [];
        const agent = agents.find((entry) => entry.id === params.agentId);

        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);

        return agent.getDetails();
    },
    component: AgentDetails,
    errorComponent: ErrorDisplay,
});

function ErrorDisplay({ error }: { error: Error }) {
    if (error.message.includes("not found")) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                    <AlertCircle className="h-12 w-12 text-red-400" />
                    <p className="text-slate-400">Agent not found</p>
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-center">
                <AlertCircle className="h-12 w-12 text-red-400" />
                <p className="text-slate-400">Error loading agent details</p>
                <p className="text-sm text-slate-500">{error.message}</p>
            </div>
        </div>
    );
}

function AgentDetails() {
    const details = Route.useLoaderData();

    return (
        <div className="p-8">
            <div className="mx-auto max-w-4xl">
                <div className="mb-6">
                    <div className="flex items-center justify-between">
                        <h1
                            aria-label="Agent name"
                            className="flex items-center gap-3 text-2xl font-bold text-slate-100"
                        >
                            <HardDrive className="h-8 w-8 text-blue-400" />
                            {details.name}
                        </h1>
                        <Link
                            to="/agents/$agentId/browser/$"
                            params={{ agentId: details.id }}
                            className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
                        >
                            <FolderOpen className="h-4 w-4" />
                            Browse Files
                        </Link>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                        ID: {details.id}
                    </p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <DetailCard
                        title="Process Information"
                        icon={<Cpu className="h-5 w-5" />}
                    >
                        <DetailItem label="PID" value={details.pid} />
                        <div className="flex items-center gap-3 text-sm">
                            <span className="w-24 flex-shrink-0 text-slate-400">
                                Working Directory:
                            </span>
                            <span className="truncate font-mono text-xs text-slate-200">
                                {details.cwd}
                            </span>
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId: details.id }}
                                className="text-xs text-blue-400 hover:underline"
                            >
                                Browse Files
                            </Link>
                        </div>
                    </DetailCard>

                    <DetailCard
                        title="System Load"
                        icon={<Activity className="h-5 w-5" />}
                    >
                        <DetailItem
                            label="1 min"
                            value={details.load_average_one.toFixed(2)}
                        />
                        <DetailItem
                            label="5 min"
                            value={details.load_average_five.toFixed(2)}
                        />
                        <DetailItem
                            label="15 min"
                            value={details.load_average_fifteen.toFixed(2)}
                        />
                    </DetailCard>

                    <DetailCard
                        title="System Info"
                        icon={<Server className="h-5 w-5" />}
                    >
                        <DetailItem label="OS" value={details.os} />
                        <DetailItem label="Architecture" value={details.arch} />
                        <DetailItem label="Hostname" value={details.hostname} />
                    </DetailCard>

                    <DetailCard
                        title="User Info"
                        icon={<User className="h-5 w-5" />}
                    >
                        <DetailItem label="Username" value={details.username} />
                    </DetailCard>

                    <DetailCard
                        title="Uptime"
                        icon={<Clock className="h-5 w-5" />}
                    >
                        <DetailItem
                            label="System"
                            value={formatUptime(details.system_uptime)}
                        />
                        <DetailItem
                            label="Connected"
                            value={formatTimestamp(details.connected_at)}
                        />
                    </DetailCard>
                </div>
            </div>
            <Outlet />
        </div>
    );
}

function DetailCard(props: {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-lg border border-slate-800 bg-[#11141b] p-4">
            <div className="mb-3 flex items-center gap-2 font-semibold text-slate-300">
                {props.icon}
                <h3 className="text-sm uppercase tracking-wide">
                    {props.title}
                </h3>
            </div>
            <div className="space-y-2">{props.children}</div>
        </div>
    );
}

function DetailItem(props: { label: string; value: string | number }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="w-24 flex-shrink-0 text-slate-400">
                {props.label}:
            </span>
            <span
                aria-label={`Detail value for ${props.label}`}
                className="truncate font-mono text-xs text-slate-100"
            >
                {props.value}
            </span>
        </div>
    );
}

function formatUptime(seconds: number): string {
    const sec = seconds;
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

function formatTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
}
