import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Info, List, Server, ServerCog, User } from "lucide-react";

import type { SystemdPathMatch } from "#bindings/SystemdPathMatch";
import type { SystemdScope } from "#bindings/SystemdScope";
import type { Agent } from "#ui/api-client";
import { browserRoute, systemdScopeRoute } from "#ui/browser-route";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import {
    SegmentedControl,
    type SegmentedControlOption,
} from "#ui/components/segmented-control";
import { SystemdLoadError } from "#ui/components/systemd/systemd-states";
import { SystemdUnitFileLink } from "#ui/components/systemd/unit-file-link";
import { SystemdUnitPanel } from "#ui/components/systemd/unit-panel";
import { UnitStateBadge } from "#ui/components/systemd/unit-state";
import { ViewCardHeader } from "#ui/components/view-card-header";
import type { BrowserSearch } from "#ui/browser-search";
import {
    isSystemdFileCandidate,
    systemdPathStatusQueryOptions,
    systemdScopeKey,
    systemdScopeKeyUser,
    systemdUnitIndexQueryOptions,
} from "#ui/systemd-queries";
import { getBaseName } from "#ui/utils/path";
import {
    isTemplateUnit,
    selectSystemdMatch,
    systemdViewUnit,
    templateInstances,
} from "#ui/utils/systemd-unit-file";

/** Names a manager the way its unit list is titled, so the link back reads the same. */
function scopeListLabel(scope: SystemdScope): string {
    return scope.type === "system" ? "System units" : `Units of ${scope.name}`;
}

/** Names a manager in the view's title and its picker. */
function scopeLabel(scope: SystemdScope): string {
    return scope.type === "system"
        ? "System manager"
        : `User manager of ${scope.name}`;
}

/** The match's key in the URL and in the picker. */
function matchKey(match: SystemdPathMatch): string {
    return systemdScopeKey(match.scope);
}

/** A short explanation inside the card, for files without a unit to show. */
function Notice(props: { children: React.ReactNode }) {
    return (
        <p className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-400">
            <Info
                className="mt-0.5 h-4 w-4 shrink-0 text-blue-400"
                aria-hidden="true"
            />
            <span>{props.children}</span>
        </p>
    );
}

/**
 * A template file has no status of its own, only its instances do. Lists the instances the
 * manager has loaded, each opening its status in this same view.
 */
function TemplateInstances(props: {
    agent: Agent;
    scope: SystemdScope;
    template: string;
    path: string;
}) {
    const indexQuery = useQuery(
        systemdUnitIndexQueryOptions(props.agent, props.scope),
    );

    const instances = indexQuery.data
        ? templateInstances([...indexQuery.data.values()], props.template)
        : [];

    return (
        <section
            aria-label="Template instances"
            className="flex flex-col gap-3"
        >
            <Notice>
                {props.template} is a template. Templates have no status of
                their own; each instance, such as{" "}
                {props.template.replace("@.", "@name.")}, has one.
            </Notice>
            <h3 className="font-semibold text-slate-100">Instances</h3>
            {indexQuery.isPending ? (
                <p role="status" className="text-sm text-slate-400">
                    Loading instances…
                </p>
            ) : instances.length === 0 ? (
                <p className="text-sm text-slate-400">
                    systemd has no instances of this template loaded.
                </p>
            ) : (
                <ul
                    aria-label={`Instances of ${props.template}`}
                    className="overflow-hidden rounded-lg border border-slate-800"
                >
                    {instances.map((instance) => (
                        <li
                            key={instance.name}
                            className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2 last:border-b-0"
                        >
                            <SystemdUnitFileLink
                                agent={props.agent}
                                scope={props.scope}
                                target={{
                                    path: props.path,
                                    unit: instance.name,
                                }}
                                className="min-w-0 truncate py-1 font-medium"
                                title={instance.name}
                            >
                                {instance.name}
                            </SystemdUnitFileLink>
                            <UnitStateBadge
                                activeState={instance.active_state}
                                subState={instance.sub_state}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** Links between the unit's manager list, and from an instance back to its template. */
function SystemdFileLinks(props: {
    agent: Agent;
    match: SystemdPathMatch;
    path: string;
    unit: string;
}) {
    const linkClass =
        "inline-flex min-h-9 w-fit items-center gap-1 text-sm text-slate-400 hover:text-slate-100";

    return (
        <nav
            aria-label="Systemd links"
            className="mt-3 flex flex-wrap items-center gap-x-4"
        >
            <Link
                {...systemdScopeRoute(props.agent, props.match.scope)}
                className={linkClass}
            >
                <List className="h-4 w-4" aria-hidden="true" />
                {scopeListLabel(props.match.scope)}
            </Link>
            {props.unit === props.match.unit ? null : (
                <Link
                    {...browserRoute(props.agent, props.path)}
                    // The user's manager stays named, so the template's status is asked of it.
                    search={{
                        view: "systemd",
                        systemdScope: systemdScopeKey(props.match.scope),
                    }}
                    className={linkClass}
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    All instances of {props.match.unit}
                </Link>
            )}
        </nav>
    );
}

/**
 * The file view's Systemd tab: the status, actions and journal of the unit the open file
 * defines (or, for a drop-in, modifies), so a unit and its file are one tab apart. Which unit
 * and manager that is comes from the agent, because only the managers' search paths decide
 * whether systemd reads a file at all.
 */
export function SystemdFileView(props: {
    agent: Agent;
    path: string;
    /** The instance to show when the file is a template. */
    unit: string | undefined;
    /** The manager to show when several load the file, as `systemdScopeKey` names it. */
    scopeKey: string | undefined;
    onScopeChange: (scopeKey: string) => void;
}) {
    const statusQuery = useQuery(
        systemdPathStatusQueryOptions(
            props.agent,
            props.path,
            systemdScopeKeyUser(props.scopeKey),
        ),
    );

    const matches = statusQuery.data?.matches ?? [];
    const match = selectSystemdMatch(matches, props.scopeKey, matchKey);
    const unit = match === null ? null : systemdViewUnit(match, props.unit);

    const options: SegmentedControlOption<string>[] = matches.map((entry) => ({
        value: matchKey(entry),
        label: entry.scope.type === "system" ? "System" : entry.scope.name,
        icon: entry.scope.type === "system" ? Server : User,
        tooltip: `${entry.unit} in the ${scopeLabel(entry.scope).toLowerCase()}`,
    }));

    const body = (() => {
        if (statusQuery.isError && statusQuery.data === undefined) {
            return (
                <SystemdLoadError
                    error={statusQuery.error}
                    fallback="Could not ask systemd about this file"
                    onRetry={() => void statusQuery.refetch()}
                />
            );
        }

        if (statusQuery.isPending) {
            return (
                <p role="status" className="text-sm text-slate-400">
                    Asking systemd about this file…
                </p>
            );
        }

        if (match === null || unit === null) {
            // The file moved out of every unit directory while the tab was open.
            return (
                <Notice>
                    No systemd manager loads this file. Unit files only count
                    inside a manager&apos;s unit directories.
                </Notice>
            );
        }

        if (isTemplateUnit(unit)) {
            return (
                <TemplateInstances
                    agent={props.agent}
                    scope={match.scope}
                    template={unit}
                    path={props.path}
                />
            );
        }

        return (
            <SystemdUnitPanel
                // A new unit or manager starts with a fresh journal and closed dialogs.
                key={`${matchKey(match)}/${unit}`}
                agent={props.agent}
                scope={match.scope}
                unit={unit}
                openPath={props.path}
            />
        );
    })();

    return (
        <BrowserViewCard>
            <ViewCardHeader
                icon={<ServerCog className="h-5 w-5" aria-hidden="true" />}
                eyebrow={
                    match?.drop_in === true ? "Systemd drop-in" : "Systemd"
                }
                title={
                    match === null
                        ? getBaseName(props.path)
                        : scopeLabel(match.scope)
                }
            >
                {match?.drop_in === true ? (
                    <p className="mt-3 text-sm text-slate-400">
                        This drop-in changes {match.unit}.
                    </p>
                ) : null}
                {options.length > 1 && match !== null ? (
                    // Only a file several managers load needs a choice between them.
                    <SegmentedControl
                        label="Systemd manager"
                        options={options}
                        value={matchKey(match)}
                        onChange={props.onScopeChange}
                        className="mt-3 @2xl:w-auto @2xl:min-w-80"
                    />
                ) : null}
                {match !== null && unit !== null ? (
                    <SystemdFileLinks
                        agent={props.agent}
                        match={match}
                        path={props.path}
                        unit={unit}
                    />
                ) : null}
            </ViewCardHeader>
            <div className="flex flex-col gap-4 p-4 @xl:p-5">{body}</div>
        </BrowserViewCard>
    );
}

/**
 * Whether the file view shows the Systemd tab: when a manager loads the file, and always
 * while the tab is open so the active tab never disappears from the strip. `scopeKey` is the
 * URL's manager, so the tab asks the same user's manager as the view.
 */
export function useSystemdFileTab(options: {
    agent: Agent;
    path: string;
    activeView: NonNullable<BrowserSearch["view"]> | "view";
    scopeKey: string | undefined;
}): boolean {
    const isCandidate = isSystemdFileCandidate(options.agent, options.path);

    const statusQuery = useQuery({
        ...systemdPathStatusQueryOptions(
            options.agent,
            options.path,
            systemdScopeKeyUser(options.scopeKey),
        ),
        enabled: isCandidate,
    });

    return (
        isCandidate &&
        (options.activeView === "systemd" ||
            (statusQuery.data?.matches.length ?? 0) > 0)
    );
}
