import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { Agent, ApiClient } from "#ui/api-client";

/** Centralizes cache keys so loaders, components, and mutations share server state. */
export const queryKeys = {
    all: ["server-state"] as const,
    agents: () => [...queryKeys.all, "agents"] as const,
    transfers: () => [...queryKeys.all, "transfers"] as const,
    serverInfo: () => [...queryKeys.all, "server-info"] as const,
    fileContent: (agentId: string, path: string) =>
        [...queryKeys.all, "agents", agentId, "file-content", path] as const,
    fileSearch: (agentId: string, path: string, query: string) =>
        [
            ...queryKeys.all,
            "agents",
            agentId,
            "file-search",
            path,
            query,
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

/** Reads editable text once so navigation can finish with the editor data ready. */
export function fileContentQueryOptions(agent: Agent, path: string) {
    return queryOptions({
        queryKey: queryKeys.fileContent(agent.id, path),
        queryFn: async () => {
            const response = await agent.download(path);
            return response.text();
        },
    });
}

/** Cancels obsolete recursive searches while retaining results during a new request. */
export function fileSearchQueryOptions(
    agent: Agent,
    path: string,
    query: string,
) {
    return queryOptions({
        queryKey: queryKeys.fileSearch(agent.id, path, query),
        queryFn: ({ signal }) => agent.searchFiles(path, query, signal),
        enabled: query.trim() !== "",
        placeholderData: keepPreviousData,
    });
}
