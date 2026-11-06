import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, ListFilter } from "lucide-react";
import { z } from "zod";

import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import type { Agent } from "#ui/api-client";
import { ClearableInput } from "#ui/components/clearable-input";
import { Select } from "#ui/components/select";
import { SystemdLoadError } from "#ui/components/systemd/systemd-states";
import { DaemonReloadButton } from "#ui/components/systemd/unit-actions";
import { SystemdUnitFileLink } from "#ui/components/systemd/unit-file-link";
import { UnitStateBadge } from "#ui/components/systemd/unit-state";
import {
    RelativeTimestamp,
    UnitLinks,
} from "#ui/components/systemd/unit-timer";
import { UserManagerNotRunning } from "#ui/components/systemd/user-manager";
import {
    isUserManagerNotRunningError,
    systemdUnitsQueryOptions,
} from "#ui/systemd-queries";
import { useNow } from "#ui/utils/agent-time";
import { cn } from "#ui/utils/cn";
import { sortTimersByNextRun } from "#ui/utils/systemd-timer";
import { systemdUnitFileTarget } from "#ui/utils/systemd-unit-file";

/** The unit type shown when the URL names none; services are what people manage most. */
const DEFAULT_UNIT_TYPE = "service";

/** The `type` value that lifts the type filter. */
const ALL_UNIT_TYPES = "all";

/** The unit type that gets `systemctl list-timers` columns instead of the generic ones. */
const TIMER_UNIT_TYPE = "timer";

/**
 * The timer table's columns: unit, next, last, activates and state. Shared by the header and
 * the rows so they stay aligned.
 */
const TIMER_COLUMNS =
    "@xl:grid-cols-[minmax(0,1.2fr)_8rem_8rem_minmax(0,1.2fr)_11rem]";

/**
 * Rows rendered at most. A full system list with every type can hold thousands of units, and
 * the list re-renders on every poll; past this the filter is the faster way to a unit.
 */
const MAX_RENDERED_UNITS = 1000;

/** The state filter's choices, matched against systemd's `ActiveState`. */
const STATE_FILTERS = ["active", "inactive", "failed"] as const;

type StateFilter = (typeof STATE_FILTERS)[number];

/**
 * The unit list's URL state, so a filtered list can be linked to and survives Back. The keys
 * avoid the device route's search keys (such as `q`), which open the search dialog.
 */
export const systemdUnitListSearchSchema = z.object({
    filter: z.string().optional().catch(undefined),
    type: z
        .string()
        .regex(/^[a-z]+$/)
        .optional()
        .catch(undefined),
    state: z.enum(STATE_FILTERS).optional().catch(undefined),
});

export type SystemdUnitListSearch = z.output<
    typeof systemdUnitListSearchSchema
>;

/** Whether a unit is in the chosen state; units that are only files on disk are inactive. */
function matchesState(unit: SystemdUnitSummary, state: StateFilter): boolean {
    const activeState = unit.active_state ?? "inactive";

    return state === "active"
        ? activeState === "active" || activeState === "reloading"
        : activeState === state;
}

/** Applies the URL's filters in one pass over a list that can hold thousands of units. */
function filterUnits(
    units: SystemdUnitSummary[],
    search: SystemdUnitListSearch,
): SystemdUnitSummary[] {
    const text = (search.filter ?? "").trim().toLowerCase();
    const type = search.type ?? DEFAULT_UNIT_TYPE;

    return units.filter(
        (unit) =>
            (type === ALL_UNIT_TYPES || unit.unit_type === type) &&
            (search.state === undefined || matchesState(unit, search.state)) &&
            (text === "" ||
                unit.name.toLowerCase().includes(text) ||
                (unit.description?.toLowerCase().includes(text) ?? false)),
    );
}

/** The types the type filter offers: those in the list, plus the default even when absent. */
function unitTypes(units: SystemdUnitSummary[], selected: string): string[] {
    const types = new Set(units.map((unit) => unit.unit_type));
    types.add(DEFAULT_UNIT_TYPE);
    types.add(selected);
    types.delete(ALL_UNIT_TYPES);

    return [...types].sort();
}

/** The filters above the list; every value lives in the URL. */
function UnitListFilters(props: {
    search: SystemdUnitListSearch;
    types: string[];
    onSearchChange: (search: SystemdUnitListSearch) => void;
    actions: React.ReactNode;
}) {
    const type = props.search.type ?? DEFAULT_UNIT_TYPE;

    return (
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
            <ClearableInput
                label="Filter units"
                clearLabel="Clear unit filter"
                placeholder="Filter by name or description"
                value={props.search.filter ?? ""}
                onChange={(filter) =>
                    props.onSearchChange({
                        ...props.search,
                        filter: filter === "" ? undefined : filter,
                    })
                }
                className="min-w-0 flex-1"
            />
            <div className="grid grid-cols-2 gap-2 @xl:flex @xl:items-center">
                <Select
                    aria-label="Unit type"
                    value={type}
                    onChange={(event) =>
                        props.onSearchChange({
                            ...props.search,
                            type:
                                event.target.value === DEFAULT_UNIT_TYPE
                                    ? undefined
                                    : event.target.value,
                        })
                    }
                    className="py-1.5 text-sm"
                >
                    <option value={ALL_UNIT_TYPES}>All types</option>
                    {props.types.map((unitType) => (
                        <option key={unitType} value={unitType}>
                            {unitType}
                        </option>
                    ))}
                </Select>
                <Select
                    aria-label="Unit state"
                    value={props.search.state ?? ""}
                    onChange={(event) => {
                        const state = STATE_FILTERS.find(
                            (candidate) => candidate === event.target.value,
                        );

                        props.onSearchChange({ ...props.search, state });
                    }}
                    className="py-1.5 text-sm"
                >
                    <option value="">Any state</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="failed">Failed</option>
                </Select>
            </div>
            {props.actions}
        </div>
    );
}

/**
 * One unit as a table row in wide columns and as a card in phone-narrow ones. The name opens
 * the Systemd view of the unit's file; units without a file are listed unlinked. The card puts
 * the state beside the name, where it is read first, so the DOM follows the card and the
 * table reorders it.
 */
function UnitRow(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: SystemdUnitSummary;
}) {
    return (
        <li
            aria-label={`Unit ${props.unit.name}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-3 last:border-b-0 @xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_11rem_6.5rem] @xl:items-center @xl:gap-4 @xl:py-2"
        >
            <SystemdUnitFileLink
                agent={props.agent}
                scope={props.scope}
                target={systemdUnitFileTarget(props.unit)}
                className="min-w-0 truncate py-1 font-medium @xl:order-1 @xl:py-0"
                title={props.unit.name}
            >
                {props.unit.name}
            </SystemdUnitFileLink>
            <UnitStateBadge
                activeState={props.unit.active_state}
                subState={props.unit.sub_state}
                className="@xl:order-3"
            />
            <span
                className="col-span-2 min-w-0 truncate text-sm text-slate-400 @xl:order-2 @xl:col-span-1"
                title={props.unit.description ?? undefined}
            >
                {props.unit.description ?? (
                    <span className="italic text-slate-500">Not loaded</span>
                )}
            </span>
            <span className="col-span-2 text-xs text-slate-500 @xl:order-4 @xl:col-span-1">
                {props.unit.unit_file_state ?? "no unit file"}
            </span>
        </li>
    );
}

/** A timer cell's label, shown only in the phone-narrow card where there is no header row. */
function TimerCellLabel(props: { children: React.ReactNode }) {
    return (
        <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500 @xl:hidden">
            {props.children}
        </span>
    );
}

/** A missing timer value, for timers systemd has not loaded and so reports no schedule for. */
function NoTimerValue() {
    return <span className="text-slate-500">–</span>;
}

/**
 * One timer as a `systemctl list-timers` row in wide columns and as a card in phone-narrow
 * ones. Like `UnitRow` the DOM follows the card and the table reorders it.
 */
function TimerRow(props: {
    agent: Agent;
    scope: SystemdScope;
    unit: SystemdUnitSummary;
    now: number;
}) {
    const timer = props.unit.timer;

    return (
        <li
            aria-label={`Unit ${props.unit.name}`}
            className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-3 last:border-b-0 @xl:items-center @xl:gap-4 @xl:py-2",
                TIMER_COLUMNS,
            )}
        >
            <SystemdUnitFileLink
                agent={props.agent}
                scope={props.scope}
                target={systemdUnitFileTarget(props.unit)}
                className="min-w-0 truncate py-1 font-medium @xl:order-1 @xl:py-0"
                title={props.unit.description ?? props.unit.name}
            >
                {props.unit.name}
            </SystemdUnitFileLink>
            <UnitStateBadge
                activeState={props.unit.active_state}
                subState={props.unit.sub_state}
                className="@xl:order-5"
            />
            <div className="col-span-2 flex min-w-0 items-baseline gap-2 text-sm text-slate-300 @xl:order-2 @xl:col-span-1">
                <TimerCellLabel>Next</TimerCellLabel>
                {timer === null ? (
                    <NoTimerValue />
                ) : timer.next_elapse_ms === null ? (
                    <span className="text-slate-500">Not scheduled</span>
                ) : (
                    <RelativeTimestamp
                        timestampMs={timer.next_elapse_ms}
                        now={props.now}
                    />
                )}
            </div>
            <div className="col-span-2 flex min-w-0 items-baseline gap-2 text-sm text-slate-300 @xl:order-3 @xl:col-span-1">
                <TimerCellLabel>Last</TimerCellLabel>
                {timer === null ? (
                    <NoTimerValue />
                ) : timer.last_trigger_ms === null ? (
                    <span className="text-slate-500">Never</span>
                ) : (
                    <RelativeTimestamp
                        timestampMs={timer.last_trigger_ms}
                        now={props.now}
                    />
                )}
            </div>
            <div className="col-span-2 flex min-w-0 items-baseline gap-2 text-sm @xl:order-4 @xl:col-span-1">
                <TimerCellLabel>Activates</TimerCellLabel>
                {timer === null || timer.triggers.length === 0 ? (
                    <NoTimerValue />
                ) : (
                    <UnitLinks
                        agent={props.agent}
                        scope={props.scope}
                        units={timer.triggers}
                    />
                )}
            </div>
        </li>
    );
}

/**
 * The timer view of the list, like `systemctl list-timers`. It owns the ticking clock so the
 * countdowns stay current without re-rendering the generic list every second.
 */
function TimerTable(props: {
    agent: Agent;
    scope: SystemdScope;
    title: string;
    units: SystemdUnitSummary[];
}) {
    const now = useNow();

    return (
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-surface">
            <div
                aria-hidden="true"
                className={cn(
                    "hidden gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 @xl:grid",
                    TIMER_COLUMNS,
                )}
            >
                <span>Timer</span>
                <span>Next</span>
                <span>Last</span>
                <span>Activates</span>
                <span>State</span>
            </div>
            <ul aria-label={props.title}>
                {props.units.map((unit) => (
                    <TimerRow
                        key={unit.name}
                        agent={props.agent}
                        scope={props.scope}
                        unit={unit}
                        now={now}
                    />
                ))}
            </ul>
        </div>
    );
}

/**
 * Lists one manager's units with filters in the URL, polling while it is on screen so units
 * that start, stop or fail on their own show it.
 */
export function SystemdUnitList(props: {
    agent: Agent;
    scope: SystemdScope;
    /** Shown above the filters, such as a user's linger. */
    header?: React.ReactNode;
    search: SystemdUnitListSearch;
    onSearchChange: (search: SystemdUnitListSearch) => void;
}) {
    const unitsQuery = useQuery(
        systemdUnitsQueryOptions(props.agent, props.scope),
    );

    const units = unitsQuery.data?.units ?? [];
    const filtered = filterUnits(units, props.search);

    const isTimerView =
        (props.search.type ?? DEFAULT_UNIT_TYPE) === TIMER_UNIT_TYPE;

    // Timers read best soonest first, like `list-timers`; other units keep systemd's name order.
    const ordered = isTimerView ? sortTimersByNextRun(filtered) : filtered;
    const shown = ordered.slice(0, MAX_RENDERED_UNITS);

    const title =
        props.scope.type === "system"
            ? "System units"
            : `Units of ${props.scope.name}`;

    const content = (() => {
        if (unitsQuery.isError && props.scope.type === "user") {
            if (isUserManagerNotRunningError(unitsQuery.error)) {
                return (
                    <UserManagerNotRunning
                        agent={props.agent}
                        user={props.scope.name}
                    />
                );
            }
        }

        if (unitsQuery.isError && unitsQuery.data === undefined) {
            return (
                <SystemdLoadError
                    error={unitsQuery.error}
                    fallback="Could not list units"
                    onRetry={() => void unitsQuery.refetch()}
                />
            );
        }

        if (unitsQuery.isPending) {
            return (
                <p role="status" className="px-1 text-sm text-slate-400">
                    Loading units…
                </p>
            );
        }

        if (shown.length === 0) {
            return (
                <section className="rounded-lg border border-dashed border-slate-700 bg-slate-900/25 px-6 py-12 text-center">
                    <ListFilter
                        className="mx-auto h-8 w-8 text-slate-600"
                        aria-hidden="true"
                    />
                    <p className="mt-3 text-sm text-slate-400">
                        No units match the filters.
                    </p>
                </section>
            );
        }

        if (isTimerView) {
            return (
                <TimerTable
                    agent={props.agent}
                    scope={props.scope}
                    title={title}
                    units={shown}
                />
            );
        }

        return (
            <div className="overflow-hidden rounded-lg border border-slate-800 bg-surface">
                <div
                    aria-hidden="true"
                    className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_11rem_6.5rem] gap-4 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 @xl:grid"
                >
                    <span>Unit</span>
                    <span>Description</span>
                    <span>State</span>
                    <span>Unit file</span>
                </div>
                <ul aria-label={title}>
                    {shown.map((unit) => (
                        <UnitRow
                            key={unit.name}
                            agent={props.agent}
                            scope={props.scope}
                            unit={unit}
                        />
                    ))}
                </ul>
            </div>
        );
    })();

    return (
        <div className="flex flex-col gap-4">
            {props.header}
            <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-100">
                    {title}
                </h2>
                {unitsQuery.data ? (
                    <span className="text-sm tabular-nums text-slate-500">
                        {filtered.length === units.length
                            ? `${units.length} units`
                            : `${filtered.length} of ${units.length}`}
                    </span>
                ) : null}
            </div>
            <UnitListFilters
                search={props.search}
                types={unitTypes(units, props.search.type ?? DEFAULT_UNIT_TYPE)}
                onSearchChange={props.onSearchChange}
                actions={
                    <DaemonReloadButton
                        agent={props.agent}
                        scope={props.scope}
                        canManage={unitsQuery.data?.can_manage ?? false}
                    />
                }
            />
            {unitsQuery.data && !unitsQuery.data.can_manage ? (
                <Notice>
                    Read-only: the agent does not run as root, so it can show
                    system units but not change them.
                </Notice>
            ) : null}
            {unitsQuery.data?.truncated ? (
                <Notice>
                    The device has more units than one response can carry; some
                    are missing from this list.
                </Notice>
            ) : null}
            {filtered.length > shown.length ? (
                <Notice>
                    Showing the first {shown.length} of {filtered.length}{" "}
                    matching units. Filter the list to find the others.
                </Notice>
            ) : null}
            {content}
        </div>
    );
}

/** A one-line explanation above the list, for read-only and incomplete lists. */
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
