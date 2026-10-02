import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { Bookmark, HardDrive, Pencil, X } from "lucide-react";

import type { Agent } from "#ui/api-client";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
} from "#ui/agent-tab-locations";
import { AgentStatusDot } from "#ui/components/agent-status-dot";
import { SideMenu } from "#ui/components/side-menu";
import { AddButton } from "#ui/components/add-button";
import { IconButton } from "#ui/components/icon-button";
import { SortableItem, SortableList } from "#ui/components/sortable-list";
import { Tooltip } from "#ui/components/tooltip";
import {
    commitDeviceOrder,
    getBookmarkKey,
    reorderBookmarks,
    resolveDeviceOrder,
    useUserState,
    type Bookmark as BookmarkEntry,
} from "#ui/user-state";
import type { ItemMove } from "#ui/utils/reorder";

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
            label="Device menu"
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
    const listRef = React.useRef<HTMLUListElement>(null);
    const inventoryIds = props.agents.map((agent) => agent.id);
    const agentsById = new Map(props.agents.map((agent) => [agent.id, agent]));
    const orderedAgents = resolveDeviceOrder(
        userState.deviceOrder,
        inventoryIds,
    ).flatMap((id) => {
        const agent = agentsById.get(id);
        return agent ? [agent] : [];
    });

    return (
        <nav aria-label="Devices" className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex items-center justify-between gap-2 px-2">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                    Devices
                </h2>
                <AddButton tooltip="Add device">
                    <Link
                        to="/agents/new"
                        aria-label="Add device"
                        onClick={props.onClose}
                    />
                </AddButton>
            </div>
            {orderedAgents.length === 0 ? (
                <span className="px-2 py-3 text-sm text-slate-500">
                    No devices configured or connected
                </span>
            ) : (
                <SortableList
                    itemIds={orderedAgents.map((agent) => agent.id)}
                    orientation="vertical"
                    label="Devices"
                    listRef={listRef}
                    getItemLabel={(itemId) =>
                        agentsById.get(itemId)?.name ?? itemId
                    }
                    onMove={(move) => {
                        setUserState((current) => {
                            const deviceOrder = commitDeviceOrder(
                                current.deviceOrder,
                                inventoryIds,
                                move,
                            );
                            if (deviceOrder === current.deviceOrder) {
                                return current;
                            }
                            return { ...current, deviceOrder };
                        });
                    }}
                >
                    <ul
                        ref={listRef}
                        aria-label="Device list"
                        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
                    >
                        {orderedAgents.map((agent) => (
                            <DeviceBlock
                                key={agent.id}
                                agent={agent}
                                pathname={props.pathname}
                                rememberedTarget={
                                    agent.status === "connected" &&
                                    agent.cwd !== null
                                        ? getAgentTabLocation(
                                              agentTabLocations,
                                              agent.id,
                                              agent.getBrowserUrl(agent.cwd),
                                          )
                                        : `/agents/${encodeURIComponent(agent.id)}`
                                }
                                bookmarks={userState.bookmarks.filter(
                                    (bookmark) => bookmark.agentId === agent.id,
                                )}
                                onClose={props.onClose}
                                onMoveBookmarks={(move) => {
                                    setUserState((current) => {
                                        const bookmarks = reorderBookmarks(
                                            current.bookmarks,
                                            agent.id,
                                            move,
                                        );
                                        if (bookmarks === current.bookmarks) {
                                            return current;
                                        }
                                        return { ...current, bookmarks };
                                    });
                                }}
                                onRemoveBookmark={(bookmark) => {
                                    const targetKey = getBookmarkKey(bookmark);
                                    setUserState((current) => ({
                                        ...current,
                                        bookmarks: current.bookmarks.filter(
                                            (entry) =>
                                                getBookmarkKey(entry) !==
                                                targetKey,
                                        ),
                                    }));
                                }}
                            />
                        ))}
                    </ul>
                </SortableList>
            )}
        </nav>
    );
}

/** Moves a device and its bookmarks together without making bookmarks outer draggables. */
function DeviceBlock(props: {
    agent: Agent;
    pathname: string;
    rememberedTarget: string;
    bookmarks: BookmarkEntry[];
    onClose: () => void;
    onMoveBookmarks: (move: ItemMove) => void;
    onRemoveBookmark: (bookmark: BookmarkEntry) => void;
}) {
    const agentPrefix = `/agents/${encodeURIComponent(props.agent.id)}`;
    const isActive =
        props.pathname === agentPrefix ||
        props.pathname.startsWith(`${agentPrefix}/`);
    const canBrowse =
        props.agent.status === "connected" && props.agent.cwd !== null;
    const target = canBrowse ? props.rememberedTarget : agentPrefix;

    return (
        <SortableItem id={props.agent.id}>
            {(item) => (
                <li
                    {...item.dragProps}
                    ref={item.setNodeRef}
                    style={item.style}
                    aria-label={`Device ${props.agent.name}`}
                    className={`flex flex-col ${item.isDragging ? "opacity-70" : ""} ${
                        item.isOver && !item.isDragging
                            ? "ring-1 ring-blue-400/60"
                            : ""
                    }`}
                >
                    <div
                        className={`group flex items-center rounded-md border text-sm ${isActive ? "border-blue-500/40 bg-blue-500/10" : "border-transparent hover:bg-white/5"}`}
                    >
                        <Link
                            to={target}
                            onClick={props.onClose}
                            aria-label={`${props.agent.name}, ${props.agent.status}`}
                            aria-current={isActive ? "page" : undefined}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 text-slate-300 group-hover:text-slate-100"
                        >
                            <HardDrive
                                className={`h-4 w-4 shrink-0 ${isActive ? "text-blue-400" : "text-slate-500"}`}
                                aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                    {props.agent.name}
                                </span>
                                <span className="flex items-center gap-1.5 text-xs capitalize text-slate-500">
                                    <AgentStatusDot agent={props.agent} />
                                    {props.agent.status}
                                </span>
                            </span>
                            {isActive ? (
                                <span className="sr-only">Current device</span>
                            ) : null}
                        </Link>
                        {props.agent.configurationEditable ? (
                            <Tooltip content={`Edit ${props.agent.name}`}>
                                <Link
                                    to="/agents/$agentId/edit"
                                    params={{ agentId: props.agent.id }}
                                    aria-label={`Edit ${props.agent.name}`}
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
                    {props.bookmarks.length > 0 ? (
                        <AgentBookmarks
                            agent={props.agent}
                            bookmarks={props.bookmarks}
                            pathname={props.pathname}
                            onClose={props.onClose}
                            onMove={props.onMoveBookmarks}
                            onRemove={props.onRemoveBookmark}
                        />
                    ) : null}
                </li>
            )}
        </SortableItem>
    );
}

/** Keeps each agent's remembered paths visually nested under that agent. */
function AgentBookmarks(props: {
    agent: Agent;
    bookmarks: BookmarkEntry[];
    pathname: string;
    onClose: () => void;
    onMove: (move: ItemMove) => void;
    onRemove: (bookmark: BookmarkEntry) => void;
}) {
    const listRef = React.useRef<HTMLUListElement>(null);
    return (
        <SortableList
            itemIds={props.bookmarks.map((bookmark) =>
                getBookmarkKey(bookmark),
            )}
            orientation="vertical"
            label={`${props.agent.name} bookmarks`}
            listRef={listRef}
            getItemLabel={(itemId) =>
                props.bookmarks.find(
                    (bookmark) => getBookmarkKey(bookmark) === itemId,
                )?.name ?? itemId
            }
            onMove={props.onMove}
        >
            <ul
                ref={listRef}
                aria-label={`${props.agent.name} bookmarks`}
                className="mt-0.5 mb-1 ml-4 flex min-w-0 flex-col gap-0.5 border-l border-slate-800 pl-2"
            >
                {props.bookmarks.map((bookmark) => (
                    <BookmarkRow
                        key={getBookmarkKey(bookmark)}
                        agent={props.agent}
                        bookmark={bookmark}
                        pathname={props.pathname}
                        onClose={props.onClose}
                        onRemove={props.onRemove}
                    />
                ))}
            </ul>
        </SortableList>
    );
}

/** Keeps bookmark navigation and removal independent of the device-level drag. */
function BookmarkRow(props: {
    agent: Agent;
    bookmark: BookmarkEntry;
    pathname: string;
    onClose: () => void;
    onRemove: (bookmark: BookmarkEntry) => void;
}) {
    const href = props.agent.getBrowserUrl(props.bookmark.path);
    const isActive =
        props.pathname === href || props.pathname.startsWith(`${href}/`);
    return (
        <SortableItem
            id={getBookmarkKey(props.bookmark)}
            onRemove={() => props.onRemove(props.bookmark)}
        >
            {(item) => (
                <li
                    {...item.dragProps}
                    aria-label={`Bookmark ${props.bookmark.name} on ${props.agent.name}`}
                    ref={item.setNodeRef}
                    style={item.style}
                    className={`group flex w-full min-w-0 items-center rounded-md ${
                        item.isDragging ? "opacity-70" : ""
                    } ${
                        item.isOver && !item.isDragging
                            ? "ring-1 ring-blue-400/60"
                            : ""
                    } ${
                        isActive
                            ? "bg-blue-500/10 text-blue-300"
                            : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                    }`}
                >
                    <Tooltip
                        className="min-w-0 flex-1"
                        content={`Open ${props.bookmark.path}`}
                    >
                        <Link
                            to={href}
                            onClick={props.onClose}
                            aria-current={isActive ? "page" : undefined}
                            className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs"
                        >
                            <Bookmark
                                className="h-3 w-3 shrink-0"
                                aria-hidden="true"
                            />
                            <span className="truncate">
                                {props.bookmark.name}
                            </span>
                        </Link>
                    </Tooltip>
                    <IconButton
                        type="button"
                        label={`Remove bookmark ${props.bookmark.name}`}
                        tooltip={`Remove ${props.bookmark.name}`}
                        onClick={() => props.onRemove(props.bookmark)}
                        className="mr-0.5 shrink-0 rounded p-1 text-slate-600 opacity-0 hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                    </IconButton>
                </li>
            )}
        </SortableItem>
    );
}
