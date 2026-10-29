import { createLink } from "@tanstack/react-router";
import {
    Files,
    HardDrive,
    PanelLeftOpen,
    PanelRightOpen,
    ScrollText,
    Settings,
    Trash2,
} from "lucide-react";
import { useAtom } from "jotai";
import type * as React from "react";

import { browserRoute, deviceRoute } from "#ui/browser-route";
import { IconButton } from "#ui/components/icon-button";
import {
    getViewSwitchItemClass,
    ViewSwitch,
} from "#ui/components/browser/navigation";
import { ThemeToggle } from "#ui/components/theme-toggle";
import {
    openSideMenuAtom,
    sideMenuDrawerIds,
    usePersistentSideMenus,
} from "#ui/side-menu-state";
import {
    useAgentViewContext,
    type AgentViewContext,
} from "#ui/agent-view-context";
import { SearchButton } from "#ui/components/search-button";

/**
 * Turns the global top slot into route-specific representation navigation and mobile menu
 * access. It derives its context from the router and opens menus through the shared atom, so
 * the shell passes it nothing.
 */
export function ContextualTopBar() {
    const context = useAgentViewContext();
    const [openMenu, setOpenMenu] = useAtom(openSideMenuAtom);
    const isPersistent = usePersistentSideMenus();

    const isFilesystemContext =
        context?.kind === "directory" || context?.kind === "file";

    return (
        <header
            aria-label="View navigation"
            className="flex min-h-12 min-w-0 items-center gap-2 border-b border-slate-800 bg-chrome px-2 pt-2 @2xl:px-3"
        >
            {isPersistent ? null : (
                <IconButton
                    type="button"
                    label="Open application menu"
                    tooltip={false}
                    aria-haspopup="dialog"
                    aria-controls={sideMenuDrawerIds.application}
                    aria-expanded={openMenu === "application"}
                    variant="ghost"
                    size="md"
                    onClick={() => setOpenMenu("application")}
                >
                    <PanelLeftOpen className="h-5 w-5" aria-hidden="true" />
                </IconButton>
            )}
            <div className="scrollbar-hidden flex min-w-0 flex-1 self-stretch items-end overflow-x-auto overscroll-x-contain">
                <ContextualViewSwitch context={context} />
            </div>
            {context && !isFilesystemContext ? (
                <SearchButton size="md" />
            ) : null}
            <ThemeToggle />
            {isPersistent ? null : (
                <IconButton
                    type="button"
                    label="Open device menu"
                    tooltip={false}
                    aria-haspopup="dialog"
                    aria-controls={sideMenuDrawerIds.agents}
                    aria-expanded={openMenu === "agents"}
                    variant="ghost"
                    size="md"
                    onClick={() => setOpenMenu("agents")}
                >
                    <PanelRightOpen className="h-5 w-5" aria-hidden="true" />
                </IconButton>
            )}
        </header>
    );
}

/** Renders an anchor with the top bar's tab look, leaving navigation to the router link around it. */
function ViewSwitchAnchor(
    props: React.ComponentPropsWithRef<"a"> & { active: boolean },
) {
    const anchorProps: Partial<typeof props> = { ...props };
    delete anchorProps.active;

    return (
        <a
            {...anchorProps}
            aria-current={props.active ? "page" : undefined}
            className={getViewSwitchItemClass(props.active)}
        />
    );
}

/**
 * A typed router link that looks like a top bar tab and carries current-page semantics, so
 * every destination keeps its checked `to`, `params` and `search`.
 */
const ViewSwitchLink = createLink(ViewSwitchAnchor);

/** Selects only representations supported by the loaded agent or filesystem resource. */
function ContextualViewSwitch(props: { context: AgentViewContext }) {
    if (!props.context) {
        return null;
    }

    const agent = props.context.agent;
    const kind = props.context.kind;
    const isFilesystemContext = kind === "directory" || kind === "file";

    // Stopped TOML homes can be relative; only connected resolved paths are browser URLs.
    const browseHome =
        agent.status === "connected" && agent.cwd !== null ? agent.cwd : null;

    const canBrowse = isFilesystemContext || browseHome !== null;

    const filesIcon = <Files className="h-4 w-4" aria-hidden="true" />;

    return (
        <ViewSwitch label="Device view">
            <ViewSwitchLink
                {...deviceRoute(agent, "/agents/$deviceName")}
                active={kind === "agent"}
            >
                <HardDrive className="h-4 w-4" aria-hidden="true" />
                <span>{agent.name}</span>
            </ViewSwitchLink>
            {canBrowse ? (
                browseHome === null ? (
                    <ViewSwitchLink
                        {...deviceRoute(agent, "/agents/$deviceName")}
                        active={isFilesystemContext}
                    >
                        {filesIcon}
                        <span>Files</span>
                    </ViewSwitchLink>
                ) : (
                    <ViewSwitchLink
                        {...browserRoute(agent, browseHome)}
                        // The device home is rarely inside the browsed repository, so this
                        // entry point leaves Git history instead of keeping its revision.
                        search={{ rev: undefined }}
                        active={isFilesystemContext}
                    >
                        {filesIcon}
                        <span>Files</span>
                    </ViewSwitchLink>
                )
            ) : null}
            {canBrowse ? (
                <ViewSwitchLink
                    {...deviceRoute(agent, "/agents/$deviceName/trash")}
                    active={kind === "trash"}
                >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span>Trash</span>
                </ViewSwitchLink>
            ) : null}
            {agent.configurationEditable ? (
                <ViewSwitchLink
                    {...deviceRoute(agent, "/agents/$deviceName/edit")}
                    active={kind === "configuration"}
                >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    <span>Configuration</span>
                </ViewSwitchLink>
            ) : null}
            {canBrowse ? (
                <ViewSwitchLink
                    {...deviceRoute(agent, "/agents/$deviceName/logs")}
                    active={kind === "logs"}
                >
                    <ScrollText className="h-4 w-4" aria-hidden="true" />
                    <span>Logs</span>
                </ViewSwitchLink>
            ) : null}
        </ViewSwitch>
    );
}
