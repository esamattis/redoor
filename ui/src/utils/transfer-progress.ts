import type { TransferProgressEntry } from "#ui/api-client";

/** Shares one projected snapshot so the pie, percent, and ETA cannot drift apart. */
export type AnimatedTransferProgress = {
    transferredBytes: number;
    percentage: number;
    remainingSeconds: number | null;
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
            remainingSeconds: null,
        };
    }

    if (transfer.total_bytes <= 0) {
        return {
            transferredBytes: Math.max(0, transfer.transferred_bytes),
            percentage: 0,
            remainingSeconds: null,
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
        remainingSeconds: getTransferRemainingSeconds(
            transfer,
            transferredBytes,
            speed,
        ),
    };
}

/** Uses projected bytes so the countdown shrinks with the same animation as the pie. */
export function getTransferRemainingSeconds(
    transfer: TransferProgressEntry,
    transferredBytes: number,
    speedBytesPerSecond: number | null,
): number | null {
    if (transfer.state !== "active") {
        return null;
    }

    if (
        transfer.total_bytes <= 0 ||
        speedBytesPerSecond === null ||
        speedBytesPerSecond <= 0
    ) {
        return null;
    }

    const remainingBytes = transfer.total_bytes - transferredBytes;
    if (remainingBytes <= 0) {
        return 0;
    }

    return remainingBytes / speedBytesPerSecond;
}

/** Keeps remaining time compact enough to sit on the same progress line as speed. */
export function formatRemainingTime(seconds: number | null): string | null {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
        return null;
    }

    if (seconds < 1) {
        return "<1s";
    }

    const totalSeconds = Math.round(seconds);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const restSeconds = totalSeconds % 60;

    if (days > 0) {
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }

    if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }

    if (minutes > 0) {
        return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
    }

    return `${restSeconds}s`;
}
