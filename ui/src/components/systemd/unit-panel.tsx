import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, FileCode } from "lucide-react";

import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdUnitDetailsResponse } from "#bindings/SystemdUnitDetailsResponse";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { SystemdJournal } from "#ui/components/systemd/journal";
import { SystemdLoadError } from "#ui/components/systemd/systemd-states";
import {
    DaemonReloadButton,
    SystemdUnitActions,
} from "#ui/components/systemd/unit-actions";
import { UnitStateBadge } from "#ui/components/systemd/unit-state";
import {
    TimerSchedule,
    TimestampValue,
    UnitLinks,
} from "#ui/components/systemd/unit-timer";
import { UserManagerNotRunning } from "#ui/components/systemd/user-manager";
import {
    isUserManagerNotRunningError,
    systemdScopeKey,
    systemdUnitQueryOptions,
} from "#ui/systemd-queries";
import { formatElapsed, useNow } from "#ui/utils/agent-time";
import { formatSize } from "#ui/utils/path";

/** Shows CPU time compactly: sub-minute values keep their fraction, longer ones read as a span. */
function formatCpu(nanoseconds: number): string {
    const seconds = nanoseconds / 1e9;

    return seconds < 60 ? `${seconds.toFixed(2)} s` : formatElapsed(seconds);
}

/** Words the last run's outcome the way `systemctl status` does: result and exit status. */
function formatResult(details: SystemdUnitDetailsResponse): string | null {
    if (details.result === null && details.exec_main_status === null) {
        return null;
    }

    const status =
        details.exec_main_status === null
            ? null
            : `exit status ${details.exec_main_status}`;

    return [details.result, status].filter((part) => part !== null).join(", ");
}

/** One labelled value of the status grid; absent values are left out instead of shown empty. */
function StatusItem(props: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {props.label}
            </dt>
            <dd className="mt-1 wrap-break-word text-sm text-slate-200">
                {props.children}
            </dd>
        </div>
    );
}

/** The unit's status in the terms of `systemctl status`, leaving out values systemd does not set. */
function UnitStatus(props: {
    agent: Agent;
    scope: SystemdScope;
    details: SystemdUnitDetailsResponse;
    now: number;
}) {
    const now = props.now;
    const details = props.details;
    const result = formatResult(details);
    const isActive = details.active_state === "active";

    const enabled =
        details.unit_file_state === null
            ? null
            : details.unit_file_preset === null
              ? details.unit_file_state
              : `${details.unit_file_state} (preset: ${details.unit_file_preset})`;

    return (
        <dl
            aria-label="Unit status"
            className="grid grid-cols-1 gap-4 rounded-lg border border-slate-800 bg-surface p-4 @xl:grid-cols-2 @4xl:grid-cols-3"
        >
            <StatusItem label="State">
                <UnitStateBadge
                    activeState={details.active_state}
                    subState={details.sub_state}
                />
            </StatusItem>
            {enabled === null ? null : (
                <StatusItem label="Unit file">{enabled}</StatusItem>
            )}
            {details.load_state === null ? null : (
                <StatusItem label="Loaded">{details.load_state}</StatusItem>
            )}
            {details.main_pid === null ? null : (
                <StatusItem label="Main PID">{details.main_pid}</StatusItem>
            )}
            {result === null ? null : (
                <StatusItem label="Last result">{result}</StatusItem>
            )}
            {isActive && details.active_enter_timestamp_ms !== null ? (
                <StatusItem label="Active since">
                    <TimestampValue
                        timestampMs={details.active_enter_timestamp_ms}
                        now={now}
                    />
                </StatusItem>
            ) : null}
            {!isActive && details.inactive_enter_timestamp_ms !== null ? (
                <StatusItem label="Inactive since">
                    <TimestampValue
                        timestampMs={details.inactive_enter_timestamp_ms}
                        now={now}
                    />
                </StatusItem>
            ) : null}
            {details.memory_current_bytes === null ? null : (
                <StatusItem label="Memory">
                    {formatSize(details.memory_current_bytes)}
                </StatusItem>
            )}
            {details.cpu_usage_nsec === null ? null : (
                <StatusItem label="CPU">
                    {formatCpu(details.cpu_usage_nsec)}
                </StatusItem>
            )}
            {details.tasks_current === null ? null : (
                <StatusItem label="Tasks">{details.tasks_current}</StatusItem>
            )}
            {details.triggered_by.length === 0 ? null : (
                // Explains why a stopped service starts by itself, and leads to its schedule.
                <StatusItem label="Triggered by">
                    <UnitLinks
                        agent={props.agent}
                        scope={props.scope}
                        units={details.triggered_by}
                    />
                </StatusItem>
            )}
        </dl>
    );
}

/** A warning or hint about the unit, such as unit files that changed since systemd read them. */
function UnitNotice(props: {
    children: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 rounded-md border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-200 @xl:flex-row @xl:items-center @xl:justify-between">
            <p className="flex min-w-0 items-start gap-2">
                <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                />
                <span className="min-w-0 wrap-break-word">
                    {props.children}
                </span>
            </p>
            {props.action}
        </div>
    );
}

/**
 * Links the unit file and its drop-ins to the editor, so changing a unit is one tap away from
 * its status. The file the view is open on is left out: it is the page itself. From a drop-in
 * that leaves the unit file and the other drop-ins.
 */
function UnitFiles(props: {
    agent: Agent;
    /** The unit's manager, named in the links when it is a user's, like the unit lists do. */
    scope: SystemdScope;
    details: SystemdUnitDetailsResponse;
    /** The file whose Systemd view shows the unit. */
    openPath: string;
}) {
    const paths = [
        props.details.fragment_path,
        ...props.details.drop_in_paths,
    ].filter(
        (path): path is string =>
            (path?.startsWith("/") ?? false) && path !== props.openPath,
    );

    if (paths.length === 0) {
        return null;
    }

    return (
        <section aria-label="Unit files" className="flex flex-col gap-1">
            <h3 className="font-semibold text-slate-100">Files</h3>
            <ul className="flex flex-col">
                {paths.map((path) => (
                    <li key={path}>
                        <Link
                            {...browserRoute(props.agent, path)}
                            search={{
                                rev: undefined,
                                systemdScope:
                                    props.scope.type === "user"
                                        ? systemdScopeKey(props.scope)
                                        : undefined,
                            }}
                            aria-label={`Open ${path === props.details.fragment_path ? "unit file" : "drop-in"} ${path}`}
                            className="inline-flex min-h-9 max-w-full items-center gap-2 font-mono text-xs text-blue-300 hover:text-blue-200 hover:underline"
                        >
                            <FileCode
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                            <span className="truncate">{path}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** The loaded unit: heading, actions, notices, status, a timer's schedule, files and the journal. */
function UnitDetails(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    details: SystemdUnitDetailsResponse;
    openPath: string;
}) {
    // One clock for the status and the schedule, so their relative times tick together.
    const now = useNow();
    const details = props.details;

    return (
        <>
            <header className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                <div className="min-w-0">
                    <h2 className="text-xl font-semibold break-all text-slate-100">
                        {details.id}
                    </h2>
                    {details.description ? (
                        <p className="mt-1 text-sm text-slate-400">
                            {details.description}
                        </p>
                    ) : null}
                </div>
                <SystemdUnitActions
                    agent={props.agent}
                    scope={props.scope}
                    unit={props.unit}
                    details={details}
                />
            </header>
            {details.load_state === "not-found" ? (
                <UnitNotice>
                    systemd does not know this unit. Check the name, or run a
                    daemon reload after creating its unit file.
                </UnitNotice>
            ) : null}
            {details.is_agent_unit ? (
                <UnitNotice>
                    Redoor itself runs in this unit. Stopping, restarting or
                    disabling it disconnects {props.agent.name}.
                </UnitNotice>
            ) : null}
            {details.need_daemon_reload ? (
                <UnitNotice
                    action={
                        <DaemonReloadButton
                            agent={props.agent}
                            scope={props.scope}
                            canManage={details.can_manage}
                        />
                    }
                >
                    The unit file changed on disk. Reload systemd to apply the
                    changes.
                </UnitNotice>
            ) : null}
            <UnitStatus
                agent={props.agent}
                scope={props.scope}
                details={details}
                now={now}
            />
            {details.timer === null ? null : (
                <TimerSchedule
                    agent={props.agent}
                    scope={props.scope}
                    timer={details.timer}
                    now={now}
                />
            )}
            <UnitFiles
                agent={props.agent}
                scope={props.scope}
                details={details}
                openPath={props.openPath}
            />
        </>
    );
}

/**
 * One unit of one manager, shown in the Systemd tab of the file that defines it. The status
 * polls while the tab is open, so a unit that crashes or a job that finishes shows without a
 * reload; the journal follows live underneath.
 */
export function SystemdUnitPanel(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: string;
    /** The file the tab is open on, which the file links leave out. */
    openPath: string;
}) {
    const unitQuery = useQuery(
        systemdUnitQueryOptions(props.agent, props.scope, props.unit),
    );

    const body = (() => {
        if (unitQuery.data) {
            return (
                <UnitDetails
                    agent={props.agent}
                    scope={props.scope}
                    unit={props.unit}
                    details={unitQuery.data}
                    openPath={props.openPath}
                />
            );
        }

        if (
            props.scope.type === "user" &&
            isUserManagerNotRunningError(unitQuery.error)
        ) {
            return (
                <UserManagerNotRunning
                    agent={props.agent}
                    user={props.scope.name}
                />
            );
        }

        if (unitQuery.isError) {
            return (
                <SystemdLoadError
                    error={unitQuery.error}
                    fallback={`Could not read ${props.unit}`}
                    onRetry={() => void unitQuery.refetch()}
                />
            );
        }

        return (
            <p role="status" className="text-sm text-slate-400">
                Loading {props.unit}…
            </p>
        );
    })();

    return (
        <div className="flex flex-col gap-4">
            {body}
            <SystemdJournal
                agent={props.agent}
                scope={props.scope}
                unit={props.unit}
            />
        </div>
    );
}
