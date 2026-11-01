import type {
    FetchQueryOptions,
    QueryClient,
    QueryKey,
} from "@tanstack/react-query";

/** How long a restart may take before the wait reports it as failed. */
const RESTART_TIMEOUT_MS = 30_000;

/**
 * How long one readiness request may take. A request to a process that is shutting down can
 * hang, and the overall deadline is only checked between attempts.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** Polls a target-specific probe until it proves the replacement process is ready. */
export async function waitForRestart(
    probe: () => Promise<void>,
    timeoutMessage: string,
): Promise<void> {
    const deadline = Date.now() + RESTART_TIMEOUT_MS;

    while (Date.now() < deadline) {
        try {
            await probe();

            return;
        } catch {
            // The target is still shutting down or starting up.
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(timeoutMessage);
}

/**
 * Fetches a query from the server for a restart probe, giving up after `PROBE_TIMEOUT_MS`.
 *
 * The query is cancelled rather than abandoned: TanStack Query hands every later fetch of a
 * key the promise of the fetch still in flight, so one hung request would otherwise answer
 * every following attempt too.
 */
export async function fetchForRestartProbe<TData, TQueryKey extends QueryKey>(
    queryClient: QueryClient,
    options: FetchQueryOptions<TData, Error, TData, TQueryKey>,
): Promise<TData> {
    const timer = setTimeout(() => {
        void queryClient.cancelQueries({
            queryKey: options.queryKey,
            exact: true,
        });
    }, PROBE_TIMEOUT_MS);

    try {
        return await queryClient.fetchQuery({ ...options, staleTime: 0 });
    } finally {
        clearTimeout(timer);
    }
}
