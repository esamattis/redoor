import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Play, Power, FolderOpen } from "lucide-react";
import type { Agent, BinaryIdentity } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import {
    fieldMatchTone,
    RevValue,
    VersionValue,
} from "#ui/components/binary-identity";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { RestartButton, waitForRestart } from "#ui/components/restart-button";
import { agentsQueryOptions } from "#ui/queries";
import { formatAgentRecency, useNow } from "#ui/utils/agent-time";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/")({
    component: AgentManagement,
});

type MutationState = Record<string, "start" | "shutdown" | undefined>;

/** Lists retained inventory and scopes lifecycle mutation state to individual rows. */
function AgentManagement() {
    const router = useRouter();
    const queryClient = useQueryClient();
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
    const [mutationErrors, setMutationErrors] = React.useState<
        Record<string, string | undefined>
    >({});
    const startMutation = useMutation({
        mutationFn: (agent: Agent) => agent.start(),
        onMutate: (agent) => {
            setMutations((state) => ({ ...state, [agent.id]: "start" }));
            setMutationErrors((state) => ({
                ...state,
                [agent.id]: undefined,
            }));
        },
        onSuccess: () => router.invalidate(),
        onError: (error, agent) => {
            setMutationErrors((state) => ({
                ...state,
                [agent.id]:
                    error instanceof Error
                        ? error.message
                        : "Failed to start agent",
            }));
        },
        onSettled: (_data, _error, agent) => {
            setMutations((state) => ({ ...state, [agent.id]: undefined }));
        },
    });
    const shutdownMutation = useMutation({
        mutationFn: (agent: Agent) => agent.shutdown(),
        onMutate: (agent) => {
            setMutations((state) => ({ ...state, [agent.id]: "shutdown" }));
            setMutationErrors((state) => ({
                ...state,
                [agent.id]: undefined,
            }));
        },
        onSuccess: async () => {
            setShutdownAgent(null);
            await router.invalidate();
        },
        onError: (error, agent) => {
            setMutationErrors((state) => ({
                ...state,
                [agent.id]:
                    error instanceof Error
                        ? error.message
                        : "Failed to shut down agent",
            }));
        },
        onSettled: (_data, _error, agent) => {
            setMutations((state) => ({ ...state, [agent.id]: undefined }));
        },
    });

    /** Starts one row without disabling unrelated lifecycle controls. */
    const start = (agent: Agent) => {
        startMutation.mutate(agent);
    };

    /** Confirms child cleanup before clearing the row-level shutdown state. */
    const confirmShutdown = () => {
        if (shutdownAgent === null) return;
        shutdownMutation.mutate(shutdownAgent);
    };

    return (
        <div className="p-8">
            <div className="mx-auto max-w-7xl">
                <h1 className="text-2xl font-bold text-slate-100">Agents</h1>
                <p className="mt-2 text-sm text-slate-400">
                    Manage TOML agents and observe external connections known
                    during this server run.
                </p>
                <AgentTable
                    agents={sortedAgents}
                    serverBinary={serverBinary}
                    now={now}
                    mutations={mutations}
                    mutationErrors={mutationErrors}
                    api={api}
                    router={router}
                    queryClient={queryClient}
                    onStart={start}
                    onShutdown={setShutdownAgent}
                />
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

/** Renders inventory separately so lifecycle state remains focused in the route component. */
function AgentTable(props: {
    agents: Agent[];
    serverBinary: { version: string; git_rev: string };
    now: ReturnType<typeof useNow>;
    mutations: MutationState;
    mutationErrors: Record<string, string | undefined>;
    api: ReturnType<typeof RootRoute.useRouteContext>["api"];
    router: ReturnType<typeof useRouter>;
    queryClient: ReturnType<typeof useQueryClient>;
    onStart: (agent: Agent) => void;
    onShutdown: (agent: Agent) => void;
}) {
    return (
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
                    {props.agents.map((agent) => (
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
                                {agent.managed ? "Managed (TOML)" : "External"}
                            </td>
                            <td className="px-4 py-3 capitalize">
                                {agent.status}
                            </td>
                            <td className="px-4 py-3">
                                <AgentVersionCell
                                    binary={agent.binary}
                                    serverVersion={props.serverBinary.version}
                                />
                            </td>
                            <td className="px-4 py-3">
                                <AgentRevCell
                                    binary={agent.binary}
                                    serverGitRev={props.serverBinary.git_rev}
                                />
                            </td>
                            <td className="px-4 py-3 text-slate-400">
                                {formatAgentRecency(agent, props.now)}
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
                                {props.mutationErrors[agent.id] ? (
                                    <span role="alert">
                                        {props.mutationErrors[agent.id]}
                                    </span>
                                ) : null}
                            </td>
                            <td className="px-4 py-3">
                                <AgentActionsMenu
                                    agent={agent}
                                    api={props.api}
                                    router={props.router}
                                    queryClient={props.queryClient}
                                    disabled={
                                        props.mutations[agent.id] !== undefined
                                    }
                                    onStart={props.onStart}
                                    onShutdown={props.onShutdown}
                                />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Keeps each anchored row menu local while the route owns lifecycle mutation state. */
function AgentActionsMenu(props: {
    agent: Agent;
    api: ReturnType<typeof RootRoute.useRouteContext>["api"];
    router: ReturnType<typeof useRouter>;
    queryClient: ReturnType<typeof useQueryClient>;
    disabled: boolean;
    onStart: (agent: Agent) => void;
    onShutdown: (agent: Agent) => void;
}) {
    return (
        <ActionMenu
            label="Actions"
            triggerAriaLabel={`Open actions for ${props.agent.name}`}
            title={`${props.agent.name} actions`}
            closeAriaLabel="Close agent actions"
            icon={<MoreHorizontal className="h-4 w-4" />}
            disabled={props.disabled}
            className="gap-1 rounded border border-slate-700 px-3 py-1.5"
        >
            {(close) => (
                <>
                    {props.agent.managed &&
                    (props.agent.status === "stopped" ||
                        props.agent.status === "disconnected") ? (
                        <ActionMenuButton
                            onClick={() => {
                                props.onStart(props.agent);
                                close();
                            }}
                        >
                            <Play className="h-4 w-4" /> Start
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.status === "connected" ? (
                        <ActionMenuButton asChild>
                            <RestartButton
                                target={`agent ${props.agent.name}`}
                                description="The agent will restart with the same arguments. In-flight transfers and terminals are interrupted."
                                restart={() => props.agent.restart()}
                                waitUntilReady={() =>
                                    waitForRestart(async () => {
                                        const restartedAgent = (
                                            await props.queryClient.fetchQuery({
                                                ...agentsQueryOptions(
                                                    props.api,
                                                ),
                                                staleTime: 0,
                                            })
                                        ).find(
                                            (entry: Agent) =>
                                                entry.id === props.agent.id &&
                                                entry.status === "connected" &&
                                                entry.connectionId !==
                                                    props.agent.connectionId,
                                        );
                                        if (!restartedAgent) {
                                            throw new Error(
                                                "Agent is still restarting",
                                            );
                                        }
                                        await props.router.invalidate();
                                    }, "Agent did not come back after restart")
                                }
                            />
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.managed &&
                    (props.agent.status === "starting" ||
                        props.agent.status === "connected") ? (
                        <ActionMenuButton
                            tone="danger"
                            onClick={() => {
                                props.onShutdown(props.agent);
                                close();
                            }}
                        >
                            <Power className="h-4 w-4" /> Shutdown
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.status === "connected" &&
                    props.agent.cwd !== null ? (
                        <ActionMenuButton asChild>
                            <Link
                                to={props.agent.getBrowserUrl(props.agent.cwd)}
                                onClick={close}
                            >
                                <FolderOpen className="h-4 w-4" /> Browse files
                            </Link>
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.configurationEditable ? (
                        <ActionMenuButton asChild>
                            <Link
                                to="/agents/$agentId/edit"
                                params={{ agentId: props.agent.id }}
                                onClick={close}
                            >
                                <Pencil className="h-4 w-4" /> Edit
                            </Link>
                        </ActionMenuButton>
                    ) : null}
                </>
            )}
        </ActionMenu>
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
