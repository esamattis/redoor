import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { Agent, ApiClient } from "#ui/api-client";
import type { GitDiffMode } from "#bindings/GitDiffMode";

/** Centralizes cache keys so loaders, components, and mutations share server state. */
export const queryKeys = {
    all: ["server-state"] as const,
    agents: () => [...queryKeys.all, "agents"] as const,
    transfers: () => [...queryKeys.all, "transfers"] as const,
    serverInfo: () => [...queryKeys.all, "server-info"] as const,
    userState: () => [...queryKeys.all, "user-state"] as const,
    /**
     * Editor bytes are a one-shot buffer, not agent inventory. Nesting under
     * `agents()` would let RefreshListener prefix-match and mark the file stale.
     */
    fileContent: (agentId: string, path: string) =>
        [...queryKeys.all, "file-content", agentId, path] as const,
    browserListing: (agentId: string, path: string) =>
        [...queryKeys.all, "agents", agentId, "browser-listing", path] as const,
    git: () => [...queryKeys.all, "git"] as const,
    gitContext: (agentId: string, path: string) =>
        [...queryKeys.git(), agentId, "context", path] as const,
    gitStatus: (agentId: string, path: string) =>
        [...queryKeys.git(), agentId, "status", path] as const,
    gitDiff: (agentId: string, files: string[], mode: GitDiffMode) =>
        [...queryKeys.git(), agentId, "diff", files, mode] as const,
    trash: (agentId: string) =>
        [...queryKeys.all, "agents", agentId, "trash"] as const,
    fileSearch: (
        agentId: string,
        path: string,
        search: {
            query: string;
            timeoutSeconds: number;
            includeHidden: boolean;
            respectGitignore: boolean;
        },
    ) =>
        [
            ...queryKeys.all,
            "agents",
            agentId,
            "file-search",
            path,
            search.query,
            search.timeoutSeconds,
            search.includeHidden,
            search.respectGitignore,
        ] as const,
};

/** Shares the retained agent inventory between navigation and status refreshes. */
export function agentsQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.agents(),
        queryFn: () => api.listAgents(),
    });
}

/** Shares transfer state between the application shell and interactive polling. */
export function transfersQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.transfers(),
        queryFn: () => api.getTransferProgress(),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares server identity with route loaders and restart readiness checks. */
export function serverInfoQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.serverInfo(),
        queryFn: () => api.getServerInfo(),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/**
 * Reads editable text once so the loader and textarea share a cached buffer.
 * Infinite staleTime keeps later fetchQuery/preload/invalidation off the wire.
 * The editor opts into window-focus refetch while clean; Save writes the cache.
 */
export function fileContentQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.fileContent(agent.id, path),
        queryFn: async () => {
            const response = await agent.download(path);
            return response.text();
        },
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares one canonical browser listing so background actions can refresh its mounted view. */
export function browserListingQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.browserListing(agent.id, path),
        queryFn: () => agent.ls(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares repository discovery between the loader and conditional browser tabs. */
export function gitContextQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.gitContext(agent.id, path),
        queryFn: () => agent.gitContext(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares one bounded directory status result with route preloading. */
export function gitStatusQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.gitStatus(agent.id, path),
        queryFn: () => agent.gitStatus(path),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Keeps ordered full and staged file comparisons in distinct cache entries. */
export function gitDiffQueryOptions(
    agent: Agent,
    files: string[],
    mode: GitDiffMode,
) {
    return queryOptions({
        queryKey: queryKeys.gitDiff(agent.id, files, mode),
        queryFn: () => agent.gitDiff(files, mode),
        staleTime: Number.POSITIVE_INFINITY,
    });
}

/** Shares fresh trash inventory between route navigation and restore mutations. */
export function trashQueryOptions(agent: Agent) {
    return queryOptions({
        queryKey: queryKeys.trash(agent.id),
        queryFn: () => agent.listTrash(),
    });
}

/** Cancels obsolete recursive searches while retaining results during a new request. */
export function fileSearchQueryOptions(
    agent: Agent,
    path: string,
    search: {
        query: string;
        timeoutSeconds: number;
        includeHidden: boolean;
        respectGitignore: boolean;
    },
) {
    return queryOptions({
        queryKey: queryKeys.fileSearch(agent.id, path, search),
        queryFn: ({ signal }) =>
            agent.searchFiles(path, search.query, {
                timeoutSeconds: search.timeoutSeconds,
                includeHidden: search.includeHidden,
                respectGitignore: search.respectGitignore,
                signal,
            }),
        enabled: search.query.trim() !== "",
        placeholderData: keepPreviousData,
    });
}
