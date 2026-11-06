import type { SystemdUnitSummary } from "#bindings/SystemdUnitSummary";
import { formatElapsed } from "#ui/utils/agent-time";

/**
 * Words a timestamp relative to now, like `systemctl list-timers` does with LEFT and PASSED,
 * so "when does it run" reads at a glance. Differences under a second read "now": a timer that
 * just elapsed would otherwise flicker between "in 0s" and "0s ago" until the next poll.
 */
export function formatRelativeTime(targetMs: number, nowMs: number): string {
    const diffMs = targetMs - nowMs;

    if (diffMs >= 1000) {
        return `in ${formatElapsed(diffMs / 1000)}`;
    }

    if (diffMs <= -1000) {
        return `${formatElapsed(-diffMs / 1000)} ago`;
    }

    return "now";
}

/**
 * Orders timers like `systemctl list-timers`: the soonest next run first, so the list answers
 * "what runs next". Timers without a next run (stopped, elapsed one-shots, unloaded) go last,
 * by name, since they have no place on the schedule. Returns a new array; the query cache's
 * list must not be reordered in place.
 */
export function sortTimersByNextRun(
    units: SystemdUnitSummary[],
): SystemdUnitSummary[] {
    return [...units].sort((a, b) => {
        const aNext = a.timer?.next_elapse_ms ?? null;
        const bNext = b.timer?.next_elapse_ms ?? null;

        if (aNext !== bNext) {
            if (aNext === null) return 1;

            if (bNext === null) return -1;

            return aNext - bNext;
        }

        return a.name.localeCompare(b.name);
    });
}
