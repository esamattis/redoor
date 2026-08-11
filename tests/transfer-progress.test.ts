import { describe, expect, it } from "vitest";

import type { TransferProgressEntry } from "#ui/api-client";
import {
    getAnimatedTransferProgress,
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

        // Advancing 200 B at the observed 200 B/s proves bytes and pie share one projection.
        expect(progress).toEqual({
            transferredBytes: 600,
            percentage: 60,
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
        });
        expect(reportedComplete).toEqual({
            transferredBytes: 990,
            percentage: 99,
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
        });
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
});
