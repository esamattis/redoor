import { QueryObserver } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import type { ApiClient } from "#ui/api-client";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import { watchedTransfersQueryOptions } from "#ui/queries";

/** Describes what a wait needs: where to read transfers, and when they are done. */
type WaitForTransfersOptions = {
    queryClient: QueryClient;
    api: ApiClient;
    /**
     * Inspects the latest transfer list and returns true once nothing more is awaited. It runs
     * once per fresh list, never concurrently, and may throw to fail the wait.
     */
    isSettled: (
        transfers: TransferProgressEntry[],
    ) => boolean | Promise<boolean>;
    /** Stops the wait, for example when the component that started it goes away. */
    signal?: AbortSignal;
};

/**
 * Waits for transfers the caller started, such as a duplicate or a batch move, by watching the
 * shared transfers query. Server events and a short poll both refresh that query, so there is
 * no hand-written polling loop per feature. Resolves true once `isSettled` is satisfied and
 * false if the signal aborted first. A failed read or a throwing `isSettled` rejects.
 */
export function waitForTransfers(
    options: WaitForTransfersOptions,
): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const startedAt = Date.now();

        const observer = new QueryObserver(
            options.queryClient,
            watchedTransfersQueryOptions(options.api),
        );

        let isFinished = false;
        let pending = Promise.resolve();
        let unsubscribe = () => {};

        const finish = (settle: () => void) => {
            if (isFinished) {
                return;
            }

            isFinished = true;
            unsubscribe();
            options.signal?.removeEventListener("abort", abort);
            settle();
        };

        const abort = () => finish(() => resolve(false));

        /** Checks one list after the previous check completed, so async checks cannot overlap. */
        const check = (transfers: TransferProgressEntry[]) => {
            pending = pending.then(async () => {
                if (isFinished) {
                    return;
                }

                try {
                    if (await options.isSettled(transfers)) {
                        finish(() => resolve(true));
                    }
                } catch (error) {
                    finish(() => reject(error));
                }
            });
        };

        unsubscribe = observer.subscribe((result) => {
            if (result.isError) {
                finish(() => reject(result.error));

                return;
            }

            // Data cached before this wait began cannot mention the transfer it is waiting for.
            if (
                result.data !== undefined &&
                result.dataUpdatedAt >= startedAt
            ) {
                check(result.data.transfers);
            }
        });

        if (options.signal?.aborted === true) {
            abort();

            return;
        }

        options.signal?.addEventListener("abort", abort);
    });
}
