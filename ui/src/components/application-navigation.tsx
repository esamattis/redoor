import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
    ArrowLeftRight,
    Home,
    LoaderCircle,
    LogOut,
    ScrollText,
    Users,
    X,
} from "lucide-react";
import type * as React from "react";

import { getBrowserUrl, type ApiClient } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { IconButton } from "#ui/components/icon-button";
import { RestartButton, waitForRestart } from "#ui/components/restart-button";
import { SidebarModeToggle } from "#ui/components/sidebar-mode-toggle";
import { SideMenu } from "#ui/components/side-menu";
import { Tooltip } from "#ui/components/tooltip";
import { agentsQueryOptions, serverInfoQueryOptions } from "#ui/queries";
import {
    getPinnedFileKey,
    unpinFile,
    useUserState,
    type PinnedFile,
} from "#ui/user-state";

/** Places application-level destinations in the shared left-side presentation. */
export function ApplicationNavigation(props: {
    pathname: string;
    isOpen: boolean;
    isLoggingOut: boolean;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
    onLogout: () => void;
    api: ApiClient;
}) {
    return (
        <SideMenu
            placement="left"
            label="Application menu"
            drawerId="application-menu-drawer"
            isOpen={props.isOpen}
            triggerRef={props.triggerRef}
            onClose={props.onClose}
        >
            <BrandMark />
            <ApplicationMenu
                pathname={props.pathname}
                isLoggingOut={props.isLoggingOut}
                api={props.api}
                onClose={props.onClose}
                onLogout={props.onLogout}
            />
        </SideMenu>
    );
}

/** Shares application destinations, server restart, and logout between desktop and mobile menus. */
function ApplicationMenu(props: {
    pathname: string;
    isLoggingOut: boolean;
    api: ApiClient;
    onClose: () => void;
    onLogout: () => void;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const [userState, setUserState] = useUserState();
    const agentsQuery = useQuery(agentsQueryOptions(props.api));
    const agents = agentsQuery.data ?? [];
    const menuItems = [
        { to: "/", label: "Home", ariaLabel: "Server home", icon: Home },
        {
            to: "/agents",
            label: "Devices",
            ariaLabel: "Manage devices",
            icon: Users,
        },
        { to: "/logs", label: "Server logs", icon: ScrollText },
        { to: "/transfers", label: "Transfers", icon: ArrowLeftRight },
    ] as const;

    return (
        <nav
            aria-label="Application"
            className="mt-3 flex min-h-0 flex-1 flex-col gap-1"
        >
            {menuItems.map((item) => {
                const isActive =
                    item.to === "/transfers"
                        ? props.pathname.startsWith(item.to)
                        : props.pathname === item.to;
                const Icon = item.icon;
                return (
                    <Link
                        key={item.to}
                        to={item.to}
                        aria-label={
                            "ariaLabel" in item ? item.ariaLabel : undefined
                        }
                        aria-current={isActive ? "page" : undefined}
                        onClick={props.onClose}
                        className={`flex items-center gap-2.5 rounded px-3 py-2.5 text-sm transition-colors ${
                            isActive
                                ? "bg-white/5 text-slate-100"
                                : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                        }`}
                    >
                        <Icon
                            className="h-4 w-4 shrink-0 text-slate-400"
                            aria-hidden="true"
                        />
                        {item.label}
                    </Link>
                );
            })}
            {userState.pinnedFiles.length > 0 ? (
                <PinnedFiles
                    pathname={props.pathname}
                    pinnedFiles={userState.pinnedFiles}
                    deviceNameByAgentId={
                        new Map(agents.map((agent) => [agent.id, agent.name]))
                    }
                    onClose={props.onClose}
                    onRemove={(file) => {
                        setUserState((current) => ({
                            ...current,
                            pinnedFiles: unpinFile(current.pinnedFiles, file),
                        }));
                    }}
                    onClear={() => {
                        setUserState((current) => ({
                            ...current,
                            pinnedFiles: [],
                        }));
                    }}
                />
            ) : null}
            <div className="mt-auto flex flex-col gap-1">
                <SidebarModeToggle />
                <RestartButton
                    target="server"
                    ariaLabel="Restart server"
                    className="flex w-full items-center justify-start gap-2.5 rounded px-3 py-2.5 text-left text-sm text-slate-300 hover:bg-white/5 hover:text-slate-100"
                    description="The server will restart and re-read its configuration. Connected agents reconnect automatically. In-flight transfers and terminals are interrupted."
                    restart={() => props.api.restartServer()}
                    waitUntilReady={() => {
                        let oldServerClosed = false;
                        return waitForRestart(async () => {
                            try {
                                await queryClient.fetchQuery({
                                    ...serverInfoQueryOptions(props.api),
                                    staleTime: 0,
                                });
                            } catch (error) {
                                oldServerClosed = true;
                                throw error;
                            }
                            if (!oldServerClosed) {
                                throw new Error(
                                    "Old server is still shutting down",
                                );
                            }
                            await router.invalidate();
                        }, "Server did not come back after restart");
                    }}
                />
                <Button
                    type="button"
                    variant="subtle"
                    onClick={props.onLogout}
                    disabled={props.isLoggingOut}
                    className="flex w-full items-center justify-start gap-2.5 rounded px-3 py-2.5 text-left text-sm font-normal text-slate-300 hover:bg-white/5 hover:text-slate-100 disabled:cursor-wait disabled:opacity-60"
                >
                    {props.isLoggingOut ? (
                        <LoaderCircle
                            className="h-4 w-4 shrink-0 animate-spin text-slate-400"
                            aria-hidden="true"
                        />
                    ) : (
                        <LogOut
                            className="h-4 w-4 shrink-0 text-slate-400"
                            aria-hidden="true"
                        />
                    )}
                    {props.isLoggingOut ? "Logging out…" : "Log out"}
                </Button>
            </div>
        </nav>
    );
}

/** Lists pinned files under Transfers so they stay available from every route. */
function PinnedFiles(props: {
    pathname: string;
    pinnedFiles: PinnedFile[];
    deviceNameByAgentId: Map<string, string>;
    onClose: () => void;
    onRemove: (file: PinnedFile) => void;
    onClear: () => void;
}) {
    return (
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 px-3 py-1">
                <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                    Pinned
                </span>
                <Button
                    type="button"
                    variant="subtle"
                    aria-label="Clear all pinned files"
                    onClick={props.onClear}
                    className="px-1 py-0.5 text-xs font-normal text-slate-500 hover:text-slate-200"
                >
                    Clear
                </Button>
            </div>
            <ul
                aria-label="Pinned files"
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
            >
                {props.pinnedFiles.map((file) => {
                    const href = getBrowserUrl(file.agentId, file.path);
                    const isActive = props.pathname === href;
                    const deviceName =
                        props.deviceNameByAgentId.get(file.agentId) ??
                        file.agentName;
                    return (
                        <li
                            key={getPinnedFileKey(file)}
                            className={`group flex w-full min-w-0 items-start rounded ${
                                isActive
                                    ? "bg-white/5 text-slate-100"
                                    : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                            }`}
                        >
                            <Tooltip
                                className="min-w-0 flex-1"
                                content={`Open ${file.path}`}
                            >
                                <Link
                                    to={href}
                                    aria-label={file.name}
                                    aria-current={isActive ? "page" : undefined}
                                    onClick={props.onClose}
                                    className="block w-full min-w-0 px-3 py-1"
                                >
                                    <span className="block truncate text-sm">
                                        {file.name}
                                    </span>
                                    <span className="block truncate text-[10px] leading-tight text-slate-500">
                                        {deviceName}
                                    </span>
                                </Link>
                            </Tooltip>
                            <IconButton
                                type="button"
                                label="Remove pinned file"
                                tooltip={`Remove ${file.name}`}
                                onClick={() => props.onRemove(file)}
                                className="mt-1 mr-1 shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
                            >
                                <X className="h-3 w-3" aria-hidden="true" />
                            </IconButton>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** Keeps product identity with application-level navigation instead of route context. */
function BrandMark() {
    return (
        <Link
            to="/"
            tabIndex={-1}
            className="mr-2 flex shrink-0 items-center gap-2 px-2 pb-2 text-slate-200 hover:text-white"
        >
            <span className="relative h-12 w-12 shrink-0" aria-hidden="true">
                <img
                    src="/logo-dark-transparent.svg"
                    alt=""
                    className="theme-logo-dark absolute inset-0 h-12 w-12"
                />
                <img
                    src="/logo-light-transparent.svg"
                    alt=""
                    className="theme-logo-light absolute inset-0 h-12 w-12"
                />
            </span>
            <span className="text-2xl font-semibold tracking-tight">
                Redoor
            </span>
        </Link>
    );
}
