import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { GitWorktreeStatusEntry } from "#bindings/GitWorktreeStatusEntry";
import type { GitWorktreeStatusResponse } from "#bindings/GitWorktreeStatusResponse";
import { WorktreeStatusBatcher } from "./worktree-status-batcher";

/** One request the fake agent received, answered or failed by the test when it chooses. */
type PendingRequest = {
    paths: string[];
    signal: AbortSignal | undefined;
    answer: (statuses: GitWorktreeStatusEntry[]) => void;
};

/** A fake agent that records each request and lets the test answer it later. */
function fakeAgent() {
    const requests: PendingRequest[] = [];

    const agent = {
        id: "agent",
        gitWorktreeStatus(
            paths: string[],
            options: { signal?: AbortSignal } = {},
        ): Promise<GitWorktreeStatusResponse> {
            return new Promise((resolve, reject) => {
                options.signal?.addEventListener("abort", () =>
                    reject(options.signal?.reason),
                );
                requests.push({
                    paths,
                    signal: options.signal,
                    answer: (statuses) => resolve({ statuses }),
                });
            });
        },
    };

    return { agent, requests };
}

/** A counted entry with the given number of tracked changes. */
function counted(path: string, changed: number): GitWorktreeStatusEntry {
    return {
        path,
        result: { type: "counted", changed, untracked: 0, truncated: false },
    };
}

/** Lets the batch delay pass and any settled request finish its bookkeeping. */
async function flush() {
    await vi.advanceTimersByTimeAsync(20);
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

test("rows that ask together share one request", async () => {
    const { agent, requests } = fakeAgent();
    const batcher = new WorktreeStatusBatcher(agent);
    const signal = new AbortController().signal;

    const first = batcher.load("/a", signal);
    const second = batcher.load("/b", signal);
    const failing = batcher.load("/c", signal);
    const sameAsSecond = batcher.load("/b", signal);
    await flush();

    // Every row goes out in a single request, and a repeated path is asked for once.
    expect(requests.map((request) => request.paths)).toEqual([
        ["/a", "/b", "/c"],
    ]);

    requests[0]?.answer([
        counted("/a", 1),
        counted("/b", 2),
        { path: "/c", result: { type: "failed", message: "not a repo" } },
    ]);

    // Each row gets the counts of its own path.
    await expect(first).resolves.toMatchObject({ changed: 1 });
    await expect(second).resolves.toMatchObject({ changed: 2 });
    await expect(sameAsSecond).resolves.toMatchObject({ changed: 2 });
    // A checkout that could not be counted fails only its own row.
    await expect(failing).rejects.toThrow("not a repo");
});

test("asks again first for the paths the agent did not reach, one request at a time", async () => {
    const { agent, requests } = fakeAgent();
    const batcher = new WorktreeStatusBatcher(agent);
    const signal = new AbortController().signal;

    const first = batcher.load("/a", signal);
    const second = batcher.load("/b", signal);
    await flush();
    const later = batcher.load("/c", signal);
    await flush();

    // A row asking while a request is in flight waits instead of opening another connection.
    expect(requests).toHaveLength(1);

    requests[0]?.answer([counted("/a", 1)]);
    await expect(first).resolves.toMatchObject({ changed: 1 });
    await flush();

    // The unreached path leads the next request, followed by the row that asked meanwhile.
    expect(requests[1]?.paths).toEqual(["/b", "/c"]);

    requests[1]?.answer([counted("/c", 3), counted("/b", 2)]);

    // Both remaining rows settle from the follow-up request.
    await expect(second).resolves.toMatchObject({ changed: 2 });
    await expect(later).resolves.toMatchObject({ changed: 3 });
});

test("cancels the request once no row waits for it", async () => {
    const { agent, requests } = fakeAgent();
    const batcher = new WorktreeStatusBatcher(agent);
    const firstRow = new AbortController();
    const secondRow = new AbortController();

    const first = batcher.load("/a", firstRow.signal);
    const second = batcher.load("/b", secondRow.signal);
    await flush();

    firstRow.abort();

    // A cancelled row settles at once.
    await expect(first).rejects.toBeDefined();
    // Another row still waits, so the request keeps running for it.
    expect(requests[0]?.signal?.aborted).toBe(false);

    secondRow.abort();
    await expect(second).rejects.toBeDefined();

    // Leaving the list frees the connection and the agent's walks.
    expect(requests[0]?.signal?.aborted).toBe(true);
    await flush();
    // Nothing is left to ask for, so no follow-up request goes out.
    expect(requests).toHaveLength(1);
});

test("does not send rows that were cancelled before their request went out", async () => {
    const { agent, requests } = fakeAgent();
    const batcher = new WorktreeStatusBatcher(agent);
    const row = new AbortController();

    const status = batcher.load("/a", row.signal);
    row.abort();
    await expect(status).rejects.toBeDefined();
    await flush();

    // A row that left before the batch delay never reaches the agent.
    expect(requests).toHaveLength(0);
});
