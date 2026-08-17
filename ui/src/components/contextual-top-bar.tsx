import { Link } from "@tanstack/react-router";
import {
    Files,
    HardDrive,
    PanelLeftOpen,
    PanelRightOpen,
    ScrollText,
    Settings,
} from "lucide-react";
import type * as React from "react";

import type { Agent } from "#ui/api-client";
import { IconButton } from "#ui/components/icon-button";
import {
    getViewSwitchItemClass,
    ViewSwitch,
} from "#ui/components/browser/navigation";
import { ThemeToggle } from "#ui/components/theme-toggle";

export type AgentViewContext =
    | { kind: "agent"; agent: Agent }
    | { kind: "logs"; agent: Agent }
    | { kind: "configuration"; agent: Agent }
    | { kind: "directory"; agent: Agent; path: string }
    | { kind: "file"; agent: Agent; path: string }
    | null;

/** Turns the global top slot into route-specific representation navigation and mobile menu access. */
export function ContextualTopBar(props: {
    context: AgentViewContext;
    isApplicationMenuOpen: boolean;
    isAgentMenuOpen: boolean;
    applicationTriggerRef: React.RefObject<HTMLButtonElement | null>;
    agentTriggerRef: React.RefObject<HTMLButtonElement | null>;
    onOpenApplicationMenu: () => void;
    onOpenAgentMenu: () => void;
}) {
    return (
        <header
            aria-label="View navigation"
            className="flex min-h-12 min-w-0 items-center gap-2 border-b border-slate-800 bg-[#0f1218] px-2 pt-2 md:px-3"
        >
            <IconButton
                ref={props.applicationTriggerRef}
                type="button"
                label="Open application menu"
                tooltipClassName="xl:hidden"
                aria-haspopup="dialog"
                aria-controls="application-menu-drawer"
                aria-expanded={props.isApplicationMenuOpen}
                onClick={props.onOpenApplicationMenu}
                className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100 xl:hidden"
            >
                <PanelLeftOpen className="h-5 w-5" aria-hidden="true" />
            </IconButton>
            <div className="flex min-w-0 flex-1 self-stretch items-end overflow-x-auto overscroll-x-contain">
                <ContextualViewSwitch context={props.context} />
            </div>
            <ThemeToggle />
            <IconButton
                ref={props.agentTriggerRef}
                type="button"
                label="Open agent menu"
                tooltipClassName="xl:hidden"
                aria-haspopup="dialog"
                aria-controls="agent-menu-drawer"
                aria-expanded={props.isAgentMenuOpen}
                onClick={props.onOpenAgentMenu}
                className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100 xl:hidden"
            >
                <PanelRightOpen className="h-5 w-5" aria-hidden="true" />
            </IconButton>
        </header>
    );
}

/** Selects only representations supported by the loaded agent or filesystem resource. */
function ContextualViewSwitch(props: { context: AgentViewContext }) {
    if (!props.context) {
        return null;
    }

    const agent = props.context.agent;
    const agentTarget = `/agents/${encodeURIComponent(agent.id)}`;
    const logsTarget = `${agentTarget}/logs`;
    const configurationTarget = `${agentTarget}/edit`;
    const filesTarget = agent.getBrowserUrl(agent.cwd ?? "/");
    const isFilesystemContext =
        props.context.kind === "directory" || props.context.kind === "file";
    const canBrowse = agent.status === "connected" && agent.cwd !== null;
    if (!isFilesystemContext) {
        return (
            <ViewSwitch label="Agent view">
                <ViewLink
                    to={agentTarget}
                    label={agent.name}
                    icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
                    active={props.context.kind === "agent"}
                />
                {canBrowse ? (
                    <ViewLink
                        to={filesTarget}
                        label="Files"
                        icon={<Files className="h-4 w-4" aria-hidden="true" />}
                        active={false}
                    />
                ) : null}
                {agent.configurationEditable ? (
                    <ViewLink
                        to={configurationTarget}
                        label="Configuration"
                        icon={
                            <Settings className="h-4 w-4" aria-hidden="true" />
                        }
                        active={props.context.kind === "configuration"}
                    />
                ) : null}
                {canBrowse ? (
                    <ViewLink
                        to={logsTarget}
                        label="Logs"
                        icon={
                            <ScrollText
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        }
                        active={props.context.kind === "logs"}
                    />
                ) : null}
            </ViewSwitch>
        );
    }

    return (
        <ViewSwitch label="Agent view">
            <ViewLink
                to={agentTarget}
                label={agent.name}
                icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
                active={false}
            />
            <ViewLink
                to={filesTarget}
                label="Files"
                icon={<Files className="h-4 w-4" aria-hidden="true" />}
                active={true}
            />
            {agent.configurationEditable ? (
                <ViewLink
                    to={configurationTarget}
                    label="Configuration"
                    icon={<Settings className="h-4 w-4" aria-hidden="true" />}
                    active={false}
                />
            ) : null}
            <ViewLink
                to={logsTarget}
                label="Logs"
                icon={<ScrollText className="h-4 w-4" aria-hidden="true" />}
                active={false}
            />
        </ViewSwitch>
    );
}

/** Applies consistent current-page semantics to contextual representation links. */
function ViewLink(props: {
    to: string;
    search?: Record<string, string>;
    label: string;
    icon: React.ReactNode;
    active: boolean;
}) {
    return (
        <Link
            to={props.to}
            search={props.search ?? {}}
            aria-current={props.active ? "page" : undefined}
            className={getViewSwitchItemClass(props.active)}
        >
            {props.icon}
            {props.label}
        </Link>
    );
}
