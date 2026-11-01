import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import type { Agent } from "#ui/api-client";
import { agentsQueryOptions, invalidateAgentData } from "#ui/queries";
import {
    fetchForRestartProbe,
    waitForRestart,
} from "#ui/utils/wait-for-restart";

const rootRouteApi = getRouteApi("__root__");

/**
 * Lets a restart button wait for the agent to come back. A restarted agent shows up as the
 * same id on a new connection, so the wait fetches the inventory fresh until that appears,
 * then refreshes the agent's cached data. Upgrades are tracked by the server instead (see
 * `AgentUpgradeStatus`), because they outlive the page that started them.
 */
export function useAgentReconnect(agent: Agent) {
    const queryClient = useQueryClient();
    const { api } = rootRouteApi.useRouteContext();

    /** Waits for the same agent to reconnect after it re-executed itself. */
    const waitForAgentRestart = React.useCallback(
        () =>
            waitForRestart(async () => {
                const infos = await fetchForRestartProbe(
                    queryClient,
                    agentsQueryOptions(api),
                );

                const replacement = infos.find(
                    (info) =>
                        info.id === agent.id &&
                        info.status === "connected" &&
                        info.connection_id !== agent.connectionId,
                );

                if (!replacement) {
                    throw new Error("Agent is still restarting");
                }

                // Not awaited: the agent is back, and a slow refetch must not keep the
                // dialog spinning.
                void invalidateAgentData(queryClient, agent.id);
            }, "Agent did not come back after restart"),
        [agent.connectionId, agent.id, api, queryClient],
    );

    return { waitForAgentRestart };
}
