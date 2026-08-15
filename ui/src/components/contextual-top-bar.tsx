import { Link } from "@tanstack/react-router";
import {
    File,
    Files,
    GitCompareArrows,
    Info,
    PanelLeftOpen,
    PanelRightOpen,
    RefreshCw,
} from "lucide-react";
import type * as React from "react";

import type { Agent } from "#ui/api-client";
import {
    getViewSwitchItemClass,
    ViewSwitch,
} from "#ui/components/browser/navigation";
import { getBrowserPathHref } from "#ui/components/browser/utils";
import { ThemeToggle } from "#ui/components/theme-toggle";
import { Tooltip } from "#ui/components/tooltip";

export type AgentViewContext =
    | { kind: "agent"; agent: Agent }
    | { kind: "directory"; agent: Agent; path: string }
    | { kind: "file"; agent: Agent; path: string }
    | null;

/** Turns the global top slot into route-specific representation navigation and mobile menu access. */
export function ContextualTopBar(props: {
    context: AgentViewContext;
    view: string | null;
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
            <Tooltip content="Open application menu" className="md:hidden">
                <button
                    ref={props.applicationTriggerRef}
                    type="button"
                    aria-label="Open application menu"
                    aria-haspopup="dialog"
                    aria-controls="application-menu-drawer"
                    aria-expanded={props.isApplicationMenuOpen}
                    onClick={props.onOpenApplicationMenu}
                    className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100"
                >
                    <PanelLeftOpen className="h-5 w-5" aria-hidden="true" />
                </button>
            </Tooltip>
            <div className="flex min-w-0 flex-1 self-stretch items-end overflow-x-auto overscroll-x-contain">
                <ContextualViewSwitch
                    context={props.context}
                    view={props.view}
                />
            </div>
            <ThemeToggle />
            <Tooltip content="Open agent menu" className="md:hidden">
                <button
                    ref={props.agentTriggerRef}
                    type="button"
                    aria-label="Open agent menu"
                    aria-haspopup="dialog"
                    aria-controls="agent-menu-drawer"
                    aria-expanded={props.isAgentMenuOpen}
                    onClick={props.onOpenAgentMenu}
                    className="rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100"
                >
                    <PanelRightOpen className="h-5 w-5" aria-hidden="true" />
                </button>
            </Tooltip>
        </header>
    );
}

/** Selects only representations supported by the loaded agent or filesystem resource. */
function ContextualViewSwitch(props: {
    context: AgentViewContext;
    view: string | null;
}) {
    if (!props.context) {
        return null;
    }

    const agent = props.context.agent;
    if (props.context.kind === "agent") {
        const filesTarget = agent.getBrowserUrl(agent.cwd ?? "/");
        return (
            <ViewSwitch label="Agent view">
                <Link
                    to={filesTarget}
                    className={getViewSwitchItemClass(false)}
                >
                    <Files className="h-4 w-4" aria-hidden="true" />
                    Files
                </Link>
                <Link
                    to="/agents/$agentId"
                    params={{ agentId: agent.id }}
                    aria-current="page"
                    className={getViewSwitchItemClass(true)}
                >
                    <Info className="h-4 w-4" aria-hidden="true" />
                    Details
                </Link>
            </ViewSwitch>
        );
    }

    const pathTarget = getBrowserPathHref(agent, props.context.path);
    if (props.context.kind === "directory") {
        const activeView =
            props.view === "details"
                ? "details"
                : props.view === "sync"
                  ? "sync"
                  : "files";
        return (
            <ViewSwitch label="Directory view">
                <ViewLink
                    to={pathTarget}
                    label="Files"
                    icon={<Files className="h-4 w-4" aria-hidden="true" />}
                    active={activeView === "files"}
                />
                <ViewLink
                    to={pathTarget}
                    search={{ view: "details" }}
                    label="Details"
                    icon={<Info className="h-4 w-4" aria-hidden="true" />}
                    active={activeView === "details"}
                />
                <ViewLink
                    to={pathTarget}
                    search={{ view: "sync" }}
                    label="Sync"
                    icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                    active={activeView === "sync"}
                />
            </ViewSwitch>
        );
    }

    const activeView =
        props.view === "edit"
            ? "view"
            : props.view === "diff"
              ? "diff"
              : props.view === "sync"
                ? "sync"
                : "details";
    return (
        <ViewSwitch label="File view">
            <ViewLink
                to={pathTarget}
                label="Details"
                icon={<Info className="h-4 w-4" aria-hidden="true" />}
                active={activeView === "details"}
            />
            <ViewLink
                to={pathTarget}
                search={{ view: "edit" }}
                label="View"
                icon={<File className="h-4 w-4" aria-hidden="true" />}
                active={activeView === "view"}
            />
            <ViewLink
                to={pathTarget}
                search={{ view: "diff" }}
                label="Diff"
                icon={
                    <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
                }
                active={activeView === "diff"}
            />
            <ViewLink
                to={pathTarget}
                search={{ view: "sync" }}
                label="Sync"
                icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                active={activeView === "sync"}
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
