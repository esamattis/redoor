import type { TransferProgressEntry } from "#ui/api-client";

export type AnimatedTransferProgress = {
    transferredBytes: number;
    percentage: number;
};

/** Uses a one-second floor because finalized API timestamps only have whole-second precision. */
export function getTransferSpeedBytesPerSecond(
    transfer: TransferProgressEntry,
    measuredAtMilliseconds: number = Date.now(),
): number | null {
    const endTime =
        transfer.ended_at === null || transfer.ended_at === undefined
            ? measuredAtMilliseconds / 1000
            : transfer.ended_at;
    const measuredElapsedSeconds = endTime - transfer.started_at;
    const elapsedSeconds =
        transfer.ended_at !== null &&
        transfer.ended_at !== undefined &&
        measuredElapsedSeconds <= 0
            ? 1
            : measuredElapsedSeconds;

    if (elapsedSeconds <= 0) {
        return null;
    }

    return transfer.transferred_bytes / elapsedSeconds;
}

/** Projects progress from one API snapshot while reserving 100% for API-confirmed completion. */
export function getAnimatedTransferProgress(
    transfer: TransferProgressEntry,
    elapsedSinceRefreshSeconds: number,
    refreshedAtMilliseconds: number,
): AnimatedTransferProgress {
    if (transfer.state === "completed") {
        return {
            transferredBytes: transfer.total_bytes,
            percentage: 100,
        };
    }

    if (transfer.total_bytes <= 0) {
        return {
            transferredBytes: Math.max(0, transfer.transferred_bytes),
            percentage: 0,
        };
    }

    const speed = getTransferSpeedBytesPerSecond(
        transfer,
        refreshedAtMilliseconds,
    );
    const projectedBytes =
        transfer.state === "active" && speed !== null
            ? transfer.transferred_bytes +
              speed * Math.max(0, elapsedSinceRefreshSeconds)
            : transfer.transferred_bytes;
    const transferredBytes = Math.min(
        Math.max(0, projectedBytes),
        transfer.total_bytes * 0.99,
    );

    return {
        transferredBytes,
        percentage: (transferredBytes / transfer.total_bytes) * 100,
    };
}
