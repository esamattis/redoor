import { afterEach, describe, expect, it, vi } from "vitest";
import { OneShotTerminalCommand } from "#ui/terminal/one-shot-command";

/** Creates the small socket contract without coupling timing tests to browser websocket setup. */
function createSocket(send: (payload: ArrayBuffer) => void) {
    return { readyState: 1, send };
}

describe("OneShotTerminalCommand", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("delays the first ready command and ignores duplicate ready frames", () => {
        vi.useFakeTimers();
        const send = vi.fn();
        const onSent = vi.fn();
        const command = new OneShotTerminalCommand("extract", onSent);
        const socket = createSocket(send);

        expect(command.reserve(socket, () => true)).toBe(true);
        // A duplicate ready frame must not reserve a second extraction.
        expect(command.reserve(socket, () => true)).toBe(false);
        vi.advanceTimersByTime(199);
        // The shell needs its full settling delay before startup input is written.
        expect(send).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        // Exactly one command is sent once the 200 ms boundary is reached.
        expect(send).toHaveBeenCalledTimes(1);
        // Successful delivery is the only event that earns a listing refresh.
        expect(onSent).toHaveBeenCalledTimes(1);
    });

    it("guards replaced sessions and cleans pending timers", () => {
        vi.useFakeTimers();
        const replacedSend = vi.fn();
        const replacedSent = vi.fn();
        const replaced = new OneShotTerminalCommand("extract", replacedSent);
        replaced.reserve(createSocket(replacedSend), () => false);
        vi.advanceTimersByTime(200);
        // A stale generation or replaced socket must never receive startup input.
        expect(replacedSend).not.toHaveBeenCalled();
        expect(replacedSent).not.toHaveBeenCalled();

        const cleanedSend = vi.fn();
        const cleaned = new OneShotTerminalCommand("extract", vi.fn());
        cleaned.reserve(createSocket(cleanedSend), () => true);
        cleaned.cancelPending();
        vi.runAllTimers();
        // Closing a tab or unmounting its session must clear delayed input.
        expect(cleanedSend).not.toHaveBeenCalled();
        // Cleanup keeps the consumed command from replaying after a restart.
        expect(cleaned.reserve(createSocket(cleanedSend), () => true)).toBe(
            false,
        );
    });

    it("emits sent only when the socket accepts the command", () => {
        vi.useFakeTimers();
        const onSent = vi.fn();
        const command = new OneShotTerminalCommand("extract", onSent);
        command.reserve(
            createSocket(() => {
                throw new Error("closed during send");
            }),
            () => true,
        );
        vi.advanceTimersByTime(200);
        // Failed websocket writes must not schedule a misleading listing refresh.
        expect(onSent).not.toHaveBeenCalled();
    });
});
