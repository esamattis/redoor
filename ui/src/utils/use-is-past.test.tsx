// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useIsPast } from "./use-is-past";

const MINUTE = 60_000;

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

test("waits from the current clock when the time moves later", async () => {
    vi.useFakeTimers();
    const start = Date.now();

    const hook = renderHook(
        (props: { time: number }) => useIsPast(props.time),
        {
            initialProps: { time: start + 60 * MINUTE },
        },
    );

    await act(() => vi.advanceTimersByTime(30 * MINUTE));
    // Activity half way through renews a one-hour session.
    hook.rerender({ time: start + 90 * MINUTE });
    await act(() => vi.advanceTimersByTime(60 * MINUTE - 1));
    // Not yet: the renewed time is still a moment away.
    expect(hook.result.current).toBe(false);
    await act(() => vi.advanceTimersByTime(1));
    // Exactly at the renewed time, not an hour after the first render's clock.
    expect(hook.result.current).toBe(true);
});

test("reports a time that already passed at once", async () => {
    vi.useFakeTimers();
    const start = Date.now();

    const hook = renderHook(
        (props: { time: number }) => useIsPast(props.time),
        {
            initialProps: { time: start + MINUTE },
        },
    );

    await act(() => vi.advanceTimersByTime(30 * MINUTE));
    // A time that passed while nothing re-rendered is reported as past.
    hook.rerender({ time: start + 2 * MINUTE });
    expect(hook.result.current).toBe(true);
});
