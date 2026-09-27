import { CancelledError, QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";

import { fetchQueryUncancelled } from "./queries";

test("retries fetchQuery after a CancelledError", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    let attempts = 0;
    const result = await fetchQueryUncancelled(queryClient, {
        queryKey: ["file-content", "retry"],
        queryFn: () => {
            attempts += 1;
            if (attempts === 1) {
                throw new CancelledError({ silent: true });
            }
            return "ok";
        },
    });

    // A concurrent invalidate must not surface as a failed file-create navigation.
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
});

test("an awaited loader fetch survives successive query invalidations", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const queryKey = ["loader", "refresh-race"];
    queryClient.setQueryData(queryKey, "old");
    const requests: Array<{ resolve: (value: string) => void }> = [];
    const started: Array<() => void> = [];
    const options = {
        queryKey,
        staleTime: 0,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
            new Promise<string>((resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
                requests.push({ resolve });
                started.shift()?.();
            }),
    };
    /** Waits for each actual fetch rather than relying on a timer to reproduce the race. */
    const waitForRequest = (count: number) =>
        requests.length >= count
            ? Promise.resolve()
            : new Promise<void>((resolve) => started.push(resolve));

    const loader = fetchQueryUncancelled(queryClient, options);
    await waitForRequest(1);
    // The first invalidation cancels the fetch a route loader is awaiting.
    const firstRefresh = queryClient.invalidateQueries({
        queryKey,
        refetchType: "all",
    });
    await waitForRequest(2);
    // A second event can cancel the retry too; one retry is not sufficient.
    const secondRefresh = queryClient.invalidateQueries({
        queryKey,
        refetchType: "all",
    });
    await waitForRequest(3);
    requests[2]?.resolve("fresh");

    // Neither refresh should replace a successful route load with CancelledError.
    await expect(loader).resolves.toBe("fresh");
    await Promise.all([firstRefresh, secondRefresh]);
    expect(requests).toHaveLength(3);
});

test("does not retry unrelated fetchQuery failures", async () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const error = new Error("disk full");
    let attempts = 0;

    await expect(
        fetchQueryUncancelled(queryClient, {
            queryKey: ["file-content", "failure"],
            queryFn: () => {
                attempts += 1;
                throw error;
            },
        }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
});
