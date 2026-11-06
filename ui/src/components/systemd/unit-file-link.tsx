import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { SystemdScope } from "#bindings/SystemdScope";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import {
    systemdScopeKey,
    systemdUnitIndexQueryOptions,
} from "#ui/systemd-queries";
import { cn } from "#ui/utils/cn";
import {
    systemdUnitFileTarget,
    type SystemdUnitFileTarget,
} from "#ui/utils/systemd-unit-file";

/**
 * A unit's name, linked to the Systemd view of its file when it has one. A unit's status
 * lives beside its file, so units without a file (devices, scopes, transient units) have no
 * page and their name stays plain text instead of a link that leads nowhere.
 */
export function SystemdUnitFileLink(props: {
    agent: Agent;
    /**
     * The manager the link comes from. A user's manager travels in the URL, because the
     * file alone (such as a shared, root-owned `/usr/lib/systemd/user/*` file) cannot tell
     * the file view whose user manager to ask.
     */
    scope: SystemdScope;
    target: SystemdUnitFileTarget | null;
    children: React.ReactNode;
    className?: string;
    title?: string;
}) {
    if (props.target === null) {
        return (
            <span
                className={cn(props.className, "text-slate-200")}
                title={props.title}
            >
                {props.children}
            </span>
        );
    }

    return (
        <Link
            {...browserRoute(props.agent, props.target.path)}
            // The unit view is a tab of the file view; a Git revision has no units to show.
            search={{
                view: "systemd",
                unit: props.target.unit,
                systemdScope:
                    props.scope.type === "user"
                        ? systemdScopeKey(props.scope)
                        : undefined,
                rev: undefined,
            }}
            className={cn(
                props.className,
                "text-blue-300 hover:text-blue-200 hover:underline",
            )}
            title={props.title}
        >
            {props.children}
        </Link>
    );
}

/**
 * Links other units of one manager by name, such as the service a timer activates or the
 * timer that activates a service. Only their names are known, so the names are resolved to
 * files through the manager's unit list, which the unit list page has usually cached.
 */
export function SystemdUnitNameLink(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    className?: string;
}) {
    const { data: index } = useQuery(
        systemdUnitIndexQueryOptions(props.agent, props.scope),
    );

    const summary = index?.get(props.unit);

    return (
        <SystemdUnitFileLink
            agent={props.agent}
            scope={props.scope}
            target={summary ? systemdUnitFileTarget(summary) : null}
            className={props.className}
            title={props.unit}
        >
            {props.unit}
        </SystemdUnitFileLink>
    );
}
