import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
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
    ListOrdered,
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
import { agentStartStatesAtom } from "#ui/agent-start-state";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
} from "#ui/agent-tab-locations";
import {
    AgentLifecycle,
    ProvisioningStatusList,
} from "#ui/components/agent-lifecycle";
import { BinaryIdentityFields } from "#ui/components/binary-identity";
import { CopyablePath } from "#ui/components/copyable-code-row";
import { RestartButton, waitForRestart } from "#ui/components/restart-button";
import { UpgradeButton } from "#ui/components/upgrade-button";
import { provisioningStatusStoreAtom } from "#ui/provisioning-status";
import { agentsQueryOptions } from "#ui/queries";
import { formatAgentRecency, useNow } from "#ui/utils/agent-time";
import { formatSize } from "#ui/utils/path";
import { Route as RootRoute } from "./__root";
import { Route as AgentRoute } from "./agents.$agentId";

const HIDDEN_MOUNT_TYPES = new Set([
    "devpts",
    "devtmpfs",
    "proc",
    "fuse.lxcfs",
    "sysfs",
    "efivarfs",
    "cgroup2",
    "fusectl",
    "pstore",
    "debugfs",
    "securityfs",
    "tmpfs",
    "mqueue",
    "binfmt_misc",
]);

export const Route = createFileRoute("/agents/$agentId/")({
    component: AgentBoundary,
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
    const data = AgentRoute.useLoaderData();
    if (data.kind === "connected") {
        return <AgentDetails agent={data.agent} details={data.details} />;
    }
    return <AgentLifecycle agent={data.agent} />;
}

/** Shows the last remembered start attempt after the lifecycle page unmounts. */
function LastProvisioningCard(props: {
    messages: Agent["provisioningStatus"];
    nowMs: number;
}) {
    if (props.messages.length === 0) {
        return null;
    }
    return (
        <div className="md:col-span-2">
            <DetailCard
                title="provisioning history"
                icon={<ListOrdered className="h-5 w-5" />}
            >
                <ProvisioningStatusList
                    messages={props.messages}
                    nowMs={props.nowMs}
                />
            </DetailCard>
        </div>
    );
}

/** Preserves the existing connected detail cards while displaying live connection duration. */
function AgentDetails(props: { agent: Agent; details: AgentDetailsResponse }) {
    const router = useRouter();
    const startStates = useAtomValue(agentStartStatesAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const locations = useAtomValue(agentTabLocationsAtom);
    const storedProvisioningByName = useAtomValue(provisioningStatusStoreAtom);
    const now = useNow();
    const startState = startStates[props.agent.id];
    const configPath = props.details.config_path || "No config file loaded";
    const storedProvisioning = storedProvisioningByName[props.agent.name] ?? [];
    const provisioningNowMs =
        props.agent.connectedAt !== null ? props.agent.connectedAt * 1000 : now;

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
                        title="Redoor agent"
                        icon={<Cpu className="h-5 w-5" />}
                    >
                        <DetailItem label="PID" value={props.details.pid} />
                        <DetailItem
                            label="Default Directory"
                            value={props.details.cwd}
                        />
                        <DetailPathItem
                            label="Config file"
                            value={configPath}
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
                    <MountPoints
                        agent={props.agent}
                        mountPoints={props.details.mount_points}
                    />
                    <LastProvisioningCard
                        messages={storedProvisioning}
                        nowMs={provisioningNowMs}
                    />
                    <AgentUpgradeControls
                        agent={props.agent}
                        details={props.details}
                    />
                </div>
            </div>
            <Outlet />
        </div>
    );
}

/** Keeps upgrade waiting out of the details grid so the home page stays under the line limit. */
function AgentUpgradeControls(props: {
    agent: Agent;
    details: AgentDetailsResponse;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { api } = Route.useRouteContext();
    const { serverInfo } = RootRoute.useLoaderData();
    return (
        <div className="md:col-span-2">
            <UpgradeButton
                target={`agent ${props.details.name}`}
                agentOs={props.details.os}
                agentArch={props.details.arch}
                agentExePath={props.details.exe_path}
                supportsSelfExec={props.agent.supportsSelfExec}
                serverInfo={serverInfo}
                upgrade={(targetVersion) => props.agent.upgrade(targetVersion)}
                forceInstallRunningBinary={() =>
                    props.agent.forceInstallRunningBinary()
                }
                waitUntilReady={(targetVersion, requireServerIdentity) =>
                    waitForRestart(async () => {
                        const upgradedAgent = (
                            await queryClient.fetchQuery({
                                ...agentsQueryOptions(api),
                                staleTime: 0,
                            })
                        ).find(
                            (agent) =>
                                agent.id === props.agent.id &&
                                agent.status === "connected" &&
                                agent.connectionId !==
                                    props.agent.connectionId &&
                                agent.binary?.version === targetVersion,
                        );
                        if (!upgradedAgent?.binary) {
                            throw new Error("Agent is still upgrading");
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
    );
}

/** Presents every mounted filesystem with capacity and a direct browser destination. */
function MountPoints(props: {
    agent: Agent;
    mountPoints: AgentDetailsResponse["mount_points"];
}) {
    return (
        <section
            aria-labelledby="mount-points-heading"
            className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] md:col-span-2"
        >
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 font-semibold text-slate-300">
                <HardDrive className="h-5 w-5" />
                <h2
                    id="mount-points-heading"
                    className="text-sm uppercase tracking-wide"
                >
                    Mount Points
                </h2>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th scope="col" className="px-4 py-2 font-medium">
                                Path
                            </th>
                            <th scope="col" className="px-4 py-2 font-medium">
                                Used / Available
                            </th>
                            <th scope="col" className="px-4 py-2 font-medium">
                                Type
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                        {props.mountPoints
                            .filter(
                                (mountPoint) =>
                                    mountPoint.mount_type === null ||
                                    !HIDDEN_MOUNT_TYPES.has(
                                        mountPoint.mount_type,
                                    ),
                            )
                            .map((mountPoint) => (
                                <tr key={mountPoint.path}>
                                    <td className="max-w-md px-4 py-2.5">
                                        <Link
                                            to={props.agent.getBrowserUrl(
                                                mountPoint.path,
                                            )}
                                            aria-label={`Browse mount point ${mountPoint.path}`}
                                            className="block truncate font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline"
                                        >
                                            {mountPoint.path}
                                        </Link>
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-200">
                                        {formatUsedCapacity(
                                            mountPoint.total_bytes,
                                            mountPoint.available_bytes,
                                        )}{" "}
                                        /{" "}
                                        {formatCapacity(
                                            mountPoint.available_bytes,
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-300">
                                        {mountPoint.mount_type ?? "Unavailable"}
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

/** Keeps unavailable platform capacity distinct from a real zero-byte value. */
function formatCapacity(bytes: number | null): string {
    return bytes === null ? "Unavailable" : formatSize(bytes);
}

/** Derives consumed capacity without presenting unavailable totals as real usage. */
function formatUsedCapacity(
    totalBytes: number | null,
    availableBytes: number | null,
): string {
    if (totalBytes === null || availableBytes === null) return "Unavailable";
    return formatSize(Math.max(0, totalBytes - availableBytes));
}

/** Keeps restart controls isolated from the static detail cards and their data. */
function AgentDetailsHeader(props: {
    agent: Agent;
    details: AgentDetailsResponse;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { api } = Route.useRouteContext();

    return (
        <div className="mb-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h1
                    aria-label="Device name"
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
                                    await queryClient.fetchQuery({
                                        ...agentsQueryOptions(api),
                                        staleTime: 0,
                                    })
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
