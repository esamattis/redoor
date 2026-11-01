import * as React from "react";
import {
    useQuery,
    useQueryClient,
    useSuspenseQuery,
} from "@tanstack/react-query";
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
import { type Agent } from "#ui/api-client";
import { browserRoute, deviceRoute } from "#ui/browser-route";
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
import {
    CopyableCodeRow,
    CopyablePath,
} from "#ui/components/copyable-code-row";
import { DetailCard } from "#ui/components/detail-card";
import { DuplicateIdWarning } from "#ui/components/duplicate-id-warning";
import { LinkButton } from "#ui/components/link-button";
import { AgentRestartButton } from "#ui/components/agent-restart-button";
import { UpgradeButton } from "#ui/components/upgrade-button";
import {
    AgentUpgradeStatus,
    isUpgradeInProgress,
} from "#ui/components/agent-upgrade-status";
import { provisioningStatusStoreAtom } from "#ui/provisioning-status";
import { RouteError } from "#ui/components/route-error";
import {
    agentDetailsQueryOptions,
    agentUpgradeQueryOptions,
    queryKeys,
    serverInfoQueryOptions,
} from "#ui/queries";
import { useRouteAgent } from "#ui/use-active-agent";
import { formatAgentRecency, useNow } from "#ui/utils/agent-time";
import { formatSize } from "#ui/utils/path";

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

export const Route = createFileRoute("/_app/agents/$deviceName/")({
    component: AgentBoundary,
});

/**
 * Chooses between retained lifecycle state and live details from the inventory itself, so
 * the page follows a connect or disconnect without reloading the route.
 */
function AgentBoundary() {
    const agent = useRouteAgent();

    if (agent.status === "connected") {
        return <AgentDetails agent={agent} />;
    }

    return (
        <>
            {/* The agent drops its connection while an upgrade restarts it, which swaps the
                details for this view, so the upgrade's progress is shown here too. */}
            <AgentUpgradeStatus
                agent={agent}
                className="mx-auto max-w-4xl px-8 pt-8"
            />
            {agent.duplicateId ? (
                <div className="mx-auto max-w-4xl px-8 pt-8">
                    <DuplicateIdWarning warning={agent.duplicateId} />
                </div>
            ) : null}
            <AgentLifecycle agent={agent} />
        </>
    );
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
        <div className="@2xl:col-span-2">
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

/**
 * Loads the connected-only details, which are not cached yet when the agent has just
 * connected on this page, before rendering the cards that depend on them.
 */
function AgentDetails(props: { agent: Agent }) {
    const detailsQuery = useQuery(agentDetailsQueryOptions(props.agent));

    if (detailsQuery.data) {
        return (
            <AgentDetailsContent
                agent={props.agent}
                details={detailsQuery.data}
            />
        );
    }

    if (detailsQuery.isError) {
        return <RouteError error={detailsQuery.error} />;
    }

    return (
        <p role="status" className="p-8 text-sm text-slate-400">
            Loading device details...
        </p>
    );
}

/** Preserves the existing connected detail cards while displaying live connection duration. */
function AgentDetailsContent(props: {
    agent: Agent;
    details: AgentDetailsResponse;
}) {
    const router = useRouter();
    const startStates = useAtomValue(agentStartStatesAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const locations = useAtomValue(agentTabLocationsAtom);
    const storedProvisioningById = useAtomValue(provisioningStatusStoreAtom);
    const now = useNow();
    const startState = startStates[props.agent.id];
    const configPath = props.details.config_path || "No config file loaded";
    const storedProvisioning = storedProvisioningById[props.agent.id] ?? [];

    const provisioningNowMs =
        props.agent.connectedAt !== null ? props.agent.connectedAt * 1000 : now;

    // Navigation here follows the agent becoming connected, which arrives as a pushed
    // inventory change after the start request has returned. No mutation or loader runs at
    // that moment, so the page that is already showing the details has to react to it.
    React.useEffect(() => {
        if (!startState?.autoRedirect || props.agent.cwd === null) return;

        const targetPath = getAgentTabLocation(
            locations,
            props.agent.id,
            props.agent.cwd,
        );

        setStartStates((states) => {
            const next = { ...states };
            delete next[props.agent.id];

            return next;
        });

        // The router keeps this page rendered while the next page's loader runs, so the
        // details can arrive after the user has already clicked elsewhere, such as the edit
        // link. Redirecting then would replace the page they chose with the file browser,
        // so the redirect only happens while no other navigation is on its way.
        const userNavigatedAway =
            router.latestLocation.href !== router.state.resolvedLocation?.href;

        if (userNavigatedAway) return;

        void router.navigate(browserRoute(props.agent, targetPath));
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
                <AgentUpgradeStatus agent={props.agent} className="mb-6" />
                <AgentDetailsHeader
                    agent={props.agent}
                    details={props.details}
                />
                <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
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
                            browserLink={
                                props.details.config_path
                                    ? browserRoute(
                                          props.agent,
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

/** Keeps the upgrade controls out of the details grid so the page stays under the line limit. */
function AgentUpgradeControls(props: {
    agent: Agent;
    details: AgentDetailsResponse;
}) {
    const { api } = Route.useRouteContext();
    const queryClient = useQueryClient();
    const { data: serverInfo } = useSuspenseQuery(serverInfoQueryOptions(api));
    const upgradeQuery = useQuery(agentUpgradeQueryOptions(props.agent));

    return (
        <div className="@2xl:col-span-2">
            <UpgradeButton
                target={`agent ${props.agent.name}`}
                agentOs={props.details.os}
                agentArch={props.details.arch}
                agentExePath={props.details.exe_path}
                serverInfo={serverInfo}
                isUpgrading={isUpgradeInProgress(upgradeQuery.data?.job)}
                upgrade={(targetVersion) => props.agent.upgrade(targetVersion)}
                forceInstallRunningBinary={() =>
                    props.agent.forceInstallRunningBinary()
                }
                onStarted={() =>
                    void queryClient.invalidateQueries({
                        queryKey: queryKeys.agentUpgrade(props.agent.id),
                    })
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
            className="overflow-hidden rounded-lg border border-slate-800 bg-surface @2xl:col-span-2"
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
                                            {...browserRoute(
                                                props.agent,
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
    return (
        <div className="mb-6">
            <div className="flex flex-col gap-3 @xl:flex-row @xl:items-center @xl:justify-between">
                <h1
                    aria-label="Device name"
                    className="flex min-w-0 items-center gap-3 text-2xl font-bold text-slate-100"
                >
                    <HardDrive className="h-8 w-8 shrink-0 text-blue-400" />
                    <span className="truncate">{props.agent.name}</span>
                </h1>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <AgentRestartButton agent={props.agent} />
                    <LinkButton
                        {...deviceRoute(
                            props.agent,
                            "/agents/$deviceName/logs",
                        )}
                        variant="secondary"
                    >
                        <ScrollText className="h-4 w-4" /> View logs
                    </LinkButton>
                    <LinkButton
                        {...browserRoute(props.agent, props.details.cwd)}
                    >
                        <FolderOpen className="h-4 w-4" /> Browse Files
                    </LinkButton>
                </div>
            </div>
            {/* Scripts that must stay on this device across renames address it by id. */}
            <div className="mt-4 max-w-xl">
                <CopyableCodeRow
                    label="Device ID"
                    value={props.agent.id}
                    copyAriaLabel="Copy device id"
                />
            </div>
            {props.agent.duplicateId ? (
                <div className="mt-4">
                    <DuplicateIdWarning warning={props.agent.duplicateId} />
                </div>
            ) : null}
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
    browserLink?: ReturnType<typeof browserRoute>;
}) {
    return (
        <div className="flex min-w-0 items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-slate-400">{props.label}:</span>
            <div className="min-w-0 flex-1">
                <CopyablePath
                    value={props.value}
                    copyAriaLabel={props.copyAriaLabel}
                    link={props.browserLink}
                    linkAriaLabel={
                        props.browserLink
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
