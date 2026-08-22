import type { ReactNode } from "react";
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

import type { Agent, ServerAuthMode } from "#ui/api-client";
import { BinaryIdentityFields } from "#ui/components/binary-identity";
import { Button } from "#ui/components/button";
import {
    CopyableCodeRow,
    CopyablePath,
} from "#ui/components/copyable-code-row";
import { Tooltip } from "#ui/components/tooltip";
import { openSideMenuAtom, usePersistentSideMenus } from "#ui/side-menu-state";
import { Route as RootRoute } from "./__root";

export const Route = createFileRoute("/")({
    component: Index,
});

/** Human-readable label for the configured browser login backend. */
function authModeLabel(authMode: ServerAuthMode): string {
    switch (authMode) {
        case "toml":
            return "TOML (username/password in config file)";
        case "pam":
            return "PAM (system account)";
    }
}

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

/** Maps lifecycle and diagnostics onto the three colors the home chips can show. */
function agentStatusDotClass(agent: Agent): string {
    if (agent.connectionIssue) {
        return "bg-red-500";
    }
    if (agent.status === "connected") {
        return "bg-emerald-500";
    }
    return "bg-amber-400";
}

/** Distinguishes TOML-owned local/SSH agents from observation-only remotes. */
function agentOriginTooltip(agent: Agent): string {
    if (!agent.managed) {
        return "Remote";
    }
    if (agent.sshTarget) {
        return `Managed, ssh ${agent.sshTarget}`;
    }
    return "Managed, local";
}

/** Packs known agent names into a dense wrap so several fit on one home row. */
function AgentNameGrid(props: { agents: Agent[] }) {
    const sortedAgents = [...props.agents].sort(
        (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
    );

    return (
        <section aria-label="Agent names" className="mb-6">
            <h2 className="mb-2 text-sm font-medium text-slate-400">Agents</h2>
            {sortedAgents.length === 0 ? (
                <p className="text-sm text-slate-500">No agents</p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {sortedAgents.map((agent) => (
                        <Tooltip
                            key={agent.id}
                            content={agentOriginTooltip(agent)}
                        >
                            <Link
                                to="/agents/$agentId"
                                params={{ agentId: agent.id }}
                                className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#11141b] px-2 py-0.5 text-sm text-slate-200 hover:border-slate-600 hover:bg-white/5"
                            >
                                <span
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${agentStatusDotClass(agent)}`}
                                    aria-hidden="true"
                                />
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
        <Tooltip content="Open agent sidebar">
            <Button
                type="button"
                variant="subtle"
                aria-label="Open agent sidebar"
                aria-haspopup="dialog"
                aria-controls="agent-menu-drawer"
                aria-expanded={openMenu === "agents"}
                onClick={() => setOpenMenu("agents")}
                className="mt-2 inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#11141b] px-2 py-0.5 text-sm font-normal text-slate-200 hover:border-slate-600 hover:bg-white/5"
            >
                <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
                Agent menu
            </Button>
        </Tooltip>
    );
}

/** Shows a compact agent name grid first, then server identity and runtime details. */
function Index() {
    const { agents, serverInfo } = RootRoute.useLoaderData();
    const serverProtocol =
        window.location.protocol === "https:" ? "https:" : "http:";
    const serverAddress = `${serverProtocol}//${window.location.host}`;
    const agentConfig = `agent_token = ${JSON.stringify(serverInfo.agent_token)}

[agent]
server = ${JSON.stringify(serverAddress)}
`;

    return (
        <div className="p-8">
            <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-center gap-3">
                    <Server className="h-6 w-6 text-slate-400" />
                    <h1 className="text-2xl font-semibold text-slate-100">
                        Server
                    </h1>
                </div>
                <AgentNameGrid agents={agents} />
                <div className="space-y-4 rounded-lg border border-slate-800 bg-[#11141b] p-6">
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
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-slate-400">
                                Authentication
                            </h2>
                            <p className="mt-1 text-sm text-slate-100">
                                {authModeLabel(serverInfo.auth_mode)}
                            </p>
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
                    />
                </div>
                <div className="mt-6">
                    <div className="mb-3">
                        <h2 className="text-lg font-semibold text-slate-100">
                            Connect an agent
                        </h2>
                        <p className="mt-1 text-sm text-slate-400">
                            Save this as config.toml and run{" "}
                            <code className="font-mono text-slate-200">
                                redoor agent --config config.toml
                            </code>
                            . The agent uses the computer hostname as its name.
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
