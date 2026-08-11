import * as React from "react";
import {
    createFileRoute,
    Link,
    Outlet,
    useRouter,
} from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
    Cpu,
    HardDrive,
    Clock,
    Server,
    User,
    Activity,
    FolderOpen,
    LoaderCircle,
    ScrollText,
    Package,
} from "lucide-react";
import {
    getBrowserUrl,
    type Agent,
    type BinaryIdentity,
    type ServerInfoResponse,
} from "#ui/api-client";
import type { AgentDetailsResponse } from "#bindings/AgentDetailsResponse";
import {
    agentStartStatesAtom,
    getStartErrorMessage,
} from "#ui/agent-start-state";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
} from "#ui/agent-tab-locations";
import { BinaryIdentityFields } from "#ui/components/binary-identity";
import { CopyablePath } from "#ui/components/copyable-code-row";
import { RouteError } from "#ui/components/route-error";
import { RestartButton, waitForRestart } from "#ui/components/restart-button";
import { UpgradeButton } from "#ui/components/upgrade-button";
import { formatAgentRecency, useNow } from "#ui/utils/agent-time";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/agents/$agentId/")({
    loader: async ({ params, parentMatchPromise }) => {
        const rootMatch = await parentMatchPromise;
        const agents = rootMatch.loaderData?.agents ?? [];
        const agent = agents.find((entry) => entry.id === params.agentId);
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);
        if (agent.status !== "connected") {
            return { kind: "lifecycle" as const, agent };
        }
        return {
            kind: "connected" as const,
            agent,
            details: await agent.getDetails(),
        };
    },
    component: AgentBoundary,
    errorComponent: RouteError,
});

/** Proves a force-installed agent loaded the exact executable running the server. */
function matchesServerIdentity(
    binary: BinaryIdentity,
    server: ServerInfoResponse,
): boolean {
    return (
        binary.git_rev === server.git_rev &&
        binary.git_dirty === server.git_dirty &&
        binary.version_dirty === server.version_dirty &&
        binary.build_mode === server.build_mode &&
        binary.build_date === server.build_date
    );
}

/** Renders retained lifecycle state without issuing connected-only commands prematurely. */
function AgentBoundary() {
    const data = Route.useLoaderData();
    if (data.kind === "connected") {
        return <AgentDetails agent={data.agent} details={data.details} />;
    }
    return <AgentLifecycle agent={data.agent} />;
}

/** Starts direct status-route visits idempotently and redirects successful startup to files. */
function AgentLifecycle(props: { agent: Agent }) {
    const router = useRouter();
    const startStates = useAtomValue(agentStartStatesAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const state = startStates[props.agent.id];
    const now = useNow();
    const shouldAppearStarting =
        props.agent.status === "starting" || state?.starting === true;

    const start = React.useCallback(() => {
        setStartStates((states) => ({
            ...states,
            [props.agent.id]: {
                starting: true,
                error: null,
                autoRedirect: true,
            },
        }));
        void props.agent
            .start()
            .then(() => router.invalidate())
            .catch((error: unknown) => {
                setStartStates((states) => ({
                    ...states,
                    [props.agent.id]: {
                        starting: false,
                        error: getStartErrorMessage(error),
                        autoRedirect: true,
                    },
                }));
            });
    }, [props.agent, router, setStartStates]);

    React.useEffect(() => {
        if (
            props.agent.managed &&
            (props.agent.status === "stopped" ||
                props.agent.status === "disconnected") &&
            state?.starting !== true &&
            state?.error === undefined
        ) {
            start();
        }
    }, [
        props.agent.managed,
        props.agent.status,
        start,
        state?.error,
        state?.starting,
    ]);

    const shutdown = () => {
        void props.agent.shutdown().then(() => {
            setStartStates((states) => {
                const next = { ...states };
                delete next[props.agent.id];
                return next;
            });
            return router.invalidate();
        });
    };

    return (
        <div className="flex h-full items-center justify-center p-8">
            <section aria-live="polite" className="max-w-xl text-center">
                {shouldAppearStarting ? (
                    <LoaderCircle className="mx-auto h-12 w-12 animate-spin text-blue-400" />
                ) : (
                    <HardDrive className="mx-auto h-12 w-12 text-slate-500" />
                )}
                <h1 className="mt-4 text-2xl font-semibold text-slate-100">
                    {shouldAppearStarting
                        ? `Starting ${props.agent.name}`
                        : props.agent.name}
                </h1>
                <p className="mt-2 text-slate-400">
                    {shouldAppearStarting
                        ? "The server is waiting for the agent connection."
                        : props.agent.managed
                          ? "This managed agent is stopped."
                          : "This external agent is currently disconnected."}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                    {formatAgentRecency(props.agent, now)}
                </p>
                {props.agent.connectionIssue ? (
                    <p
                        role="alert"
                        className="mt-4 whitespace-pre-wrap rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300"
                    >
                        {props.agent.connectionIssue}
                    </p>
                ) : null}
                {state?.error ? (
                    <p
                        role="alert"
                        className="mt-4 rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-300"
                    >
                        {state.error}
                    </p>
                ) : null}
                {props.agent.managed ? (
                    <div className="mt-6 flex justify-center gap-3">
                        <button
                            type="button"
                            onClick={start}
                            disabled={state?.starting === true}
                            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                            Retry Start
                        </button>
                        {shouldAppearStarting ? (
                            <button
                                type="button"
                                onClick={shutdown}
                                className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-white/5"
                            >
                                Shutdown
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </section>
        </div>
    );
}

/** Preserves the existing connected detail cards while displaying live connection duration. */
function AgentDetails(props: { agent: Agent; details: AgentDetailsResponse }) {
    const router = useRouter();
    const { api } = Route.useRouteContext();
    const { serverInfo } = RootRoute.useLoaderData();
    const startStates = useAtomValue(agentStartStatesAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const locations = useAtomValue(agentTabLocationsAtom);
    const now = useNow();
    const startState = startStates[props.agent.id];

    React.useEffect(() => {
        if (!startState?.autoRedirect || props.agent.cwd === null) return;
        const target = getAgentTabLocation(
            locations,
            props.agent.id,
            props.agent.getBrowserUrl(props.agent.cwd),
        );
        setStartStates((states) => {
            const next = { ...states };
            delete next[props.agent.id];
            return next;
        });
        void router.navigate({ to: target });
    }, [
        locations,
        props.agent,
        router,
        setStartStates,
        startState?.autoRedirect,
    ]);

    return (
        <div className="p-8">
            <div className="mx-auto max-w-4xl">
                <AgentDetailsHeader
                    agent={props.agent}
                    details={props.details}
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <DetailCard
                        title="Process Information"
                        icon={<Cpu className="h-5 w-5" />}
                    >
                        <DetailItem label="PID" value={props.details.pid} />
                        <DetailItem
                            label="Default Directory"
                            value={props.details.cwd}
                        />
                        <DetailPathItem
                            label="Config file"
                            value={
                                props.details.config_path ||
                                "No config file loaded"
                            }
                            copyAriaLabel="Copy config file path"
                            browserUrl={
                                props.details.config_path
                                    ? props.agent.getBrowserUrl(
                                          props.details.config_path,
                                      )
                                    : undefined
                            }
                        />
                        <DetailPathItem
                            label="Binary path"
                            value={props.details.exe_path}
                            copyAriaLabel="Copy binary path"
                        />
                    </DetailCard>
                    <DetailCard
                        title="System Load"
                        icon={<Activity className="h-5 w-5" />}
                    >
                        <DetailItem
                            label="1 min"
                            value={props.details.load_average_one.toFixed(2)}
                        />
                        <DetailItem
                            label="5 min"
                            value={props.details.load_average_five.toFixed(2)}
                        />
                        <DetailItem
                            label="15 min"
                            value={props.details.load_average_fifteen.toFixed(
                                2,
                            )}
                        />
                    </DetailCard>
                    <DetailCard
                        title="System Info"
                        icon={<Server className="h-5 w-5" />}
                    >
                        <DetailItem label="OS" value={props.details.os} />
                        <DetailItem
                            label="Architecture"
                            value={props.details.arch}
                        />
                        <DetailItem
                            label="Hostname"
                            value={props.details.hostname}
                        />
                        <DetailItem
                            label="External IP"
                            value={props.details.external_ip ?? "Unavailable"}
                        />
                    </DetailCard>
                    <DetailCard
                        title="User Info"
                        icon={<User className="h-5 w-5" />}
                    >
                        <DetailItem
                            label="Username"
                            value={props.details.username}
                        />
                    </DetailCard>
                    <DetailCard
                        title="Uptime"
                        icon={<Clock className="h-5 w-5" />}
                    >
                        <DetailItem
                            label="System"
                            value={formatUptime(props.details.system_uptime)}
                        />
                        <DetailItem
                            label="Connected"
                            value={formatAgentRecency(props.agent, now)}
                        />
                    </DetailCard>
                    <DetailCard
                        title="Binary"
                        icon={<Package className="h-5 w-5" />}
                    >
                        <div className="space-y-3">
                            <BinaryIdentityFields
                                binary={props.details.binary}
                                rowClassName="flex items-start gap-3"
                            />
                        </div>
                    </DetailCard>
                    <div className="md:col-span-2">
                        <UpgradeButton
                            target={`agent ${props.details.name}`}
                            agentOs={props.details.os}
                            agentArch={props.details.arch}
                            agentExePath={props.details.exe_path}
                            supportsSelfExec={props.agent.supportsSelfExec}
                            serverInfo={serverInfo}
                            upgrade={(targetVersion) =>
                                props.agent.upgrade(targetVersion)
                            }
                            forceInstallRunningBinary={() =>
                                props.agent.forceInstallRunningBinary()
                            }
                            waitUntilReady={(
                                targetVersion,
                                requireServerIdentity,
                            ) =>
                                waitForRestart(async () => {
                                    const upgradedAgent = (
                                        await api.listAgents()
                                    ).find(
                                        (agent) =>
                                            agent.id === props.agent.id &&
                                            agent.status === "connected" &&
                                            agent.connectionId !==
                                                props.agent.connectionId &&
                                            agent.binary?.version ===
                                                targetVersion,
                                    );
                                    if (!upgradedAgent?.binary) {
                                        throw new Error(
                                            "Agent is still upgrading",
                                        );
                                    }
                                    if (
                                        requireServerIdentity &&
                                        !matchesServerIdentity(
                                            upgradedAgent.binary,
                                            serverInfo,
                                        )
                                    ) {
                                        throw new Error(
                                            "Agent has not loaded the running server binary",
                                        );
                                    }
                                    await router.invalidate();
                                }, "Agent did not come back after upgrade")
                            }
                        />
                    </div>
                </div>
            </div>
            <Outlet />
        </div>
    );
}

/** Keeps restart controls isolated from the static detail cards and their data. */
function AgentDetailsHeader(props: {
    agent: Agent;
    details: AgentDetailsResponse;
}) {
    const router = useRouter();
    const { api } = Route.useRouteContext();

    return (
        <div className="mb-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h1
                    aria-label="Agent name"
                    className="flex min-w-0 items-center gap-3 text-2xl font-bold text-slate-100"
                >
                    <HardDrive className="h-8 w-8 shrink-0 text-blue-400" />
                    <span className="truncate">{props.details.name}</span>
                </h1>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <RestartButton
                        target={`agent ${props.details.name}`}
                        description="The agent will restart with the same arguments. In-flight transfers and terminals are interrupted."
                        restart={() => props.agent.restart()}
                        waitUntilReady={() =>
                            waitForRestart(async () => {
                                const restartedAgent = (
                                    await api.listAgents()
                                ).find(
                                    (agent) =>
                                        agent.id === props.agent.id &&
                                        agent.status === "connected" &&
                                        agent.connectionId !==
                                            props.agent.connectionId,
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
                    <Link
                        to="/agents/$agentId/logs"
                        params={{ agentId: props.details.id }}
                        className="flex items-center gap-2 rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-white/5"
                    >
                        <ScrollText className="h-4 w-4" /> View logs
                    </Link>
                    <Link
                        to={getBrowserUrl(props.details.id, props.details.cwd)}
                        className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
                    >
                        <FolderOpen className="h-4 w-4" /> Browse Files
                    </Link>
                </div>
            </div>
            <p className="mt-1 text-sm text-slate-500">
                ID: {props.details.id}
            </p>
        </div>
    );
}

/** Groups related detail values into a consistent visual card. */
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

/** Labels a detail value for both scanning and accessibility queries. */
function DetailItem(props: { label: string; value: string | number }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-slate-400">{props.label}:</span>
            <span
                aria-label={`Detail value for ${props.label}`}
                className="truncate font-mono text-xs text-slate-100"
            >
                {props.value}
            </span>
        </div>
    );
}

/** Labels a long path with horizontal scroll and an inline copy control. */
function DetailPathItem(props: {
    label: string;
    value: string;
    copyAriaLabel: string;
    browserUrl?: string;
}) {
    return (
        <div className="flex min-w-0 items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-slate-400">{props.label}:</span>
            <div className="min-w-0 flex-1">
                <CopyablePath
                    value={props.value}
                    copyAriaLabel={props.copyAriaLabel}
                    to={props.browserUrl}
                    linkAriaLabel={
                        props.browserUrl
                            ? `Open ${props.label.toLowerCase()} in file browser`
                            : undefined
                    }
                />
            </div>
        </div>
    );
}

/** Formats system uptime separately from the connection lifecycle clock. */
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
