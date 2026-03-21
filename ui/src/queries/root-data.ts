import { queryOptions } from "@tanstack/react-query";

import { ApiClient } from "../api-client";

export type RootQueryData = {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transferProgress: Awaited<ReturnType<ApiClient["getTransferProgress"]>>;
};

export async function fetchRootQueryData(
    api: ApiClient,
): Promise<RootQueryData> {
    const [agents, transferProgress] = await Promise.all([
        api.listAgents(),
        api.getTransferProgress(),
    ]);

    return {
        agents,
        transferProgress,
    };
}

export function rootDataQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: ["root-data"],
        queryFn: async () => fetchRootQueryData(api),
    });
}
