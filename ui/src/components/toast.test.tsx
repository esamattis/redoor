// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Toast } from "./toast";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

test("dismisses after 15 seconds", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
        <Toast tone="info" onDismiss={onDismiss}>
            Saved
        </Toast>,
    );

    await act(() => vi.advanceTimersByTime(14_999));
    // The toast must remain available for the full display duration.
    expect(onDismiss).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    // The shared timeout closes the owning toast state exactly once.
    expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("dismisses on an outside pointer interaction but not an inside one", () => {
    const onDismiss = vi.fn();
    render(
        <Toast tone="success" onDismiss={onDismiss}>
            Uploaded
        </Toast>,
    );

    fireEvent.pointerDown(screen.getByRole("status"));
    // Interacting with toast content must leave it visible.
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    // Any pointer interaction elsewhere dismisses the transient feedback.
    expect(onDismiss).toHaveBeenCalledTimes(1);
});
