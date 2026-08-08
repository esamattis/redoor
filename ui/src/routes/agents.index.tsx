import * as React from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { LoaderCircle, Play, Power, FolderOpen } from "lucide-react";
import type { Agent } from "../api-client";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { formatAgentRecency, useNow } from "../utils/agent-time";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/")({
    component: AgentManagement,
});

type MutationState = Record<string, "start" | "shutdown" | undefined>;

/** Lists retained inventory and scopes lifecycle mutation state to individual rows. */
function AgentManagement() {
    const router = useRouter();
    const { agents } = RootRoute.useLoaderData();
    const sortedAgents = React.useMemo(
        () =>
            [...agents].sort(
                (left, right) =>
                    left.name.localeCompare(right.name) ||
                    left.id.localeCompare(right.id),
            ),
        [agents],
    );
    const now = useNow();
    const [mutations, setMutations] = React.useState<MutationState>({});
    const [shutdownAgent, setShutdownAgent] = React.useState<Agent | null>(
        null,
    );
    const [mutationErrors, setMutationErrors] = React.useState<
        Record<string, string | undefined>
    >({});

    /** Starts one row without disabling unrelated lifecycle controls. */
    const start = (agent: Agent) => {
        setMutations((state) => ({ ...state, [agent.id]: "start" }));
        setMutationErrors((state) => ({ ...state, [agent.id]: undefined }));
        void agent
            .start()
            .then(() => router.invalidate())
            .catch((error: unknown) => {
                setMutationErrors((state) => ({
                    ...state,
                    [agent.id]:
                        error instanceof Error
                            ? error.message
                            : "Failed to start agent",
                }));
            })
            .finally(() => {
                setMutations((state) => ({ ...state, [agent.id]: undefined }));
            });
    };

    /** Confirms child cleanup before clearing the row-level shutdown state. */
    const confirmShutdown = () => {
        if (shutdownAgent === null) return;
        const agent = shutdownAgent;
        setMutations((state) => ({ ...state, [agent.id]: "shutdown" }));
        setMutationErrors((state) => ({ ...state, [agent.id]: undefined }));
        void agent
            .shutdown()
            .then(() => {
                setShutdownAgent(null);
                return router.invalidate();
            })
            .catch((error: unknown) => {
                setMutationErrors((state) => ({
                    ...state,
                    [agent.id]:
                        error instanceof Error
                            ? error.message
                            : "Failed to shut down agent",
                }));
            })
            .finally(() => {
                setMutations((state) => ({ ...state, [agent.id]: undefined }));
            });
    };

    return (
        <div className="p-8">
            <div className="mx-auto max-w-7xl">
                <h1 className="text-2xl font-bold text-slate-100">Agents</h1>
                <p className="mt-2 text-sm text-slate-400">
                    Manage TOML agents and observe external connections known
                    during this server run.
                </p>
                <div className="mt-6 overflow-x-auto rounded-lg border border-slate-800">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-[#11141b] text-slate-400">
                            <tr>
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3">Source</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Connection</th>
                                <th className="px-4 py-3">Issue</th>
                                <th className="px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {sortedAgents.map((agent) => {
                                const mutation = mutations[agent.id];
                                const canStart =
                                    agent.managed &&
                                    (agent.status === "stopped" ||
                                        agent.status === "disconnected");
                                const canShutdown =
                                    agent.managed &&
                                    (agent.status === "starting" ||
                                        agent.status === "connected");
                                return (
                                    <tr
                                        key={agent.id}
                                        aria-label={`Agent ${agent.name}`}
                                        className="bg-[#0f1218] text-slate-200"
                                    >
                                        <td className="px-4 py-3">
                                            <Link
                                                to="/agents/$agentId"
                                                params={{ agentId: agent.id }}
                                                className="font-medium text-blue-400 hover:underline"
                                            >
                                                {agent.name}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3">
                                            {agent.managed
                                                ? "Managed (TOML)"
                                                : "External"}
                                        </td>
                                        <td className="px-4 py-3 capitalize">
                                            {agent.status}
                                        </td>
                                        <td className="px-4 py-3 text-slate-400">
                                            {formatAgentRecency(
                                                agent.status,
                                                agent.connectedAt,
                                                agent.lastSeenAt,
                                                now,
                                            )}
                                        </td>
                                        <td className="max-w-sm px-4 py-3 text-amber-300">
                                            {agent.connectionIssue ? (
                                                <span role="alert">
                                                    {agent.connectionIssue}
                                                </span>
                                            ) : (
                                                "—"
                                            )}
                                            {mutationErrors[agent.id] ? (
                                                <span role="alert">
                                                    {mutationErrors[agent.id]}
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-wrap gap-2">
                                                {canStart ? (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            start(agent)
                                                        }
                                                        disabled={
                                                            mutation !==
                                                            undefined
                                                        }
                                                        className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
                                                    >
                                                        {mutation ===
                                                        "start" ? (
                                                            <LoaderCircle className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <Play className="h-4 w-4" />
                                                        )}
                                                        {mutation === "start"
                                                            ? "Starting…"
                                                            : "Start"}
                                                    </button>
                                                ) : null}
                                                {canShutdown ? (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setShutdownAgent(
                                                                agent,
                                                            )
                                                        }
                                                        disabled={
                                                            mutation !==
                                                            undefined
                                                        }
                                                        className="inline-flex items-center gap-1 rounded border border-red-800 px-3 py-1.5 text-red-300 hover:bg-red-950/30 disabled:opacity-50"
                                                    >
                                                        <Power className="h-4 w-4" />{" "}
                                                        Shutdown
                                                    </button>
                                                ) : null}
                                                {agent.status === "connected" &&
                                                agent.cwd !== null ? (
                                                    <Link
                                                        to={agent.getBrowserUrl(
                                                            agent.cwd,
                                                        )}
                                                        className="inline-flex items-center gap-1 rounded border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-white/5"
                                                    >
                                                        <FolderOpen className="h-4 w-4" />{" "}
                                                        Browse files
                                                    </Link>
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
            <ConfirmationDialog
                isOpen={shutdownAgent !== null}
                title={
                    shutdownAgent
                        ? `Shut down ${shutdownAgent.name}?`
                        : "Shut down agent?"
                }
                description="Active transfers and terminals for this agent will be interrupted."
                confirmLabel="Shutdown"
                busyLabel="Shutting down…"
                isBusy={
                    shutdownAgent !== null &&
                    mutations[shutdownAgent.id] === "shutdown"
                }
                errorMessage={
                    shutdownAgent
                        ? (mutationErrors[shutdownAgent.id] ?? null)
                        : null
                }
                onClose={() => setShutdownAgent(null)}
                onConfirm={confirmShutdown}
            />
        </div>
    );
}
