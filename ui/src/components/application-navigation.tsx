import { Link } from "@tanstack/react-router";
import {
    ArrowLeftRight,
    Home,
    LoaderCircle,
    LogOut,
    ScrollText,
    Users,
} from "lucide-react";
import type * as React from "react";

import { SideMenu } from "#ui/components/side-menu";

/** Places application-level destinations in the shared left-side presentation. */
export function ApplicationNavigation(props: {
    pathname: string;
    isOpen: boolean;
    isLoggingOut: boolean;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
    onLogout: () => void;
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
                onClose={props.onClose}
                onLogout={props.onLogout}
            />
        </SideMenu>
    );
}

/** Shares application destinations and the account action between desktop and mobile menus. */
function ApplicationMenu(props: {
    pathname: string;
    isLoggingOut: boolean;
    onClose: () => void;
    onLogout: () => void;
}) {
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
            <button
                type="button"
                onClick={props.onLogout}
                disabled={props.isLoggingOut}
                className="mt-auto flex items-center gap-2.5 rounded px-3 py-2.5 text-left text-sm text-slate-300 hover:bg-white/5 hover:text-slate-100 disabled:cursor-wait disabled:opacity-60"
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
            </button>
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
