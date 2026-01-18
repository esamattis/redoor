import { createFileRoute } from "@tanstack/react-router";
import {
    Cpu,
    HardDrive,
    Clock,
    Server,
    User,
    Activity,
    AlertCircle,
} from "lucide-react";

export const Route = createFileRoute("/agents/$agentId")({
    loader: async ({ params, context }) =>
        await context.api.getAgentDetails(params.agentId),
    component: AgentDetails,
    errorComponent: ErrorDisplay,
});

function ErrorDisplay({ error }: { error: Error }) {
    if (error.message.includes("not found")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Agent not found</p>
                </div>
            </div>
        );
    }
    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center flex flex-col items-center gap-2">
                <AlertCircle className="h-12 w-12 text-red-500" />
                <p className="text-gray-500">Error loading agent details</p>
                <p className="text-sm text-gray-400">{error.message}</p>
            </div>
        </div>
    );
}

function AgentDetails() {
    const details = Route.useLoaderData();

    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                        <HardDrive className="h-8 w-8 text-blue-600" />
                        {details.name}
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                        ID: {details.id}
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <DetailCard
                        title="Process Information"
                        icon={<Cpu className="h-5 w-5" />}
                    >
                        <DetailItem label="PID" value={details.pid} />
                        <DetailItem
                            label="Working Directory"
                            value={details.cwd}
                        />
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
        </div>
    );
}

function DetailCard({
    title,
    icon,
    children,
}: {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 mb-3 text-gray-700 font-semibold">
                {icon}
                <h3 className="text-sm uppercase tracking-wide">{title}</h3>
            </div>
            <div className="space-y-2">{children}</div>
        </div>
    );
}

function DetailItem({
    label,
    value,
}: {
    label: string;
    value: string | number;
}) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500 w-24 flex-shrink-0">{label}:</span>
            <span className="text-gray-900 font-mono text-xs truncate">
                {value}
            </span>
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

function formatTimestamp(timestamp: bigint): string {
    return new Date(Number(timestamp) * 1000).toLocaleString();
}
