import * as React from "react";
import {
    useMutation,
    useMutationState,
    useQuery,
    useQueryClient,
    useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useSetAtom } from "jotai";
import { MoreHorizontal, Pencil, Play, Power, FolderOpen } from "lucide-react";
import { agentStartStatesAtom } from "#ui/agent-start-state";
import type { Agent } from "#ui/api-client";
import { browserRoute, deviceRoute } from "#ui/browser-route";
import type { BinaryIdentity } from "#bindings/BinaryIdentity";
import type { ProtocolMismatchAttempt } from "#bindings/ProtocolMismatchAttempt";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import {
    fieldMatchTone,
    RevValue,
    VersionValue,
} from "#ui/components/binary-identity";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { DuplicateIdWarning } from "#ui/components/duplicate-id-warning";
import { AgentRestartButton } from "#ui/components/agent-restart-button";
import {
    agentsQueryOptions,
    protocolMismatchesQueryOptions,
    serverInfoQueryOptions,
} from "#ui/queries";
import { useAgents } from "#ui/use-agents";
import { sortAgentsByName } from "#ui/utils/agents";
import { formatAgentRecency, useNow } from "#ui/utils/agent-time";
import { getErrorMessage } from "#ui/utils/error";
import { startAgent } from "#ui/vault/ssh-key-vault";

export const Route = createFileRoute("/_app/agents/")({
    component: AgentManagement,
});

/** Scopes every start and shutdown request under one key so rows can observe them. */
const agentLifecycleMutationKey = ["agent-lifecycle"] as const;

/** Recovers the row a request belongs to from the untyped variables the mutation cache keeps. */
const agentLifecycleVariablesSchema = z.object({
    agent: z.object({ id: z.string() }),
    action: z.enum(["start", "shutdown"]),
});

/**
 * Derives per-row progress and failures from the mutation cache instead of mirroring them
 * in component state. A row's latest request decides its state, so a retry clears the
 * previous failure and an unrelated row's request never disturbs it.
 */
function useAgentLifecycleRequests() {
    const requests = useMutationState({
        filters: { mutationKey: agentLifecycleMutationKey },
        select: (mutation) => ({
            variables: agentLifecycleVariablesSchema.safeParse(
                mutation.state.variables,
            ),
            status: mutation.state.status,
            error: mutation.state.error,
            submittedAt: mutation.state.submittedAt,
        }),
    });

    const latestByAgent = new Map<
        string,
        { action: "start" | "shutdown"; status: string; error: unknown }
    >();

    const chronological = [...requests].sort(
        (left, right) => left.submittedAt - right.submittedAt,
    );

    for (const request of chronological) {
        if (!request.variables.success) continue;

        latestByAgent.set(request.variables.data.agent.id, {
            action: request.variables.data.action,
            status: request.status,
            error: request.error,
        });
    }

    const pending = new Map<string, "start" | "shutdown">();
    const errors = new Map<string, string>();

    for (const [agentId, request] of latestByAgent) {
        if (request.status === "pending") {
            pending.set(agentId, request.action);
        }

        if (request.status === "error") {
            errors.set(
                agentId,
                getErrorMessage(
                    request.error,
                    request.action === "start"
                        ? "Failed to start agent"
                        : "Failed to shut down agent",
                ),
            );
        }
    }

    return { pending, errors };
}

/** Lists retained inventory and scopes lifecycle mutation state to individual rows. */
function AgentManagement() {
    const queryClient = useQueryClient();
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const { api, vault } = Route.useRouteContext();
    const agents = useAgents();
    const { data: serverInfo } = useSuspenseQuery(serverInfoQueryOptions(api));

    const serverBinary = React.useMemo(
        () => ({
            version: serverInfo.version,
            git_rev: serverInfo.git_rev,
        }),
        [serverInfo.git_rev, serverInfo.version],
    );

    const sortedAgents = React.useMemo(
        () => sortAgentsByName(agents),
        [agents],
    );

    const now = useNow();
    const protocolMismatches = useQuery(protocolMismatchesQueryOptions(api));
    const lifecycle = useAgentLifecycleRequests();

    const [shutdownAgent, setShutdownAgent] = React.useState<Agent | null>(
        null,
    );

    const lifecycleMutation = useMutation({
        mutationKey: agentLifecycleMutationKey,
        // Unobserved requests are dropped at once so a failure never outlives the page.
        gcTime: 0,
        mutationFn: (request: { agent: Agent; action: "start" | "shutdown" }) =>
            // A device whose SSH key is encrypted with the vault asks for the vault first.
            request.action === "start"
                ? startAgent({ agent: request.agent, api, vault })
                : request.agent.shutdown(),
        onSuccess: async (_data, request) => {
            if (request.action === "shutdown") {
                setShutdownAgent(null);
                setStartStates((states) => {
                    const next = { ...states };
                    delete next[request.agent.id];

                    return next;
                });
            }

            await queryClient.invalidateQueries(agentsQueryOptions(api));
        },
    });

    /** Starts one row without disabling unrelated lifecycle controls. */
    const start = (agent: Agent) => {
        lifecycleMutation.mutate({ agent, action: "start" });
    };

    /** Confirms child cleanup before clearing the row-level shutdown state. */
    const confirmShutdown = () => {
        if (shutdownAgent === null) return;
        lifecycleMutation.mutate({ agent: shutdownAgent, action: "shutdown" });
    };

    return (
        <div className="p-8">
            <div className="mx-auto max-w-7xl">
                <h1 className="text-2xl font-bold text-slate-100">Devices</h1>
                <p className="mt-2 text-sm text-slate-400">
                    Manage configured devices and view devices whose agents were
                    started independently during this server run.
                </p>
                <AgentTable
                    agents={sortedAgents}
                    serverBinary={serverBinary}
                    now={now}
                    pendingAgentIds={lifecycle.pending}
                    mutationErrors={lifecycle.errors}
                    onStart={start}
                    onShutdown={setShutdownAgent}
                />
                {protocolMismatches.data &&
                protocolMismatches.data.attempts.length > 0 ? (
                    <ProtocolMismatchList
                        attempts={protocolMismatches.data.attempts}
                        serverProtocol={protocolMismatches.data.server_protocol}
                        serverVersion={serverInfo.version}
                    />
                ) : null}
            </div>
            <ConfirmationDialog
                isOpen={shutdownAgent !== null}
                title={
                    shutdownAgent
                        ? `Disconnect ${shutdownAgent.name}?`
                        : "Disconnect device?"
                }
                description="Stops the Redoor agent and disables automatic reconnection. Active transfers and terminals for this device will be interrupted."
                confirmLabel="Disconnect"
                busyLabel="Disconnecting…"
                isBusy={
                    shutdownAgent !== null &&
                    lifecycle.pending.get(shutdownAgent.id) === "shutdown"
                }
                errorMessage={
                    shutdownAgent
                        ? (lifecycle.errors.get(shutdownAgent.id) ?? null)
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
    pendingAgentIds: Map<string, "start" | "shutdown">;
    mutationErrors: Map<string, string>;
    onStart: (agent: Agent) => void;
    onShutdown: (agent: Agent) => void;
}) {
    return (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
                <thead className="bg-surface text-slate-400">
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
                            aria-label={`Device ${agent.name}`}
                            className="bg-chrome text-slate-200"
                        >
                            <td className="px-4 py-3">
                                <Link
                                    {...deviceRoute(
                                        agent,
                                        "/agents/$deviceName",
                                    )}
                                    className="font-medium text-blue-400 hover:underline"
                                >
                                    {agent.name}
                                </Link>
                            </td>
                            <td className="px-4 py-3">
                                {agent.managed
                                    ? "Managed by Redoor"
                                    : "Started independently"}
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
                                {agent.duplicateId ? (
                                    <DuplicateIdWarning
                                        warning={agent.duplicateId}
                                        compact
                                    />
                                ) : null}
                                {agent.connectionIssue ? (
                                    <span
                                        role="alert"
                                        className="whitespace-pre-wrap"
                                    >
                                        {agent.connectionIssue}
                                    </span>
                                ) : agent.duplicateId ? null : (
                                    "—"
                                )}
                                {props.mutationErrors.get(agent.id) ? (
                                    <span role="alert">
                                        {props.mutationErrors.get(agent.id)}
                                    </span>
                                ) : null}
                            </td>
                            <td className="px-4 py-3">
                                <AgentActionsMenu
                                    agent={agent}
                                    disabled={props.pendingAgentIds.has(
                                        agent.id,
                                    )}
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
    disabled: boolean;
    onStart: (agent: Agent) => void;
    onShutdown: (agent: Agent) => void;
}) {
    return (
        <ActionMenu
            label="Actions"
            triggerAriaLabel={`Open actions for ${props.agent.name}`}
            title={`${props.agent.name} actions`}
            closeAriaLabel="Close device actions"
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
                            <Play className="h-4 w-4" /> Connect
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.status === "connected" ? (
                        <ActionMenuButton asChild>
                            <AgentRestartButton agent={props.agent} />
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
                            <Power className="h-4 w-4" /> Disconnect
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.status === "connected" &&
                    props.agent.cwd !== null ? (
                        <ActionMenuButton asChild>
                            <Link
                                {...browserRoute(props.agent, props.agent.cwd)}
                                onClick={close}
                            >
                                <FolderOpen className="h-4 w-4" /> Browse files
                            </Link>
                        </ActionMenuButton>
                    ) : null}
                    {props.agent.configurationEditable ? (
                        <ActionMenuButton asChild>
                            <Link
                                {...deviceRoute(
                                    props.agent,
                                    "/agents/$deviceName/edit",
                                )}
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

/**
 * Lists agents the server refused because they speak another protocol version. Such agents
 * never register, so without this list they would only be visible in the server log.
 */
function ProtocolMismatchList(props: {
    attempts: ProtocolMismatchAttempt[];
    serverProtocol: string;
    serverVersion: string;
}) {
    return (
        <section
            aria-label="Refused agent connections"
            className="mt-8 rounded-lg border border-amber-700/60 bg-amber-950/20 p-4"
        >
            <h2 className="text-lg font-semibold text-amber-200">
                Refused agent connections
            </h2>
            <p className="mt-1 text-sm text-slate-300">
                These agents speak a different protocol than this server (
                {props.serverProtocol}). Upgrade them to the server&apos;s
                version {props.serverVersion} to connect them.
            </p>
            <table className="mt-4 w-full text-left text-sm">
                <thead className="text-slate-400">
                    <tr>
                        <th className="py-2 pr-4">When</th>
                        <th className="py-2 pr-4">Address</th>
                        <th className="py-2 pr-4">Agent version</th>
                        <th className="py-2 pr-4">Offered protocol</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                    {props.attempts.map((attempt) => (
                        <tr
                            key={`${attempt.remote_address}-${attempt.agent_version ?? ""}`}
                            aria-label={`Refused agent at ${attempt.remote_address}`}
                        >
                            <td className="py-2 pr-4">
                                {new Date(attempt.at).toLocaleString()}
                            </td>
                            <td className="py-2 pr-4 font-mono">
                                {attempt.remote_address}
                            </td>
                            <td className="py-2 pr-4">
                                {attempt.agent_version ?? "unknown"}
                            </td>
                            <td className="py-2 pr-4">
                                {attempt.offered_protocols.length > 0
                                    ? attempt.offered_protocols.join(", ")
                                    : "none"}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
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
