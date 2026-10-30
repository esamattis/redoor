import { CancelledError, QueryClient } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { expect, test, vi } from "vitest";

import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import { ApiClient } from "#ui/api-client";
import {
    agentsQueryOptions,
    fetchQueryUncancelled,
    fileContentQueryOptions,
    invalidateAgentData,
    invalidateAllAgentData,
    loadAgentByName,
    queryKeys,
} from "./queries";
import { agentsWithReplacedConnection } from "./refresh-listener";

/** Builds a complete inventory entry so tests only spell out the fields they vary. */
function agentInfo(
    id: string,
    overrides: Partial<AgentInfoResponse> = {},
): AgentInfoResponse {
    return {
        id,
        name: id,
        cwd: "/home",
        managed: false,
        configuration_editable: false,
        ssh_target: null,
        status: "connected",
        connected_at: 1,
        connection_id: `${id}-socket-1`,
        last_seen_at: null,
        connection_issue: null,
        provisioning_status: [],
        binary: null,
        supports_native_open: false,
        supports_move_to_trash: false,
        supports_trash: false,
        uid: 1000,
        is_root: false,
        duplicate_id: null,
        ...overrides,
    };
}

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

test("agent-wide invalidation refreshes mirrors but never editor buffers", async () => {
    const queryClient = new QueryClient();
    const api = new ApiClient("http://localhost");
    const agent = api.agentFor(agentInfo("a"));
    const listingKey = queryKeys.browserListing("a", "/home");
    const gitKey = queryKeys.gitStatus("a", "/home");
    const otherAgentKey = queryKeys.browserListing("b", "/home");
    const contentOptions = fileContentQueryOptions(agent, "/home/file.txt");
    queryClient.setQueryData(listingKey, "listing");
    queryClient.setQueryData(gitKey, "status");
    queryClient.setQueryData(otherAgentKey, "other listing");
    queryClient.setQueryData(queryKeys.agents(), []);

    // The editor buffer is fetched through its real options so it carries the same meta.
    await queryClient.fetchQuery({
        ...contentOptions,
        queryFn: () => "unsaved text base",
    });

    await invalidateAgentData(queryClient, "a");

    const isInvalidated = (key: readonly unknown[]) =>
        queryClient.getQueryState(key)?.isInvalidated;

    // Listings and git state of the changed agent must be marked stale for refetching.
    expect(isInvalidated(listingKey)).toBe(true);
    expect(isInvalidated(gitKey)).toBe(true);
    // A refresh must not replace text the user may be editing.
    expect(isInvalidated(contentOptions.queryKey)).toBe(false);
    // Another agent's data has nothing to do with this change.
    expect(isInvalidated(otherAgentKey)).toBe(false);
    // The inventory list is a sibling of the agent subtrees, not their parent.
    expect(isInvalidated(queryKeys.agents())).toBe(false);

    await invalidateAllAgentData(queryClient);

    // Unattributed changes reach every agent's mirrors but still spare editor buffers.
    expect(isInvalidated(otherAgentKey)).toBe(true);
    expect(isInvalidated(contentOptions.queryKey)).toBe(false);
});

test("every agent-scoped key lives under the agent's prefix", () => {
    const search = {
        query: "q",
        timeoutSeconds: 5,
        includeHidden: false,
        respectGitignore: true,
        caseSensitivity: "smart",
    } as const;

    const keys = [
        queryKeys.agentDetails("a"),
        queryKeys.agentConfiguration("a"),
        queryKeys.agentLoggingLevel("a"),
        queryKeys.accounts("a"),
        queryKeys.trash("a"),
        queryKeys.browserListing("a", "/p"),
        queryKeys.metadata("a", "/p"),
        queryKeys.fileContent("a", "/p"),
        queryKeys.gitContext("a", "/p"),
        queryKeys.gitStatus("a", "/p"),
        queryKeys.gitDirectoryEntries("a", "/p"),
        queryKeys.gitDiff("a", ["/p"], "full"),
        queryKeys.fileSearch("a", "/p", { ...search, directoriesOnly: false }),
        queryKeys.contentGrep("a", "/p", {
            ...search,
            regex: false,
            contextSize: 2,
        }),
    ];

    const prefix = queryKeys.agent("a");

    for (const key of keys) {
        // One prefix must be enough to refresh or drop everything cached for an agent.
        expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    }
});

test("refetching an unchanged inventory keeps agent identities stable", async () => {
    const queryClient = new QueryClient();
    const api = new ApiClient("http://localhost");
    const options = agentsQueryOptions(api);
    const inventory = [agentInfo("a"), agentInfo("b")];
    queryClient.setQueryData(options.queryKey, inventory);
    const before = queryClient.getQueryData(options.queryKey) ?? [];
    const clientA = api.agentFor(before[0] ?? agentInfo("missing"));

    await queryClient.fetchQuery({
        ...options,
        staleTime: 0,
        // A fresh equal copy is what an unchanged server response looks like after parsing.
        queryFn: () => [agentInfo("a"), agentInfo("b")],
    });

    const unchanged = queryClient.getQueryData(options.queryKey) ?? [];

    // Structural sharing is what keeps memos and effects keyed on an agent from rerunning.
    expect(unchanged).toBe(before);
    expect(api.agentFor(unchanged[0] ?? agentInfo("missing"))).toBe(clientA);

    await queryClient.fetchQuery({
        ...options,
        staleTime: 0,
        queryFn: () => [agentInfo("a"), agentInfo("b", { status: "stopped" })],
    });

    const changed = queryClient.getQueryData(options.queryKey) ?? [];

    // Agents whose data did not change must keep their identity when a sibling changes.
    expect(changed[0]).toBe(before[0]);
    expect(api.agentFor(changed[0] ?? agentInfo("missing"))).toBe(clientA);
    // The changed agent gets a new snapshot, and therefore a new request client.
    expect(changed[1]).not.toBe(before[1]);
});

test("only a replaced or ended connection counts as a connection change", () => {
    const previous = [
        agentInfo("same"),
        agentInfo("reconnected"),
        agentInfo("dropped"),
        agentInfo("chatty"),
    ];

    const next = [
        agentInfo("same"),
        agentInfo("reconnected", { connection_id: "new-socket" }),
        agentInfo("dropped", { status: "disconnected" }),
        agentInfo("chatty", { connection_issue: "still trying" }),
        agentInfo("added"),
    ];

    // Lifecycle chatter and brand-new agents hold no stale cached data to refresh.
    expect(agentsWithReplacedConnection(previous, next)).toEqual([
        "reconnected",
        "dropped",
    ]);
});

/** Builds a loader context whose inventory request answers with `serverInventory`. */
function deviceContext(
    cached: AgentInfoResponse[] | null,
    serverInventory: AgentInfoResponse[],
) {
    const queryClient = new QueryClient();
    const api = new ApiClient("http://localhost");

    const listAgentInfos = vi
        .spyOn(api, "listAgentInfos")
        .mockResolvedValue(serverInventory);

    if (cached !== null) {
        queryClient.setQueryData(agentsQueryOptions(api).queryKey, cached);
    }

    return { context: { api, queryClient }, listAgentInfos };
}

test("a device URL resolves its name to the device id", async () => {
    const { context } = deviceContext(
        [agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "pi" })],
        [],
    );

    const agent = await loadAgentByName(context, "pi");

    // Everything after the URL acts on the id, so the name must map to the right device.
    expect(agent.id).toBe("dev_aaaaaaaaaaaaaaaaaaaa");
});

test("an exact id in a device URL wins over a name", async () => {
    const { context } = deviceContext(
        [
            agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "pi" }),
            agentInfo("dev_bbbbbbbbbbbbbbbbbbbb", {
                name: "dev_aaaaaaaaaaaaaaaaaaaa",
            }),
        ],
        [],
    );

    const agent = await loadAgentByName(context, "dev_aaaaaaaaaaaaaaaaaaaa");

    // The REST API resolves an exact id first, and links built from an id must agree.
    expect(agent.name).toBe("pi");
});

test("a name missing from the cached inventory is looked up on the server", async () => {
    const { context, listAgentInfos } = deviceContext(
        [agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "old" })],
        [agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "renamed" })],
    );

    const agent = await loadAgentByName(context, "renamed");

    // A rename or add in another tab must not be reported as "device not found".
    expect(listAgentInfos).toHaveBeenCalledTimes(1);
    expect(agent.id).toBe("dev_aaaaaaaaaaaaaaaaaaaa");
});

test("an unknown device name is reported as not found", async () => {
    const { context } = deviceContext(
        [agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "pi" })],
        [agentInfo("dev_aaaaaaaaaaaaaaaaaaaa", { name: "pi" })],
    );

    const error = await loadAgentByName(context, "unknown").catch(
        (cause: unknown) => cause,
    );

    // The device route renders its "device not found" page for this outcome, not an error.
    expect(isNotFound(error)).toBe(true);
});
