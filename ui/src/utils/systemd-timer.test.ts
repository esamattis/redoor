import { describe, expect, test } from "vitest";

import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import {
    formatRelativeTime,
    sortTimersByNextRun,
} from "#ui/utils/systemd-timer";

/** A loaded timer summary with only the fields the sort reads varying. */
function timer(name: string, nextMs: number | null): SystemdUnitSummary {
    return {
        name,
        unit_type: "timer",
        description: null,
        load_state: "loaded",
        active_state: "active",
        sub_state: "waiting",
        unit_file_state: "enabled",
        fragment_path: `/etc/systemd/system/${name}`,
        timer: {
            next_elapse_ms: nextMs,
            last_trigger_ms: null,
            triggers: [],
        },
    };
}

describe("formatRelativeTime", () => {
    const nowMs = 1_700_000_000_000;

    test("future times read as a countdown", () => {
        // The next run must read like list-timers' LEFT column.
        expect(
            formatRelativeTime(nowMs + (3 * 3600 + 20 * 60) * 1000, nowMs),
        ).toBe("in 3h 20m");
    });

    test("past times read as an age", () => {
        // The last run must read like list-timers' PASSED column.
        expect(formatRelativeTime(nowMs - 5 * 60 * 1000, nowMs)).toBe(
            "5m 0s ago",
        );
    });

    test("sub-second differences read as now", () => {
        // A timer elapsing between polls must not flip between "in 0s" and "0s ago".
        expect(formatRelativeTime(nowMs + 400, nowMs)).toBe("now");
        expect(formatRelativeTime(nowMs - 400, nowMs)).toBe("now");
    });
});

describe("sortTimersByNextRun", () => {
    test("orders the soonest next run first and unscheduled timers last by name", () => {
        const unscheduled: SystemdUnitSummary = {
            ...timer("a-unloaded.timer", null),
            timer: null,
        };

        const units = [
            timer("z-stopped.timer", null),
            timer("late.timer", 3000),
            unscheduled,
            timer("soon.timer", 1000),
        ];

        // The list must answer "what runs next" first, with unscheduled timers out of the way.
        expect(sortTimersByNextRun(units).map((unit) => unit.name)).toEqual([
            "soon.timer",
            "late.timer",
            "a-unloaded.timer",
            "z-stopped.timer",
        ]);
        // The cached query data must not be reordered in place.
        expect(units[0]?.name).toBe("z-stopped.timer");
    });
});
