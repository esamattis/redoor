import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Bookmark, HardDrive, Pencil, X } from "lucide-react";
import type * as React from "react";

import type { Agent } from "#ui/api-client";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
} from "#ui/agent-tab-locations";
import { SideMenu } from "#ui/components/side-menu";
import { AddButton } from "#ui/components/add-button";
import { IconButton } from "#ui/components/icon-button";
import { Tooltip } from "#ui/components/tooltip";
import {
    getBookmarkKey,
    useUserState,
    type Bookmark as BookmarkEntry,
} from "#ui/user-state";

/** Places agent selection and management actions in the shared right-side presentation. */
export function AgentNavigation(props: {
    agents: Agent[];
    pathname: string;
    isOpen: boolean;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
}) {
    return (
        <SideMenu
            placement="right"
            label="Agent menu"
            drawerId="agent-menu-drawer"
            isOpen={props.isOpen}
            triggerRef={props.triggerRef}
            onClose={props.onClose}
        >
            <AgentMenu
                agents={props.agents}
                pathname={props.pathname}
                onClose={props.onClose}
            />
        </SideMenu>
    );
}

/** Preserves remembered filesystem destinations while keeping agent selection side-effect free. */
function AgentMenu(props: {
    agents: Agent[];
    pathname: string;
    onClose: () => void;
}) {
    const agentTabLocations = useAtomValue(agentTabLocationsAtom);
    const [userState, setUserState] = useUserState();

    return (
        <nav aria-label="Agents" className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex items-center justify-between gap-2 px-2">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                    Agents
                </h2>
                <AddButton tooltip="Add managed agent">
                    <Link
                        to="/agents/new"
                        aria-label="Add managed agent"
                        onClick={props.onClose}
                    />
                </AddButton>
            </div>
            <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
                {props.agents.length === 0 ? (
                    <span className="px-2 py-3 text-sm text-slate-500">
                        No agents configured or connected
                    </span>
                ) : (
                    props.agents.map((agent) => {
                        const agentPrefix = `/agents/${encodeURIComponent(agent.id)}`;
                        const isActive =
                            props.pathname === agentPrefix ||
                            props.pathname.startsWith(`${agentPrefix}/`);
                        const canBrowse =
                            agent.status === "connected" && agent.cwd !== null;
                        const target = canBrowse
                            ? getAgentTabLocation(
                                  agentTabLocations,
                                  agent.id,
                                  agent.getBrowserUrl(agent.cwd),
                              )
                            : agentPrefix;
                        const bookmarks = userState.bookmarks.filter(
                            (bookmark) => bookmark.agentId === agent.id,
                        );
                        return (
                            <div key={agent.id} className="flex flex-col">
                                <div
                                    className={`group flex items-center rounded-md border text-sm ${isActive ? "border-blue-500/40 bg-blue-500/10" : "border-transparent hover:bg-white/5"}`}
                                >
                                    <Link
                                        to={target}
                                        onClick={props.onClose}
                                        aria-label={`${agent.name}, ${agent.status}`}
                                        aria-current={
                                            isActive ? "page" : undefined
                                        }
                                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 text-slate-300 group-hover:text-slate-100"
                                    >
                                        <HardDrive
                                            className={`h-4 w-4 shrink-0 ${isActive ? "text-blue-400" : "text-slate-500"}`}
                                            aria-hidden="true"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-medium">
                                                {agent.name}
                                            </span>
                                            <span className="block text-xs capitalize text-slate-500">
                                                {agent.status}
                                            </span>
                                        </span>
                                        {isActive ? (
                                            <span className="sr-only">
                                                Current agent
                                            </span>
                                        ) : null}
                                    </Link>
                                    {agent.configurationEditable ? (
                                        <Tooltip content={`Edit ${agent.name}`}>
                                            <Link
                                                to="/agents/$agentId/edit"
                                                params={{ agentId: agent.id }}
                                                aria-label={`Edit ${agent.name}`}
                                                onClick={props.onClose}
                                                className="mr-1 rounded p-1.5 text-slate-500 hover:bg-white/10 hover:text-slate-200"
                                            >
                                                <Pencil
                                                    className="h-3.5 w-3.5"
                                                    aria-hidden="true"
                                                />
                                            </Link>
                                        </Tooltip>
                                    ) : null}
                                </div>
                                {bookmarks.length > 0 ? (
                                    <AgentBookmarks
                                        agent={agent}
                                        bookmarks={bookmarks}
                                        pathname={props.pathname}
                                        onClose={props.onClose}
                                        onRemove={(bookmark) => {
                                            const targetKey =
                                                getBookmarkKey(bookmark);
                                            setUserState((current) => ({
                                                ...current,
                                                bookmarks:
                                                    current.bookmarks.filter(
                                                        (entry) =>
                                                            getBookmarkKey(
                                                                entry,
                                                            ) !== targetKey,
                                                    ),
                                            }));
                                        }}
                                    />
                                ) : null}
                            </div>
                        );
                    })
                )}
            </div>
        </nav>
    );
}

/** Keeps each agent's remembered paths visually nested under that agent. */
function AgentBookmarks(props: {
    agent: Agent;
    bookmarks: BookmarkEntry[];
    pathname: string;
    onClose: () => void;
    onRemove: (bookmark: BookmarkEntry) => void;
}) {
    return (
        <ul
            aria-label={`${props.agent.name} bookmarks`}
            className="mt-0.5 mb-1 ml-4 flex flex-col gap-0.5 border-l border-slate-800 pl-2"
        >
            {props.bookmarks.map((bookmark) => {
                const href = props.agent.getBrowserUrl(bookmark.path);
                const isActive =
                    props.pathname === href ||
                    props.pathname.startsWith(`${href}/`);
                return (
                    <li
                        key={getBookmarkKey(bookmark)}
                        className="group flex min-w-0 items-center"
                    >
                        <Tooltip content={bookmark.path}>
                            <Link
                                to={href}
                                onClick={props.onClose}
                                aria-current={isActive ? "page" : undefined}
                                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs ${
                                    isActive
                                        ? "bg-blue-500/10 text-blue-300"
                                        : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                                }`}
                            >
                                <Bookmark
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden="true"
                                />
                                <span className="truncate">
                                    {bookmark.name}
                                </span>
                            </Link>
                        </Tooltip>
                        <IconButton
                            type="button"
                            label={`Remove bookmark ${bookmark.name}`}
                            tooltip={`Remove ${bookmark.name}`}
                            onClick={() => props.onRemove(bookmark)}
                            className="rounded p-1 text-slate-600 opacity-0 hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                            <X className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                    </li>
                );
            })}
        </ul>
    );
}
