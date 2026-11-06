import type * as React from "react";

import type { SystemdScope } from "#bindings/SystemdScope";
import type { SystemdTimerInfo } from "#bindings/SystemdTimerInfo";
import type { Agent } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
import { SystemdUnitNameLink } from "#ui/components/systemd/unit-file-link";
import { cn } from "#ui/utils/cn";
import { formatRelativeTime } from "#ui/utils/systemd-timer";

/** Formats systemd timestamps in the reader's locale, since they are wall-clock moments. */
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
});

/**
 * A timestamp spelled out with how far it is from now, ticking with `now` so "5m ago" or
 * "in 3h 20m" stays right while the page is open.
 */
export function TimestampValue(props: { timestampMs: number; now: number }) {
    const date = new Date(props.timestampMs);

    return (
        <time dateTime={date.toISOString()}>
            {dateTimeFormat.format(date)}{" "}
            <span className="text-slate-500">
                ({formatRelativeTime(props.timestampMs, props.now)})
            </span>
        </time>
    );
}

/**
 * Only the relative part of a timestamp, for list cells where the full date does not fit;
 * the exact time stays one hover or tap away in the tooltip.
 */
export function RelativeTimestamp(props: { timestampMs: number; now: number }) {
    const date = new Date(props.timestampMs);

    return (
        <Tooltip content={dateTimeFormat.format(date)}>
            <time dateTime={date.toISOString()} className="tabular-nums">
                {formatRelativeTime(props.timestampMs, props.now)}
            </time>
        </Tooltip>
    );
}

/**
 * Links to other units of the same manager, such as the service a timer activates or the
 * timer that activates a service, so the pair is one tap apart. Units without a file of their
 * own have no view to open and are listed as plain names.
 */
export function UnitLinks(props: {
    agent: Agent;
    scope: SystemdScope;
    units: string[];
    className?: string;
}) {
    return (
        <ul className={cn("flex min-w-0 flex-col", props.className)}>
            {props.units.map((unit) => (
                <li key={unit} className="min-w-0">
                    <SystemdUnitNameLink
                        agent={props.agent}
                        scope={props.scope}
                        unit={unit}
                        className="inline-block max-w-full truncate align-bottom"
                    />
                </li>
            ))}
        </ul>
    );
}

/** One labelled value of the schedule card, laid out like the status card's items. */
function ScheduleItem(props: {
    label: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cn("min-w-0", props.className)}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {props.label}
            </dt>
            <dd className="mt-1 wrap-break-word text-sm text-slate-200">
                {props.children}
            </dd>
        </div>
    );
}

/**
 * A timer's schedule in the terms of `systemctl status` and `list-timers`: its rules, when it
 * runs next and ran last, and what it starts. A timer's own state ("active (waiting)") says
 * little; when it fires is what people open a timer for.
 */
export function TimerSchedule(props: {
    agent: Agent;
    scope: SystemdScope;
    timer: SystemdTimerInfo;
    now: number;
}) {
    const timer = props.timer;

    return (
        <section
            aria-label="Timer schedule"
            className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-surface p-4"
        >
            <h3 className="font-semibold text-slate-100">Schedule</h3>
            <dl className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
                <ScheduleItem
                    label="Rules"
                    className="@xl:col-span-2 @4xl:col-span-3"
                >
                    {timer.schedules.length === 0 ? (
                        <span className="text-slate-400">None</span>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {timer.schedules.map((schedule) => (
                                <li
                                    key={schedule}
                                    className="font-mono text-xs break-all"
                                >
                                    {schedule}
                                </li>
                            ))}
                        </ul>
                    )}
                </ScheduleItem>
                <ScheduleItem label="Next run">
                    {timer.next_elapse_ms === null ? (
                        "Not scheduled"
                    ) : (
                        <TimestampValue
                            timestampMs={timer.next_elapse_ms}
                            now={props.now}
                        />
                    )}
                </ScheduleItem>
                <ScheduleItem label="Last run">
                    {timer.last_trigger_ms === null ? (
                        "Never"
                    ) : (
                        <TimestampValue
                            timestampMs={timer.last_trigger_ms}
                            now={props.now}
                        />
                    )}
                </ScheduleItem>
                <ScheduleItem label="Persistent">
                    <Tooltip
                        content={
                            timer.persistent
                                ? "Runs missed while the device was off or the timer was stopped happen as soon as it starts again."
                                : "Runs missed while the device was off or the timer was stopped are skipped."
                        }
                    >
                        <span className="cursor-help underline decoration-slate-600 decoration-dotted underline-offset-4">
                            {timer.persistent ? "Yes" : "No"}
                        </span>
                    </Tooltip>
                </ScheduleItem>
                <ScheduleItem label="Activates">
                    {timer.triggers.length === 0 ? (
                        <span className="text-slate-400">Nothing</span>
                    ) : (
                        <UnitLinks
                            agent={props.agent}
                            scope={props.scope}
                            units={timer.triggers}
                        />
                    )}
                </ScheduleItem>
            </dl>
        </section>
    );
}
