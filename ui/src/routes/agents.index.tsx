import * as React from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { MoreHorizontal, Play, Power, FolderOpen } from "lucide-react";
import type { Agent, BinaryIdentity } from "../api-client";
import {
    fieldMatchTone,
    RevValue,
    VersionValue,
} from "../components/binary-identity";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Dialog } from "../components/dialog";
import { RestartButton, waitForRestart } from "../components/restart-button";
import { formatAgentRecency, useNow } from "../utils/agent-time";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/")({
    component: AgentManagement,
});

type MutationState = Record<string, "start" | "shutdown" | undefined>;

/** Lists retained inventory and scopes lifecycle mutation state to individual rows. */
function AgentManagement() {
    const router = useRouter();
    const actionsButtonRef = React.useRef<HTMLButtonElement>(null);
    const { api } = RootRoute.useRouteContext();
    const { agents, serverInfo } = RootRoute.useLoaderData();
    const serverBinary = React.useMemo(
        () => ({
            version: serverInfo.version,
            git_rev: serverInfo.git_rev,
        }),
        [serverInfo.git_rev, serverInfo.version],
    );
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
    const [actionsAgent, setActionsAgent] = React.useState<Agent | null>(null);
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
                                <th className="px-4 py-3">Version</th>
                                <th className="px-4 py-3">Rev</th>
                                <th className="px-4 py-3">Connection</th>
                                <th className="px-4 py-3">Issue</th>
                                <th className="px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {sortedAgents.map((agent) => {
                                const mutation = mutations[agent.id];
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
                                        <td className="px-4 py-3">
                                            <AgentVersionCell
                                                binary={agent.binary}
                                                serverVersion={
                                                    serverBinary.version
                                                }
                                            />
                                        </td>
                                        <td className="px-4 py-3">
                                            <AgentRevCell
                                                binary={agent.binary}
                                                serverGitRev={
                                                    serverBinary.git_rev
                                                }
                                            />
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
                                                <span
                                                    role="alert"
                                                    className="whitespace-pre-wrap"
                                                >
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
                                            <button
                                                type="button"
                                                aria-label={`Open actions for ${agent.name}`}
                                                onClick={(event) => {
                                                    actionsButtonRef.current =
                                                        event.currentTarget;
                                                    setActionsAgent(agent);
                                                }}
                                                disabled={
                                                    mutation !== undefined
                                                }
                                                className="inline-flex items-center gap-1 rounded border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-white/5 disabled:opacity-50"
                                            >
                                                <MoreHorizontal className="h-4 w-4" />
                                                Actions
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
            <Dialog
                isOpen={actionsAgent !== null}
                title={
                    actionsAgent
                        ? `${actionsAgent.name} actions`
                        : "Agent actions"
                }
                closeAriaLabel="Close agent actions"
                anchorRef={actionsButtonRef}
                onClose={() => setActionsAgent(null)}
            >
                {actionsAgent ? (
                    <div className="mt-3 flex flex-col gap-2">
                        {actionsAgent.managed &&
                        (actionsAgent.status === "stopped" ||
                            actionsAgent.status === "disconnected") ? (
                            <button
                                type="button"
                                onClick={() => {
                                    start(actionsAgent);
                                    setActionsAgent(null);
                                }}
                                className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
                            >
                                <Play className="h-4 w-4" /> Start
                            </button>
                        ) : null}
                        {actionsAgent.status === "connected" ? (
                            <RestartButton
                                target={`agent ${actionsAgent.name}`}
                                description="The agent will restart with the same arguments. In-flight transfers and terminals are interrupted."
                                restart={() => actionsAgent.restart()}
                                waitUntilReady={() =>
                                    waitForRestart(async () => {
                                        const restartedAgent = (
                                            await api.listAgents()
                                        ).find(
                                            (entry) =>
                                                entry.id === actionsAgent.id &&
                                                entry.status === "connected" &&
                                                entry.connectionId !==
                                                    actionsAgent.connectionId,
                                        );
                                        if (!restartedAgent) {
                                            throw new Error(
                                                "Agent is still restarting",
                                            );
                                        }
                                        await router.invalidate();
                                    }, "Agent did not come back after restart")
                                }
                            />
                        ) : null}
                        {actionsAgent.managed &&
                        (actionsAgent.status === "starting" ||
                            actionsAgent.status === "connected") ? (
                            <button
                                type="button"
                                onClick={() => {
                                    setShutdownAgent(actionsAgent);
                                    setActionsAgent(null);
                                }}
                                className="inline-flex items-center gap-2 rounded border border-red-800 px-4 py-2 text-red-300 hover:bg-red-950/30"
                            >
                                <Power className="h-4 w-4" /> Shutdown
                            </button>
                        ) : null}
                        {actionsAgent.status === "connected" &&
                        actionsAgent.cwd !== null ? (
                            <Link
                                to={actionsAgent.getBrowserUrl(
                                    actionsAgent.cwd,
                                )}
                                onClick={() => setActionsAgent(null)}
                                className="inline-flex items-center gap-2 rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5"
                            >
                                <FolderOpen className="h-4 w-4" /> Browse files
                            </Link>
                        ) : null}
                    </div>
                ) : null}
            </Dialog>
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

/** Package version cell: green/red vs server, plus version-tag dirty badge. */
function AgentVersionCell(props: {
    binary: BinaryIdentity | null;
    serverVersion: string;
}) {
    if (props.binary === null) {
        return <span className="text-slate-500">—</span>;
    }
    const tone = fieldMatchTone(props.binary.version, props.serverVersion);
    return (
        <VersionValue
            version={props.binary.version}
            versionDirty={props.binary.version_dirty}
            tone={tone}
            title={
                tone === "mismatch"
                    ? `Differs from server ${props.serverVersion}`
                    : "Matches server version"
            }
        />
    );
}

/** Git rev cell: green/red vs server, plus working-tree dirty badge. */
function AgentRevCell(props: {
    binary: BinaryIdentity | null;
    serverGitRev: string;
}) {
    if (props.binary === null) {
        return <span className="text-slate-500">—</span>;
    }
    const tone = fieldMatchTone(props.binary.git_rev, props.serverGitRev);
    return (
        <RevValue
            gitRev={props.binary.git_rev}
            gitDirty={props.binary.git_dirty}
            tone={tone}
            title={
                tone === "mismatch"
                    ? `Differs from server ${props.serverGitRev.slice(0, 7)}`
                    : "Matches server revision"
            }
        />
    );
}
