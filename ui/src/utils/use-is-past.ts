import * as React from "react";

/**
 * Longest single timeout. Browsers fire longer ones at once (the delay overflows 32 bits
 * after about 24.8 days), so a far-away time is reached in steps.
 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Subscribes to the system clock until `time` passes, stepping around 32-bit timer caps. */
function subscribeUntil(
    time: number | null,
    onStoreChange: () => void,
): () => void {
    if (time === null) {
        return () => undefined;
    }

    let timer: number | undefined;

    const schedule = () => {
        const delay = time - Date.now();

        if (delay <= 0) {
            onStoreChange();

            return;
        }

        timer = window.setTimeout(schedule, Math.min(delay, MAX_TIMEOUT_MS));
    };

    const initialDelay = time - Date.now();

    if (initialDelay > 0) {
        timer = window.setTimeout(
            schedule,
            Math.min(initialDelay, MAX_TIMEOUT_MS),
        );
    }

    return () => {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
    };
}

/**
 * Whether `time` (milliseconds since the epoch) has passed, re-rendering when it does.
 *
 * The delay is measured from the current clock whenever `time` changes, not from the last
 * render's clock, so moving `time` later (such as a renewed session's expiry) waits exactly
 * until the new time.
 */
export function useIsPast(time: number | null): boolean {
    const subscribe = React.useCallback(
        (onStoreChange: () => void) => subscribeUntil(time, onStoreChange),
        [time],
    );

    return React.useSyncExternalStore(
        subscribe,
        () => time !== null && Date.now() >= time,
    );
}
