import * as React from "react";

/** Time elapsed since one snapshot of transfer data was received. */
export type TransferClockFrame<Snapshot> = {
    snapshot: Snapshot;
    refreshedAtMilliseconds: number;
    elapsedSeconds: number;
};

/**
 * Restarts the projection clock from each API snapshot and advances it at animation-frame
 * cadence while `shouldAnimate` says the snapshot still has moving progress. The per-row
 * progress cell and the drawer badge share it so they cannot drift apart. Callers must keep
 * the component that uses it small, because it rerenders on every frame.
 */
export function useTransferClock<Snapshot>(
    snapshot: Snapshot,
    shouldAnimate: (
        snapshot: Snapshot,
        refreshedAtMilliseconds: number,
    ) => boolean,
): TransferClockFrame<Snapshot> {
    const [frame, setFrame] = React.useState(() => ({
        snapshot,
        refreshedAtMilliseconds: Date.now(),
        elapsedSeconds: 0,
    }));

    React.useEffect(() => {
        const refreshedAtMilliseconds = Date.now();
        const keepAnimating = shouldAnimate(snapshot, refreshedAtMilliseconds);
        let frameRequest: number;

        const updateFrame = () => {
            setFrame({
                snapshot,
                refreshedAtMilliseconds,
                elapsedSeconds: (Date.now() - refreshedAtMilliseconds) / 1000,
            });

            if (keepAnimating) {
                frameRequest = window.requestAnimationFrame(updateFrame);
            }
        };

        frameRequest = window.requestAnimationFrame(updateFrame);

        return () => window.cancelAnimationFrame(frameRequest);
    }, [snapshot, shouldAnimate]);

    // A new snapshot arrived but its first frame has not run yet: start its projection at zero.
    if (frame.snapshot !== snapshot) {
        return {
            snapshot,
            refreshedAtMilliseconds: frame.refreshedAtMilliseconds,
            elapsedSeconds: 0,
        };
    }

    return frame;
}
