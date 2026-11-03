import { Link } from "@tanstack/react-router";
import {
    ChevronLeft,
    ChevronRight,
    FolderOpen,
    HardDrive,
    Pencil,
    ScrollText,
} from "lucide-react";

import type { Agent } from "#ui/api-client";
import { browserRoute, deviceRoute } from "#ui/browser-route";
import {
    agentLifecycleLabel,
    AgentPowerControls,
    useAgentLifecyclePhase,
} from "#ui/components/agent-lifecycle";
import { AgentRestartButton } from "#ui/components/agent-restart-button";
import { AgentStatusDot } from "#ui/components/agent-status-dot";
import { CopyablePath } from "#ui/components/copyable-code-row";
import { DuplicateIdWarning } from "#ui/components/duplicate-id-warning";
import { LinkButton } from "#ui/components/link-button";
import { Tooltip } from "#ui/components/tooltip";
import {
    formatAgentRecency,
    formatElapsed,
    useNow,
} from "#ui/utils/agent-time";

/**
 * Heads the device home in every lifecycle state, so the device's name, its state and what
 * can be done with it stay in the same place whether it is connected or not. Browsing files
 * is what the device is used for, so it leads as the only primary action; while the device
 * is down, connecting it takes that place. Starting and stopping, restarting, editing and
 * the logs follow as secondary actions.
 */
export function DeviceHeader(props: { agent: Agent }) {
    const phase = useAgentLifecyclePhase(props.agent);
    const now = useNow();

    // Stopped TOML homes can be relative; only connected resolved paths are browser URLs.
    const browseHome =
        props.agent.status === "connected" ? props.agent.cwd : null;

    // "Connected · Connected for 3h" would repeat itself, so a connected device only says
    // how long; every other state keeps the recency wording, such as "Last seen 5m ago".
    const recency =
        phase === "connected" && props.agent.connectedAt !== null
            ? `for ${formatElapsed(now / 1000 - props.agent.connectedAt)}`
            : formatAgentRecency(props.agent, now);

    return (
        <div className="mb-6 space-y-4">
            <div className="flex min-w-0 items-start gap-3">
                <HardDrive
                    className="mt-0.5 h-8 w-8 shrink-0 text-blue-400"
                    aria-hidden="true"
                />
                <div className="min-w-0">
                    <h1
                        aria-label="Device name"
                        className="truncate text-2xl font-bold text-slate-100"
                    >
                        {props.agent.name}
                    </h1>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-400">
                        <AgentStatusDot agent={props.agent} />
                        <span
                            role="status"
                            aria-label="Connection status"
                            className="font-medium text-slate-200"
                        >
                            {agentLifecycleLabel(phase, props.agent)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{recency}</span>
                    </p>
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {browseHome === null ? null : (
                    <LinkButton
                        {...browserRoute(props.agent, browseHome)}
                        size="lg"
                        className="@max-xl:w-full"
                    >
                        <FolderOpen className="h-4 w-4" aria-hidden="true" />
                        Browse files
                    </LinkButton>
                )}
                <AgentPowerControls agent={props.agent} />
                {props.agent.status === "connected" ? (
                    <AgentRestartButton agent={props.agent} />
                ) : null}
                {props.agent.configurationEditable ? (
                    <Tooltip content="Change how the server connects to this device">
                        <LinkButton
                            {...deviceRoute(
                                props.agent,
                                "/agents/$deviceName/edit",
                            )}
                            variant="secondary"
                        >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            Edit
                        </LinkButton>
                    </Tooltip>
                ) : null}
                {browseHome === null ? null : (
                    <Tooltip content="Read the log of the Redoor agent on this device">
                        <LinkButton
                            {...deviceRoute(
                                props.agent,
                                "/agents/$deviceName/logs",
                            )}
                            variant="secondary"
                        >
                            <ScrollText
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            View logs
                        </LinkButton>
                    </Tooltip>
                )}
            </div>
            {/* Scripts that must stay on this device across renames address it by id. */}
            <div className="flex min-w-0 items-center gap-3 text-sm @xl:max-w-md">
                <span className="shrink-0 text-slate-400">Device ID</span>
                <div className="min-w-0 flex-1">
                    <CopyablePath
                        value={props.agent.id}
                        valueAriaLabel="Device ID contents"
                        copyAriaLabel="Copy device id"
                    />
                </div>
            </div>
            {props.agent.duplicateId ? (
                <DuplicateIdWarning warning={props.agent.duplicateId} />
            ) : null}
        </div>
    );
}

/**
 * Shows that a device sub-page, such as its configuration, belongs to the device, and leads
 * back to the device home in one tap. The top bar tabs can do the same, but they are easy
 * to miss on a form the user reached from the sidebar's edit button.
 */
export function DeviceBreadcrumb(props: { agent: Agent; current: string }) {
    return (
        <nav aria-label="Breadcrumb" className="mb-4 min-w-0">
            <ol className="flex min-w-0 items-center gap-1 text-sm">
                <li className="min-w-0">
                    <Tooltip content={`Back to the ${props.agent.name} home`}>
                        <Link
                            {...deviceRoute(props.agent, "/agents/$deviceName")}
                            className="-ml-2 flex min-w-0 items-center gap-1.5 rounded px-2 py-2 font-medium text-blue-400 hover:bg-tint hover:text-blue-300"
                        >
                            <ChevronLeft
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                            <HardDrive
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                            <span className="truncate">{props.agent.name}</span>
                        </Link>
                    </Tooltip>
                </li>
                <li aria-hidden="true">
                    <ChevronRight className="h-4 w-4 text-slate-600" />
                </li>
                <li aria-current="page" className="shrink-0 text-slate-300">
                    {props.current}
                </li>
            </ol>
        </nav>
    );
}
