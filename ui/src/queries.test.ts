import { CancelledError, QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";

import { fetchQueryUncancelled } from "./queries";

test("retries fetchQuery once after a CancelledError", async () => {
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
