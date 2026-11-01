import type { ReactNode } from "react";
import { deviceRoute } from "#ui/browser-route";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtom } from "jotai";
import {
    AppWindow,
    FileCode2,
    Globe2,
    HardDrive,
    KeyRound,
    PanelRightOpen,
    Server,
} from "lucide-react";

import { useSuspenseQuery } from "@tanstack/react-query";

import type { Agent } from "#ui/api-client";
import { AgentStatusDot } from "#ui/components/agent-status-dot";
import { BinaryIdentityFields } from "#ui/components/binary-identity";
import { Button } from "#ui/components/button";
import { ChangePasswordButton } from "#ui/components/change-password-dialog";
import { ServerUpdateButton } from "#ui/components/server-update-button";
import { SignedInUser, useCurrentUser } from "#ui/components/signed-in-user";
import {
    CopyableCodeRow,
    CopyablePath,
} from "#ui/components/copyable-code-row";
import { Tooltip } from "#ui/components/tooltip";
import { serverInfoQueryOptions } from "#ui/queries";
import {
    openSideMenuAtom,
    sideMenuDrawerIds,
    usePersistentSideMenus,
} from "#ui/side-menu-state";
import { useAgents } from "#ui/use-agents";
import { sortAgentsByName } from "#ui/utils/agents";

export const Route = createFileRoute("/_app/")({
    component: Index,
});

/** Labeled path row that keeps long absolute paths scannable and copyable. */
function PathField(props: {
    icon: ReactNode;
    label: string;
    value: string;
    copyAriaLabel: string;
    bordered?: boolean;
}) {
    return (
        <div
            className={
                props.bordered
                    ? "flex items-start gap-3 border-t border-slate-800 pt-4"
                    : "flex items-start gap-3"
            }
        >
            <div className="mt-0.5 shrink-0 text-slate-400">{props.icon}</div>
            <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-slate-400">
                    {props.label}
                </h2>
                <div className="mt-1">
                    <CopyablePath
                        value={props.value}
                        copyAriaLabel={props.copyAriaLabel}
                    />
                </div>
            </div>
        </div>
    );
}

/** Distinguishes TOML-owned local/SSH agents from observation-only remotes. */
function agentOriginTooltip(agent: Agent): string {
    if (!agent.managed) {
        return "Agent started independently";
    }

    if (agent.sshTarget) {
        return `Managed by Redoor, SSH ${agent.sshTarget}`;
    }

    return "Managed by Redoor, local agent";
}

/** Packs known agent names into a dense wrap so several fit on one home row. */
function AgentNameGrid(props: { agents: Agent[] }) {
    const sortedAgents = sortAgentsByName(props.agents);

    return (
        <section aria-label="Device names" className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-slate-400">Devices</h2>
            {sortedAgents.length === 0 ? (
                <p className="text-sm text-slate-500">No devices</p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {sortedAgents.map((agent) => (
                        <Tooltip
                            key={agent.id}
                            content={`Open ${agent.name} (${agentOriginTooltip(agent)})`}
                        >
                            <Link
                                {...deviceRoute(agent, "/agents/$deviceName")}
                                className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-surface px-2 py-0.5 text-sm text-slate-200 hover:border-slate-600 hover:bg-tint"
                            >
                                <AgentStatusDot agent={agent} />
                                {agent.name}
                            </Link>
                        </Tooltip>
                    ))}
                </div>
            )}
            <OpenAgentSidebarButton />
        </section>
    );
}

/** Offers the agent drawer only when the persistent right sidebar is not already on screen. */
function OpenAgentSidebarButton() {
    const canToggleSidebar = !usePersistentSideMenus();
    const [openMenu, setOpenMenu] = useAtom(openSideMenuAtom);

    if (!canToggleSidebar) {
        return null;
    }

    return (
        <Button
            tooltip="Open device sidebar"
            type="button"
            variant="subtle"
            aria-label="Open device sidebar"
            aria-haspopup="dialog"
            aria-controls={sideMenuDrawerIds.agents}
            aria-expanded={openMenu === "agents"}
            onClick={() => setOpenMenu("agents")}
            className="mt-2 inline-flex items-center gap-1.5 rounded border border-slate-800 bg-surface px-2 py-0.5 text-sm font-normal text-slate-200 hover:border-slate-600 hover:bg-tint"
        >
            <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            Device menu
        </Button>
    );
}

/** Shows a compact agent name grid first, then server identity and runtime details. */
function Index() {
    const { api } = Route.useRouteContext();
    const agents = useAgents();
    const { data: serverInfo } = useSuspenseQuery(serverInfoQueryOptions(api));
    const user = useCurrentUser();

    const serverProtocol =
        window.location.protocol === "https:" ? "https:" : "http:";

    const serverAddress = `${serverProtocol}//${window.location.host}`;

    // A self-signed certificate cannot be verified, so a pasted config must opt out.
    const insecureTls = serverInfo.self_signed_tls
        ? `insecure_tls = true
`
        : "";

    const agentConfig = `agent_token = ${JSON.stringify(serverInfo.agent_token)}

[agent]
server = ${JSON.stringify(serverAddress)}
${insecureTls}`;

    return (
        <div className="p-8">
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center gap-3">
                    <Server className="h-6 w-6 text-blue-400" />
                    <h1 className="text-2xl font-bold text-slate-100">
                        Server
                    </h1>
                </div>
                <AgentNameGrid agents={agents} />
                <div className="space-y-4 rounded-lg border border-slate-800 bg-surface p-6">
                    <div className="flex items-start gap-3">
                        <AppWindow className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                App name
                            </h2>
                            <p className="mt-1 font-mono text-xs text-slate-100">
                                {serverInfo.app_name}
                            </p>
                        </div>
                    </div>
                    <PathField
                        icon={<FileCode2 className="h-5 w-5" />}
                        label="Config file"
                        value={serverInfo.config_path}
                        copyAriaLabel="Copy config file path"
                        bordered
                    />
                    <PathField
                        icon={<HardDrive className="h-5 w-5" />}
                        label="Binary path"
                        value={serverInfo.exe_path}
                        copyAriaLabel="Copy binary path"
                        bordered
                    />
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                External IP
                            </h2>
                            <p className="mt-1 font-mono text-xs text-slate-100">
                                {serverInfo.external_ip ?? "Unavailable"}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 border-t border-slate-800 pt-4">
                        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                        <div className="min-w-0 flex-1">
                            <h2 className="text-sm font-medium text-slate-400">
                                Authentication
                            </h2>
                            {user ? (
                                <SignedInUser user={user} className="mt-1" />
                            ) : null}
                            {/* OIDC passwords belong to the identity provider. */}
                            {user?.method === "password" ? (
                                <div className="mt-2">
                                    <ChangePasswordButton />
                                </div>
                            ) : null}
                        </div>
                    </div>
                    <BinaryIdentityFields
                        binary={{
                            version: serverInfo.version,
                            git_rev: serverInfo.git_rev,
                            git_dirty: serverInfo.git_dirty,
                            version_dirty: serverInfo.version_dirty,
                            build_mode: serverInfo.build_mode,
                            build_date: serverInfo.build_date,
                        }}
                        versionAction={
                            <ServerUpdateButton
                                currentVersion={serverInfo.version}
                                exePath={serverInfo.exe_path}
                            />
                        }
                    />
                </div>
                <div className="mt-6">
                    <div className="mb-3">
                        <h2 className="text-lg font-semibold text-slate-100">
                            Connect a device
                        </h2>
                        <p className="mt-1 text-sm text-slate-400">
                            Save this as config.toml on the device and run{" "}
                            <code className="font-mono text-slate-200">
                                redoor agent --config config.toml
                            </code>
                            . The device name defaults to its hostname.
                        </p>
                    </div>
                    <CopyableCodeRow
                        label="config.toml"
                        value={agentConfig}
                        copyAriaLabel="Copy agent config"
                        multiline
                    />
                </div>
            </div>
        </div>
    );
}
