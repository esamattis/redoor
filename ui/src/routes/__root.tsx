import * as React from "react";
import {
    Outlet,
    Link,
    useLocation,
    createRootRouteWithContext,
    useRouter,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
    Cpu,
    HardDrive,
    ArrowDownToLine,
    ArrowUpFromLine,
    AlertCircle,
} from "lucide-react";
import { ApiClient, type TransferProgressEntry } from "../api-client";
import { formatSize } from "../utils/path";

interface AppRouterContext {
    api: ApiClient;
}

export type RootLoaderData = {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transferProgress: Awaited<ReturnType<ApiClient["getTransferProgress"]>>;
};

export function getAgentFromRootLoaderData(
    loaderData: RootLoaderData,
    agentId: string,
) {
    return loaderData.agents.find((agent) => agent.id === agentId);
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
    loader: async ({ context }) => {
        const [agents, transferProgress] = await Promise.all([
            context.api.listAgents(),
            context.api.getTransferProgress(),
        ]);

        return {
            agents,
            transferProgress,
        } satisfies RootLoaderData;
    },
    component: RootLayout,
});

function RootLayout() {
    const { agents, transferProgress } = Route.useLoaderData();
    const location = useLocation();
    const router = useRouter();

    React.useEffect(() => {
        const intervalId = window.setInterval(() => {
            void router.invalidate();
        }, 5000);

        return () => {
            window.clearInterval(intervalId);
        };
    }, [router]);

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
            <div className="flex-1 min-h-0 flex flex-col">
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
                <TransferProgressPanel
                    agents={agents}
                    transfers={transferProgress.transfers}
                />
            </div>
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

function TransferProgressPanel(props: {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transfers: TransferProgressEntry[];
}) {
    if (props.transfers.length === 0) {
        return null;
    }

    return (
        <section className="sticky bottom-0 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
            <div className="px-6 py-4">
                <div className="max-w-full">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold text-gray-900">
                                Transfer progress
                            </h2>
                            <p className="text-xs text-gray-500">
                                Active, completed, and failed transfers
                            </p>
                        </div>
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                            {props.transfers.length}{" "}
                            {props.transfers.length === 1
                                ? "transfer"
                                : "transfers"}
                        </span>
                    </div>

                    <div className="max-h-64 overflow-auto rounded-lg border">
                        <table className="w-full bg-white">
                            <thead className="sticky top-0 bg-gray-50">
                                <tr className="border-b">
                                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                                        Agent
                                    </th>
                                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                                        Direction
                                    </th>
                                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                                        File path
                                    </th>
                                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                                        Progress
                                    </th>
                                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                                        Status
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {props.transfers.map((transfer) => {
                                    const agent = props.agents.find(
                                        (entry) =>
                                            entry.id === transfer.agent_id,
                                    );

                                    return (
                                        <tr
                                            key={transfer.request_id.toString()}
                                            className="border-b last:border-b-0 hover:bg-gray-50 align-top"
                                        >
                                            <td className="p-3">
                                                <div className="flex flex-col">
                                                    <span className="text-sm font-medium text-gray-900">
                                                        {agent?.name ??
                                                            transfer.agent_id}
                                                    </span>
                                                    <span className="text-xs text-gray-500">
                                                        {transfer.agent_id}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="p-3">
                                                <span
                                                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                                                        transfer.direction ===
                                                        "upload"
                                                            ? "bg-blue-50 text-blue-700"
                                                            : "bg-emerald-50 text-emerald-700"
                                                    }`}
                                                >
                                                    {transfer.direction ===
                                                    "upload" ? (
                                                        <ArrowUpFromLine className="h-3.5 w-3.5" />
                                                    ) : (
                                                        <ArrowDownToLine className="h-3.5 w-3.5" />
                                                    )}
                                                    {transfer.direction ===
                                                    "upload"
                                                        ? "Upload"
                                                        : "Download"}
                                                </span>
                                            </td>
                                            <td className="p-3">
                                                <div className="font-mono text-xs text-gray-700 break-all">
                                                    {transfer.path}
                                                </div>
                                            </td>
                                            <td className="p-3">
                                                <div className="flex flex-col gap-1 text-sm text-gray-700">
                                                    <span>
                                                        {formatSize(
                                                            transfer.transferred_bytes,
                                                        )}{" "}
                                                        /{" "}
                                                        {formatSize(
                                                            transfer.total_bytes,
                                                        )}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="p-3">
                                                <div className="flex flex-col gap-1">
                                                    <span
                                                        className={`text-sm font-medium ${
                                                            transfer.state ===
                                                            "errored"
                                                                ? "text-red-600"
                                                                : transfer.state ===
                                                                    "completed"
                                                                  ? "text-emerald-700"
                                                                  : "text-gray-900"
                                                        }`}
                                                    >
                                                        {transfer.state}
                                                    </span>
                                                    {transfer.error ? (
                                                        <span className="inline-flex items-start gap-1 text-xs text-red-600">
                                                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                            <span className="break-words">
                                                                {transfer.error}
                                                            </span>
                                                        </span>
                                                    ) : null}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </section>
    );
}
