import * as React from "react";

/**
 * Longest single timeout. Browsers fire longer ones at once (the delay overflows 32 bits
 * after about 24.8 days), so a far-away time is reached in steps.
 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `time` (milliseconds since the epoch) has passed, re-rendering when it does.
 *
 * The delay is measured from the current clock whenever `time` changes, not from the last
 * render's clock, so moving `time` later (such as a renewed session's expiry) waits exactly
 * until the new time.
 */
export function useIsPast(time: number | null): boolean {
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (time === null || now >= time) {
            return;
        }

        const delay = time - Date.now();

        if (delay <= 0) {
            // Guarded by `now < time` above, so this runs once and cannot loop.
            setNow(Date.now());

            return;
        }

        const timer = window.setTimeout(
            () => setNow(Date.now()),
            Math.min(delay, MAX_TIMEOUT_MS),
        );

        return () => window.clearTimeout(timer);
    }, [time, now]);

    return time !== null && now >= time;
}
