import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
    ArrowLeftRight,
    Home,
    LoaderCircle,
    LogOut,
    ScrollText,
    Users,
} from "lucide-react";
import type * as React from "react";

import type { ApiClient } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { RestartButton, waitForRestart } from "#ui/components/restart-button";
import { SidebarModeToggle } from "#ui/components/sidebar-mode-toggle";
import { SideMenu } from "#ui/components/side-menu";
import { serverInfoQueryOptions } from "#ui/queries";

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
    const menuItems = [
        { to: "/", label: "Home", ariaLabel: "Server home", icon: Home },
        {
            to: "/agents",
            label: "Agents",
            ariaLabel: "Manage agents",
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
