import { getRouteApi } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import {
    invalidateAllAgentData,
    queryKeys,
    serverInfoQueryOptions,
} from "#ui/queries";
import {
    fetchForRestartProbe,
    waitForRestart,
} from "#ui/utils/wait-for-restart";

const rootRouteApi = getRouteApi("__root__");

/**
 * Lets the restart and update dialogs wait for the replacement server process.
 *
 * The old server keeps answering while it shuts down, and the new one can be back within
 * milliseconds under the same PID, too fast to be seen down in between. So the replacement
 * is recognised by its boot id, which differs from the one cached before the restart. Only
 * when nothing is cached does the wait fall back to having seen the server go away.
 *
 * Call the returned function before sending the restart request and await the wait it
 * returns afterwards: the event socket may reconnect to the new server and refresh the
 * cached boot id before a slow restart response arrives.
 */
export function useBeginServerRestart(): () => () => Promise<void> {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();

    return () => {
        const options = serverInfoQueryOptions(api);

        const previousBootId = queryClient.getQueryData(
            options.queryKey,
        )?.boot_id;

        let oldServerClosed = false;

        return () =>
            waitForRestart(async () => {
                let info;

                try {
                    info = await fetchForRestartProbe(queryClient, options);
                } catch (error) {
                    oldServerClosed = true;
                    throw error;
                }

                const replaced =
                    previousBootId === undefined
                        ? oldServerClosed
                        : info.boot_id !== previousBootId;

                if (!replaced) {
                    throw new Error("Old server is still shutting down");
                }

                // A new server process may report different agents and files. Not awaited: the
                // server is back, and a slow refetch must not keep the dialog spinning.
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.agents(),
                    exact: true,
                });
                void invalidateAllAgentData(queryClient);
            }, "Server did not come back after restart");
    };
}
