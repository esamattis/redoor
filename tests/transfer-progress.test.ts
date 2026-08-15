import { describe, expect, it } from "vitest";

import type { TransferProgressEntry } from "#ui/api-client";
import {
    formatRemainingTime,
    getAnimatedTransferProgress,
    getLastEstimatedTransferProgress,
    getTransferRemainingSeconds,
    getTransferSpeedBytesPerSecond,
} from "#ui/utils/transfer-progress";

/** Creates the smallest representative transfer needed by projection tests. */
function transfer(
    overrides: Partial<TransferProgressEntry> = {},
): TransferProgressEntry {
    return {
        request_id: 1,
        agent_id: "agent-1",
        path: "/file.bin",
        source: null,
        dest: null,
        direction: "download",
        total_bytes: 1000,
        transferred_bytes: 400,
        started_at: 100,
        ended_at: null,
        state: "active",
        error: null,
        ...overrides,
    };
}

describe("transfer progress animation", () => {
    it("projects both bytes and pie percentage at the measured speed", () => {
        const progress = getAnimatedTransferProgress(transfer(), 1, 102_000);

        // Advancing 200 B at the observed 200 B/s proves bytes, pie, and ETA share one projection.
        expect(progress).toEqual({
            transferredBytes: 600,
            percentage: 60,
            remainingSeconds: 2,
        });
    });

    it("caps projected and reported active progress at 99 percent", () => {
        const projected = getAnimatedTransferProgress(transfer(), 10, 102_000);
        const reportedComplete = getAnimatedTransferProgress(
            transfer({ transferred_bytes: 1000 }),
            0,
            102_000,
        );

        // Neither animation nor a pre-completion byte snapshot may claim API completion.
        expect(projected).toEqual({
            transferredBytes: 990,
            percentage: 99,
            remainingSeconds: 0.05,
        });
        expect(reportedComplete).toEqual({
            transferredBytes: 990,
            percentage: 99,
            remainingSeconds: 0.02,
        });
    });

    it("shows 100 percent only for completed API state", () => {
        const progress = getAnimatedTransferProgress(
            transfer({ state: "completed", ended_at: 102 }),
            0,
            102_000,
        );

        // Completion from the API is the sole condition that fills the pie completely.
        expect(progress).toEqual({
            transferredBytes: 1000,
            percentage: 100,
            remainingSeconds: null,
        });
    });

    it("uses the percentage of the transfer estimated to finish last", () => {
        const progress = getLastEstimatedTransferProgress(
            [
                transfer({ request_id: 1, transferred_bytes: 400 }),
                transfer({ request_id: 2, transferred_bytes: 800 }),
            ],
            0,
            102_000,
        );

        // The 40% transfer has three seconds left, so its progress represents overall completion.
        expect(progress?.percentage).toBe(40);
    });

    it("omits an overall percentage when no transfer has an estimate", () => {
        const progress = getLastEstimatedTransferProgress(
            [transfer({ total_bytes: 0 })],
            0,
            102_000,
        );

        // Unknown transfer sizes cannot predict which active transfer will finish last.
        expect(progress).toBeNull();
    });

    it("provides a final speed for transfers completed within one timestamp second", () => {
        const speed = getTransferSpeedBytesPerSecond(
            transfer({
                transferred_bytes: 4096,
                total_bytes: 4096,
                state: "completed",
                ended_at: 100,
            }),
        );

        // Whole-second timestamps can match for quick transfers, but their final speed must remain useful.
        expect(speed).toBe(4096);
    });

    it("estimates remaining time from projected bytes and measured speed", () => {
        const remaining = getTransferRemainingSeconds(transfer(), 600, 200);

        // 400 leftover bytes at 200 B/s is the same projection the pie already advanced to 60%.
        expect(remaining).toBe(2);
    });

    it("hides remaining time when size or speed cannot produce an estimate", () => {
        // Unknown totals, stalled speed, and finished states would otherwise invent a countdown.
        expect(
            getTransferRemainingSeconds(
                transfer({ total_bytes: 0 }),
                0,
                200,
            ),
        ).toBeNull();
        expect(getTransferRemainingSeconds(transfer(), 400, 0)).toBeNull();
        expect(
            getTransferRemainingSeconds(
                transfer({ state: "completed", ended_at: 102 }),
                1000,
                200,
            ),
        ).toBeNull();
    });

    it("formats remaining time compactly for the progress line", () => {
        // Sub-second leftovers still need a visible countdown after the 99% cap.
        expect(formatRemainingTime(0)).toBe("<1s");
        expect(formatRemainingTime(45)).toBe("45s");
        expect(formatRemainingTime(75)).toBe("1m 15s");
        expect(formatRemainingTime(3600)).toBe("1h");
        expect(formatRemainingTime(3661)).toBe("1h 1m");
        expect(formatRemainingTime(90_000)).toBe("1d 1h");
        expect(formatRemainingTime(null)).toBeNull();
    });
});
