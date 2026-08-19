import { describe, expect, test } from "vitest";

import {
    formatElapsedSecsMs,
    provisioningElapsedFromStartMs,
    provisioningElapsedTooltip,
    provisioningStepElapsedMs,
} from "#ui/utils/agent-time";

describe("provisioning step elapsed time", () => {
    const messages = [
        { at: 1_700_000_100_000 },
        { at: 1_700_000_130_250 },
        { at: 1_700_000_145_000 },
    ];
    const nowMs = 1_700_000_160_500;

    test("visible labels accumulate from the first stamp", () => {
        // The list should read as a timeline from attempt start, not per-step diffs.
        expect(
            provisioningElapsedFromStartMs({ messages, index: 0, nowMs }),
        ).toBe(0);
        expect(
            provisioningElapsedFromStartMs({ messages, index: 1, nowMs }),
        ).toBe(30_250);
        expect(
            provisioningElapsedFromStartMs({ messages, index: 2, nowMs }),
        ).toBe(60_500);
    });

    test("tooltip diffs are the gap from the previous stamp", () => {
        // Later rows must use this-minus-previous, not this-step duration.
        expect(
            provisioningStepElapsedMs({ messages, index: 0, nowMs }),
        ).toBe(30_250);
        expect(
            provisioningStepElapsedMs({ messages, index: 1, nowMs }),
        ).toBe(30_250);
        expect(
            provisioningStepElapsedMs({ messages, index: 2, nowMs }),
        ).toBe(14_750);
    });

    test("missing index does not invent a duration", () => {
        expect(
            provisioningElapsedFromStartMs({ messages, index: 9, nowMs }),
        ).toBe(0);
    });

    test("formats whole seconds plus leftover milliseconds", () => {
        expect(formatElapsedSecsMs(30_250)).toBe("30s 250ms");
        expect(formatElapsedSecsMs(0)).toBe("0s 000ms");
    });

    test("tooltip names the previous-step delta", () => {
        expect(provisioningElapsedTooltip("30s 250ms", 0, 3)).toContain(
            "30s 250ms until the next step",
        );
        expect(provisioningElapsedTooltip("14s 750ms", 1, 3)).toContain(
            "14s 750ms after the previous step",
        );
    });

    test("treats leftover second stamps as seconds", () => {
        // Older localStorage wrote unix seconds; those must not be read as millis.
        expect(
            provisioningStepElapsedMs({
                messages: [{ at: 100 }, { at: 130 }],
                index: 0,
                nowMs: 160_000,
            }),
        ).toBe(30_000);
    });
});
